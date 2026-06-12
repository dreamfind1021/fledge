"""dashboard payload 組裝（design §10/§12）。KPI 視窗以本地時區界定，內部仍 epoch UTC。"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from fledge_sidecar.paths import resolve_best_effort
from fledge_sidecar.usage.blocks import build_blocks
from fledge_sidecar.usage.parser import UsageEntry

# 專案路徑正規化 memo（symlink resolve 走 syscall，聚合每輪重用）
_canon_cache: dict[str, str] = {}


def _total_tokens(e: UsageEntry) -> int:
    return (e.input_tokens + e.output_tokens + e.cache_read_tokens
            + e.cache_create_5m + e.cache_create_1h)


def _dedup(entries: list[UsageEntry]) -> list[UsageEntry]:
    """claude 同 key 替換規則（design §6）：parent（非 sidechain）勝 sidechain；同類取 token 多者。"""
    keyed: dict[str, UsageEntry] = {}
    out: list[UsageEntry] = []
    for e in entries:
        if e.source != "claude" or not e.dedup_key:
            out.append(e)
            continue
        cur = keyed.get(e.dedup_key)
        if cur is None:
            keyed[e.dedup_key] = e
        elif (cur.sidechain and not e.sidechain) or (
                cur.sidechain == e.sidechain and _total_tokens(e) > _total_tokens(cur)):
            keyed[e.dedup_key] = e
    out.extend(keyed.values())
    return out


def build_dashboard(entries: list[UsageEntry], codex_rate_limits: dict | None,
                    subscriptions: list[dict], now: float, days: int = 30) -> dict:
    entries = _dedup(entries)
    local_now = datetime.fromtimestamp(now).astimezone()
    today_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    week_start = (local_now - timedelta(days=local_now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0).timestamp()
    month_start = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()

    # 900s bucket memo：datetime.fromtimestamp/strftime 在 200k 條時佔 66% CPU；
    # 真實 tz offset 皆 15 分鐘倍數，900s bucket 語義等價
    local_parts_cache: dict[int, tuple[str, int, int]] = {}

    def _local_parts(ts: float) -> tuple[str, int, int]:
        """(date_str, weekday, hour)；以 900s bucket memoize——tz offset 皆 15min 倍數，語義等價。"""
        bucket = int(ts // 900)
        hit = local_parts_cache.get(bucket)
        if hit is None:
            local = datetime.fromtimestamp(bucket * 900).astimezone()
            hit = (local.strftime("%Y-%m-%d"), local.weekday(), local.hour)
            local_parts_cache[bucket] = hit
        return hit

    month = week = today = 0.0
    claude_hit_num = claude_hit_den = codex_hit_num = codex_hit_den = 0
    daily: dict[str, dict] = defaultdict(lambda: {"by_model": defaultdict(float), "total": 0.0})
    models: dict[tuple[str, str], dict] = defaultdict(
        lambda: {"input": 0, "output": 0, "cache_read": 0, "cache_create": 0, "cost": 0.0})
    projects: dict[str, dict] = defaultdict(
        lambda: {"claude_cost": 0.0, "codex_cost": 0.0, "last_active": 0.0})
    hourly = [[0.0] * 24 for _ in range(7)]   # [weekday][hour] = cost
    missing: set[str] = set()
    horizon = now - days * 86400

    for e in entries:
        # synthetic 不是 API 呼叫（0 成本但帶 token 數＝表格噪音）；
        # missing_pricing 警示本就排除它，面板聚合也一併跳過
        if e.model == "<synthetic>":
            continue
        if e.ts >= month_start:
            month += e.cost
        if e.ts >= week_start:
            week += e.cost
        if e.ts >= today_start:
            today += e.cost
        # 警示語義＝「有 token 被算成 0 元」：synthetic 是排除計價非查無定價；
        # 零 token 條目（如無模型的空 session 快照）沒有低估可言，掛警示只是噪音
        if e.missing_pricing and e.model != "<synthetic>" and _total_tokens(e) > 0:
            missing.add(e.model)
        if e.ts < horizon:
            # horizon cut 後才累加 cache 命中率——與 daily/models 同視窗；
            # 全史命中率會漸近凍結、與月視窗 KPI 並列誤導（design §12 / NF-1）
            continue
        # cache 命中率分源分母（design §12 / NF-1）
        if e.source == "claude":
            claude_hit_num += e.cache_read_tokens
            claude_hit_den += e.input_tokens + e.cache_read_tokens + e.cache_create_5m + e.cache_create_1h
        else:
            codex_hit_num += e.cache_read_tokens
            codex_hit_den += e.input_tokens
        date_str, weekday, hour = _local_parts(e.ts)
        day = daily[date_str]
        day["by_model"][e.model] += e.cost
        day["total"] += e.cost
        m = models[(e.model, e.source)]
        m["input"] += e.input_tokens
        m["output"] += e.output_tokens
        m["cache_read"] += e.cache_read_tokens
        m["cache_create"] += e.cache_create_5m + e.cache_create_1h
        m["cost"] += e.cost
        if e.project:
            # 與側欄專案清單對齊（design §5.3）：路徑 memoized 正規化（resolve symlink）。
            # 在聚合端做而非 parser 端——條目存原始事實、政策在讀取端，免 syscall 風暴
            key = _canon_cache.get(e.project)
            if key is None:
                key = resolve_best_effort(e.project)
                _canon_cache[e.project] = key
            p = projects[key]
            p["claude_cost" if e.source == "claude" else "codex_cost"] += e.cost
            p["last_active"] = max(p["last_active"], e.ts)
        hourly[weekday][hour] += e.cost

    subs_total = 0.0
    for s in subscriptions:
        try:
            subs_total += float(s.get("monthly_cost") or 0)
        except (TypeError, ValueError, AttributeError):
            continue   # 壞項目跳過——route 驗證擋正路，這裡擋手改 config
    hit_den = claude_hit_den + codex_hit_den
    # 全量建 block、後濾時間窗（ccusage 語義）——先切 7 天會截斷跨界 block（起點重 floor、
    # tokens 偏低）並以截斷值污染 P90 樣本；P90 用全史 closed blocks 估更穩
    blocks = build_blocks([e for e in entries if e.source == "claude"], now=now)
    recent_blocks = [b for b in blocks.blocks if b.end_ts >= now - 7 * 86400]
    active = next((b for b in recent_blocks if b.is_active), None)

    def _block_dict(b):
        return {"start_ts": b.start_ts, "end_ts": b.end_ts, "is_gap": b.is_gap,
                "is_active": b.is_active, "total_tokens": b.total_tokens, "cost": b.cost,
                "burn_rate_tpm": b.burn_rate_tpm, "projection": b.projection}

    return {
        "kpi": {"month_value": month, "week_value": week, "today_value": today,
                "cache_hit_rate": (claude_hit_num + codex_hit_num) / hit_den if hit_den else 0.0,
                "net_roi": month - subs_total, "subscriptions_total": subs_total},
        "blocks": {
            "claude": {"active": _block_dict(active) if active else None,
                       "recent": [_block_dict(b) for b in recent_blocks],
                       "limit_p90": blocks.limit_p90},
            "codex": codex_rate_limits or {},
        },
        "daily": [{"date": d, "by_model": dict(v["by_model"]), "total": v["total"]}
                  for d, v in sorted(daily.items())],
        "models": [{"model": k[0], "source": k[1], **v}
                   for k, v in sorted(models.items(), key=lambda kv: -kv[1]["cost"])],
        "projects": [{"path": p, "claude_cost": v["claude_cost"], "codex_cost": v["codex_cost"],
                      "total": v["claude_cost"] + v["codex_cost"], "last_active": v["last_active"]}
                     for p, v in sorted(projects.items(),
                                        key=lambda kv: -(kv[1]["claude_cost"] + kv[1]["codex_cost"]))],
        "hourly": hourly,
        "scan_meta": {"missing_pricing": sorted(missing)},   # route 層補 state/generation 等
    }

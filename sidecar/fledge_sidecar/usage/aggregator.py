"""dashboard payload 組裝（design §10/§12）。KPI 視窗以本地時區界定，內部仍 epoch UTC。"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from fledge_sidecar.paths import resolve_best_effort
from fledge_sidecar.usage import pricing
from fledge_sidecar.usage.codex_account_store import (
    WINDOW_TOLERANCE_SEC, day_label, day_noon, day_number, day_of,
)
from fledge_sidecar.usage.parser import UsageEntry

# 專案路徑正規化 memo（symlink resolve 走 syscall，聚合每輪重用）
_canon_cache: dict[str, str] = {}


def _total_tokens(e: UsageEntry) -> int:
    return (e.input_tokens + e.output_tokens + e.cache_read_tokens
            + e.cache_create_5m + e.cache_create_1h)


def _project_root(path: str, roots: list[str]) -> str:
    """把 cwd 收斂到「側欄層級專案」＝設定 root 下第一層子目錄（與 project_scanner.scan_root 同義）。
    worktree（.claude/worktrees/x）、子目錄（sidecar、node_modules/...）、深層 topics 全部歸該專案根，
    避免一個專案被切成多列（實機回饋：專案分支用量被另計）。
    不在任何 root 下 → 原樣返回（best-effort；如拋棄式 /tmp sidecar、root 外的專案）。"""
    best = ""
    for r in roots:
        # 取最長（最深）的命中 root，支援巢狀 root
        if (path == r or path.startswith(r + "/")) and len(r) > len(best):
            best = r
    if not best:
        return path
    rest = path[len(best):].lstrip("/")
    if not rest:
        return best  # cwd 正好是 root 本身
    return best + "/" + rest.split("/", 1)[0]


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


def build_dashboard(entries: list[UsageEntry], subscriptions: list[dict], now: float,
                    days: int = 30, roots: list[str] | None = None) -> dict:
    entries = _dedup(entries)
    # 專案根收斂用：roots canonicalize 一次（與 e.project 同款 resolve，前綴比對才對得上）。
    # 收斂結果依 roots 而定、roots 可在 runtime 變動，故 proj_root memo 用 call-local（見下方迴圈）
    canon_roots = [resolve_best_effort(r) for r in (roots or [])]
    proj_root_cache: dict[str, str] = {}
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
            canon = _canon_cache.get(e.project)
            if canon is None:
                canon = resolve_best_effort(e.project)
                _canon_cache[e.project] = canon
            # 再收斂到側欄層級專案根（worktree/子目錄歸母專案）；call-local memo（依 roots）
            key = proj_root_cache.get(canon)
            if key is None:
                key = _project_root(canon, canon_roots)
                proj_root_cache[canon] = key
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
    # 分源命中率：某源該視窗無輸入（den=0）回 None，讓前端顯示「—」而非誤導的 0%
    claude_hit_rate = claude_hit_num / claude_hit_den if claude_hit_den else None
    codex_hit_rate = codex_hit_num / codex_hit_den if codex_hit_den else None

    return {
        "kpi": {"month_value": month, "week_value": week, "today_value": today,
                "claude_cache_hit_rate": claude_hit_rate, "codex_cache_hit_rate": codex_hit_rate,
                "net_roi": month - subs_total, "subscriptions_total": subs_total},
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


# 未歸屬比例取最近 7 個完整日；最新的完整日比今天早超過 8 天 → 背景停太久，不給比例（spec 5.3-2）
UNATTRIBUTED_SHARE_DAYS = 7
UNATTRIBUTED_MAX_AGE_DAYS = 8
# 上一輪最長 32 天：更長的不是真的窗口（上游回了離譜的長度），也避免對幾萬年的日期逐日迴圈（合併前審查）
UNATTRIBUTED_MAX_WINDOW_SEC = 32 * 86400


def _codex_tokens_by_day(entries: list[UsageEntry]) -> dict[int, int]:
    """本機 codex 用量按天加總。codex 的 input_tokens 已含 cached（parser 照 rollout 原值存），
    帳號的每日 tokens 也是輸入＋輸出。"""
    out: dict[int, int] = defaultdict(int)
    for e in entries:
        if e.source == "codex":
            out[day_of(e.ts)] += e.input_tokens + e.output_tokens
    return out


def _unattributed(accounts: dict[str, dict[str, int]], local: dict[int, int], days: set[int]) -> tuple[int, int]:
    """期間內的（差額, 帳號加總）。**先整段加總、最後才相減一次**：逐日歸零會把跨午夜錯位的負差丟掉、正差留下，
    每天累積高估。某帳號缺某天＝0。"""
    account_tokens = sum(t for acc in accounts.values() for d, t in acc.items() if day_number(d) in days)
    return max(0, account_tokens - sum(local.get(d, 0) for d in days)), account_tokens


def _token_rate(entries: list[UsageEntry], model: str | None) -> float | None:
    """估價單價＝本機**全部**該模型紀錄的 sum(cost)/sum(輸入＋輸出)；沒有紀錄或都查無定價 → None。"""
    cost = tokens = 0
    for e in entries:
        if e.source == "codex" and e.model == model and not e.missing_pricing:
            cost += e.cost
            tokens += e.input_tokens + e.output_tokens
    return cost / tokens if tokens else None


def _previous_window(accounts: dict[str, dict[str, int]], windows: dict[str, list[dict]], complete: set[int],
                     local: dict[int, int], now: float, rate: float | None) -> dict | None:
    """上一輪的實數（spec 5.3-4）。窗口紀錄取最後一筆 start 最晚的那個帳號：按 start 排序後最後一筆是這一輪、
    前一筆是上一輪。這一輪已過 resets_at（紀錄落後）、兩輪中間有空檔（可能漏看了幾輪）、對應的日子有任何一天
    不是完整日 → None。一天歸給它中午 12 點所在的那一輪；提早重置時上一輪在這一輪的 start 結束。"""
    ws = max(windows.values(), key=lambda w: w[-1]["start"] if w else float("-inf"), default=[])
    if len(ws) < 2:
        return None
    prev, cur = ws[-2], ws[-1]
    if now >= cur["resets_at"] or prev["resets_at"] < cur["start"] - WINDOW_TOLERANCE_SEC:
        return None
    end = min(prev["resets_at"], cur["start"])
    if end - prev["start"] > UNATTRIBUTED_MAX_WINDOW_SEC:
        return None
    days = [d for d in range(day_of(prev["start"]), day_of(end) + 1) if prev["start"] <= day_noon(d) < end]
    if not days or any(d not in complete for d in days):
        return None
    tokens, account_tokens = _unattributed(accounts, local, set(days))
    return {
        "start_date": day_label(days[0]), "end_date": day_label(days[-1]), "days": len(days),
        "tokens": tokens, "account_tokens": account_tokens,
        "share": tokens / account_tokens if account_tokens else None,
        "cost": tokens * rate if rate is not None else None,
        # 算這個上一輪時的「這一輪」：提早重置後背景紀錄最多晚 3 小時，前端拿它核對即時額度是不是同一輪
        "current_resets_at": cur["resets_at"],
    }


def build_codex_unattributed(entries: list[UsageEntry], accounts: dict[str, dict[str, int]],
                             final: dict[str, list[str]], windows: dict[str, list[dict]], *,
                             now: float, price_model: str | None) -> dict | None:
    """Codex「未歸屬用量」（spec 5.3）：未歸屬比例＋上一輪的實數。只保證單一帳號正確。

    完整日＝已定稿的日期（同一次回應裡已經有更晚的日期；最新那天出現後還會變）。比例：最新的完整日往回數最多
    7 天，遇到不是完整日的就停；最新的完整日比今天早超過 8 天、或期間帳號加總是 0 → None（前端整行不出現）。
    本輪估計＝這一輪已用百分比 × 比例，由前端用畫額度那條的同一個數字算（兩條一定同時歸零），後端不讀即時額度。"""
    complete = {day_number(d) for days in final.values() for d in days}
    if not complete:
        return None
    last = max(complete)
    if last < day_of(now) - UNATTRIBUTED_MAX_AGE_DAYS:
        return None
    first = last
    while first - 1 in complete and last - first + 1 < UNATTRIBUTED_SHARE_DAYS:
        first -= 1
    local = _codex_tokens_by_day(entries)
    tokens, account_tokens = _unattributed(accounts, local, set(range(first, last + 1)))
    if not account_tokens:
        return None
    model = pricing.normalize_codex_model(price_model) if price_model else None
    return {
        "share": tokens / account_tokens,
        "share_start": day_label(first), "share_end": day_label(last), "share_days": last - first + 1,
        "price_model": model,
        "previous": _previous_window(accounts, windows, complete, local, now, _token_rate(entries, model)),
    }

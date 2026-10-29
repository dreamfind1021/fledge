"""三格式逐行解析 → 瘦條目（design §5；Pi 見 Pi spec §7）。

容錯契約（對下游 cache/_parse_one 的承諾）：**內容層不拋例外**——壞行/壞值跳過並計數；
I/O 例外（檔案在 stat 後消失等 race）由呼叫端 wrap 處理。"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from fledge_sidecar.usage import pricing


def _to_int(value) -> int:
    """金流入口的安全轉型：非數值/None/非有限 一律 0——單行壞資料不得炸掉整檔解析。
    JSON 的 `1e309` 經 json.loads 是 inf，int(inf) 是 OverflowError（nan 是 ValueError）；不攔的話 cache._parse_one
    只接 OSError、整輪掃描會掛掉（Codex plan B R1 high）。三個 parser 共用。"""
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _to_float(value) -> float:
    """Pi 的 cost.total 是 Pi 自己算好的浮點數（信任 Pi，Pi spec §5.3）；壞值、非有限一律 0。
    超大的 JSON 整數（401 位）經 json.loads 是 int、float(int) 拋 OverflowError（Codex plan R2 high），跟 inf 一樣歸 0。"""
    try:
        x = float(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return x if math.isfinite(x) else 0.0


@dataclass(frozen=True)
class UsageEntry:
    ts: float                 # epoch 秒（UTC）
    source: str               # 'claude' | 'codex' | 'pi'
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int    # codex: cached_input_tokens
    cache_create_5m: int      # codex: 0
    cache_create_1h: int      # codex: 0
    cost: float
    project: str              # cwd
    session_id: str
    dedup_key: str            # claude: "msgid:reqid"；codex: ""（canonical selection 已保唯一）；pi: "pi:{id}:{timestamp}"
    sidechain: bool           # claude isSidechain；去重替換規則用（design §6）
    missing_pricing: bool
    # pi：所在檔案 header 的 timestamp（epoch 秒）——fork 逐條複製後同鍵的多份取最早的那份（Pi spec §5.5）；
    # claude／codex 填 0。有預設值：舊 L2 沒這個欄位也載得起來（SCHEMA_VERSION 升版後反正重建）
    origin_ts: float = 0.0


@dataclass(frozen=True)
class CodexFileResult:
    entries: list[UsageEntry]
    skipped: int
    session_id: str


def _parse_ts(raw: str) -> float | None:
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def parse_claude_file(path: Path) -> tuple[list[UsageEntry], int]:
    entries: list[UsageEntry] = []
    skipped = 0
    with open(path, "rb") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            # 快篩：肯定無 usage 的有效 JSON 行跳過（純效能；僅對以 { 開頭的行套用）
            # 非 JSON 行（如純文字壞行）仍要走 parse 以便計入 skipped
            if stripped.startswith(b"{") and b'"usage"' not in line:
                continue
            try:
                data = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                skipped += 1
                continue
            msg = data.get("message")
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            ts = _parse_ts(data.get("timestamp", ""))
            if ts is None:
                skipped += 1
                continue
            raw_model = msg.get("model")
            if not isinstance(raw_model, str) or not raw_model:  # model 非字串不得進 regex
                raw_model = "unknown"
            norm = pricing.normalize_claude_model(raw_model)
            in_tok = _to_int(usage.get("input_tokens"))
            out_tok = _to_int(usage.get("output_tokens"))
            cread = _to_int(usage.get("cache_read_input_tokens"))
            # cache precedence（design §7）：nested 優先；僅 aggregate → 全視為 5m
            nested = usage.get("cache_creation")
            if isinstance(nested, dict):
                c5m = _to_int(nested.get("ephemeral_5m_input_tokens"))
                c1h = _to_int(nested.get("ephemeral_1h_input_tokens"))
            else:
                c5m = _to_int(usage.get("cache_creation_input_tokens"))
                c1h = 0
            if norm is None:  # <synthetic> 不計價
                cost, missing = 0.0, True
                model = raw_model
            else:
                cost, missing = pricing.claude_cost(norm, in_tok, out_tok, c5m, c1h, cread)
                model = norm
            entries.append(UsageEntry(
                ts=ts, source="claude", model=model,
                input_tokens=in_tok, output_tokens=out_tok, cache_read_tokens=cread,
                cache_create_5m=c5m, cache_create_1h=c1h, cost=cost,
                project=str(data.get("cwd") or ""), session_id=str(data.get("sessionId") or ""),
                dedup_key=(f"{msg.get('id') or ''}:{data.get('requestId') or ''}"
                           if (msg.get("id") or data.get("requestId")) else ""),
                sidechain=bool(data.get("isSidechain")), missing_pricing=missing,
            ))
    return entries, skipped


def parse_codex_file(path: Path) -> CodexFileResult:
    entries: list[UsageEntry] = []
    skipped = 0
    session_id = str(path.resolve())   # 缺 session_meta 的 fallback（design §5.2）
    cwd = ""
    model_raw: str | None = None
    prev_total: dict | None = None
    with open(path, "rb") as f:
        for line in f:
            try:
                data = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                skipped += 1
                continue
            t = data.get("type")
            payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
            if t == "session_meta":
                session_id = str(payload.get("id") or session_id)
                cwd = str(payload.get("cwd") or cwd)
            elif t == "turn_context":
                m = payload.get("model")
                if isinstance(m, str) and m:    # 非字串 model 不得進 regex
                    model_raw = m
                cwd = str(payload.get("cwd") or cwd)
            elif t == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                last = info.get("last_token_usage")
                total = info.get("total_token_usage")
                if not isinstance(last, dict):
                    # 僅累計 → 與前次差分恢復增量（ccusage 規格）
                    if isinstance(total, dict) and isinstance(prev_total, dict):
                        # clamp 防缺鍵/倒退產生負 token 污染聚合（金流入口，與 pricing 的 max(0,…) 同一道防線）
                        last = {k: max(0, _to_int(total.get(k)) - _to_int(prev_total.get(k)))
                                for k in ("input_tokens", "cached_input_tokens", "output_tokens")}
                    elif isinstance(total, dict):
                        last = total
                    else:
                        continue
                if isinstance(total, dict):
                    prev_total = total
                ts = _parse_ts(data.get("timestamp", ""))
                if ts is None:        # 與 claude 路徑同語義：壞 ts 跳過並計數（不得回 epoch-0）
                    skipped += 1
                    continue
                in_tok = _to_int(last.get("input_tokens"))
                cached = _to_int(last.get("cached_input_tokens"))
                out_tok = _to_int(last.get("output_tokens"))
                if model_raw is None:
                    model, cost, missing = "unknown-codex", 0.0, True
                else:
                    model = pricing.normalize_codex_model(model_raw)
                    cost, missing = pricing.codex_cost(model, in_tok, cached, out_tok)
                entries.append(UsageEntry(
                    ts=ts, source="codex", model=model,
                    input_tokens=in_tok, output_tokens=out_tok, cache_read_tokens=cached,
                    cache_create_5m=0, cache_create_1h=0, cost=cost,
                    project=cwd, session_id=session_id, dedup_key="",
                    sidechain=False, missing_pricing=missing,
                ))
    return CodexFileResult(entries=entries, skipped=skipped, session_id=session_id)


# Pi session 檔計費條目的模型：provider/model 都有才算有；沒有時摘要條目歸 pi/summary（不推定模型，Pi spec §7），
# 其他歸 pi/unknown
_PI_SUMMARY_TYPES = ("compaction", "branch_summary")


def parse_pi_file(path: Path) -> tuple[list[UsageEntry], int]:
    """Pi session 檔（Pi spec §7）：第一行 header 取 cwd／id／timestamp（→ 全檔 origin_ts，§5.5）；
    只計四類計費條目（assistant 訊息的 message.usage；compaction／branch_summary／usage 的頂層 usage），
    與 Pi 自己的 /usage 同一套（§5.10）；cost 直接取 usage.cost.total（§5.3）；壞行計 skipped 不拋。
    header 只認第一行（Pi 的格式）：缺或不在第一行時 project 空、origin_ts 0、session_id 退回 realpath，其餘照常；
    後面出現的 session 行當普通行略過、不改寫歸屬。"""
    entries: list[UsageEntry] = []
    skipped = 0
    cwd = ""
    session_id = str(path.resolve())
    origin_ts = 0.0
    n = 0   # 已處理的非空行數（第一行才是 header）
    with open(path, "rb") as f:
        for line in f:
            if not line.strip():
                continue
            n += 1
            try:
                data = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                skipped += 1
                continue
            if not isinstance(data, dict):
                skipped += 1
                continue
            t = data.get("type")
            if t == "session":
                if n == 1:
                    cwd = str(data.get("cwd") or "")
                    session_id = str(data.get("id") or session_id)
                    origin_ts = _parse_ts(str(data.get("timestamp") or "")) or 0.0
                continue
            if t == "message":
                msg = data.get("message")
                if not isinstance(msg, dict) or msg.get("role") != "assistant":
                    continue
                usage, provider, model = msg.get("usage"), msg.get("provider"), msg.get("model")
            elif t == "usage" or t in _PI_SUMMARY_TYPES:
                usage, provider, model = data.get("usage"), data.get("provider"), data.get("model")
            else:
                continue   # user／toolResult／system／model_change／thinking_level_change／custom／context_edit…
            if not isinstance(usage, dict):
                continue
            ts = _parse_ts(str(data.get("timestamp") or ""))
            if ts is None:
                skipped += 1
                continue
            if isinstance(provider, str) and provider and isinstance(model, str) and model:
                model_name = f"{provider}/{model}"
            else:
                model_name = "pi/summary" if t in _PI_SUMMARY_TYPES else "pi/unknown"
            cost_obj = usage.get("cost")
            cost = _to_float(cost_obj.get("total")) if isinstance(cost_obj, dict) else 0.0
            eid, ets = data.get("id"), data.get("timestamp")
            entries.append(UsageEntry(
                ts=ts, source="pi", model=model_name,
                input_tokens=_to_int(usage.get("input")), output_tokens=_to_int(usage.get("output")),
                cache_read_tokens=_to_int(usage.get("cacheRead")), cache_create_5m=_to_int(usage.get("cacheWrite")),
                cache_create_1h=0, cost=cost, project=cwd, session_id=session_id,
                dedup_key=f"pi:{eid}:{ets}" if eid and ets else "",
                sidechain=False, missing_pricing=False, origin_ts=origin_ts,
            ))
    return entries, skipped

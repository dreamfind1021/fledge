"""帳號活動 log（設計 account-activity-attribution §3.3）：記錄哪個帳號的 session 在哪個專案
從何時活到何時，補足 jsonl 缺的帳號身分。append-only JSONL、fail-open、sidecar 唯一寫者。"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from fledge_sidecar.app_config import default_config_path
from fledge_sidecar.paths import resolve_best_effort

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_process_start_ts = 0.0   # startup 設定；read-time 孤兒回收用


def _log_path() -> Path:
    override = os.environ.get("FLEDGE_ACCOUNT_ACTIVITY")
    if override:
        return Path(override)
    return default_config_path().parent / "account-activity.jsonl"


def mark_process_start(now: float) -> None:
    global _process_start_ts
    _process_start_ts = now


def _append(event: dict) -> None:
    """append 一行 JSONL；fail-open——任何 IO/序列化錯只 warn、絕不拋（不得讓 session 建立失敗）。"""
    try:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(event, ensure_ascii=False) + "\n"
        with _lock:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.fchmod(fd, 0o600)   # 既存檔也確保 0600（含絕對路徑、僅 owner 可讀）
                os.write(fd, line.encode("utf-8"))
            finally:
                os.close(fd)
    except Exception:  # noqa: BLE001 — fail-open：log 寫入絕不阻斷 session 建立
        logger.warning("account-activity 寫入失敗（已略過）", exc_info=True)


def record_open(project: str, account: str, session: str, now: float) -> None:
    _append({"ts": now, "event": "open",
             "project": resolve_best_effort(project), "account": account, "session": session})


def record_close(session: str, now: float) -> None:
    _append({"ts": now, "event": "close", "session": session})


@dataclass
class SessionSpan:
    project: str             # realpath
    account: str
    open_ts: float
    close_ts: float | None   # None = 仍 live


def load_sessions(now: float, live_session_ids: set[str], retention_days: int = 30) -> list[SessionSpan]:
    """讀事件、pair open/close；liveness 以 bridge 存活集合為權威 + read-time 孤兒回收（§3.3）。"""
    try:
        text = _log_path().read_text(encoding="utf-8")
    except OSError:
        return []
    opens: dict[str, dict] = {}
    closes: dict[str, float] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue   # 殘缺尾行 / 壞行跳過（no-raise 契約）
        sid = ev.get("session")
        if not sid:
            continue
        if ev.get("event") == "open":
            opens[sid] = ev
        elif ev.get("event") == "close":
            closes[sid] = float(ev.get("ts") or now)
    cutoff = now - retention_days * 86400
    spans: list[SessionSpan] = []
    for sid, ev in opens.items():
        open_ts = float(ev.get("ts") or 0.0)
        if sid in closes:
            close_ts: float | None = closes[sid]
        elif sid in live_session_ids:
            close_ts = None                       # 真 live（在 bridge 存活集合）
        elif open_ts < _process_start_ts:
            close_ts = _process_start_ts          # 前一進程殘留 → 關於 process_start
        else:
            close_ts = now                        # 本進程但已不在 bridge（close 遺失）→ best-effort now
        if close_ts is not None and close_ts < cutoff:
            continue                              # 過舊
        spans.append(SessionSpan(
            project=str(ev.get("project") or ""), account=str(ev.get("account") or ""),
            open_ts=open_ts, close_ts=close_ts))
    return spans

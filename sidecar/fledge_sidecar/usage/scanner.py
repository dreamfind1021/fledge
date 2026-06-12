"""兩源檔案發現（design §4/§5.2）。

claude：各帳號 config_dir/projects 遞迴 *.jsonl，realpath 去重（symlink 帳號別名）。
codex：sessions/ + archived_sessions/ 的 rollout-*.jsonl，per-session canonical selection——
優先序 active sessions/ > mtime_ns 新 > size 大（條目數 proxy）。session_id 以首行
session_meta 窺視；無法取得則以 realpath 自成一組。
"""
from __future__ import annotations

import json
from pathlib import Path

from fledge_sidecar.app_config import AppConfig


def claude_files(config: AppConfig) -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []
    for acct in config.accounts.values():
        projects = Path(acct.get("config_dir", "")).expanduser() / "projects"
        if not projects.is_dir():
            continue
        for f in projects.rglob("*.jsonl"):
            try:
                rp = str(f.resolve())
            except OSError:
                continue
            if rp not in seen:
                seen.add(rp)
                out.append(Path(rp))
    return sorted(out)


def _peek_session_id(path: Path) -> str:
    """只讀首行找 session_meta.payload.id；失敗回 realpath（design §5.2 fallback）。"""
    try:
        with open(path, "rb") as f:
            first = f.readline(65536)
        data = json.loads(first)
        if data.get("type") == "session_meta":
            sid = (data.get("payload") or {}).get("id")
            if sid:
                return str(sid)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError, AttributeError):
        pass
    return str(path.resolve())


def codex_files(codex_home: Path) -> list[Path]:
    candidates: list[tuple[str, bool, int, int, Path]] = []
    for sub, is_active in (("sessions", True), ("archived_sessions", False)):
        root = codex_home / sub
        if not root.is_dir():
            continue
        for f in root.rglob("rollout-*.jsonl"):
            try:
                st = f.stat()
            except OSError:
                continue
            candidates.append((_peek_session_id(f), is_active, st.st_mtime_ns, st.st_size, f))
    best: dict[str, tuple[bool, int, int, Path]] = {}
    for sid, is_active, mtime_ns, size, f in candidates:
        key = (is_active, mtime_ns, size, f)
        if sid not in best or key[:3] > best[sid][:3]:
            best[sid] = key
    return sorted(v[3] for v in best.values())

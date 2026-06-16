"""兩源檔案發現（design §4/§5.2）。

claude：各帳號 config_dir/projects 遞迴 *.jsonl，realpath 去重（symlink 帳號別名）。
codex：sessions/ + archived_sessions/ 的 rollout-*.jsonl，per-session canonical selection——
優先序 active sessions/ > mtime_ns 新 > size 大（條目數 proxy）> 路徑字串（決定性 tie-break）。
session_id 以首行 session_meta 窺視；無法取得則以 realpath 自成一組。

**路徑契約**：兩源回傳值一律為 resolve 後的 realpath（Task 6 cache 以此為 key）。
"""
from __future__ import annotations

import json
from pathlib import Path

from fledge_sidecar.app_config import AppConfig

# 真實 session_meta 首行（含 instructions）實測中位數 ~22KB，64KB 只剩 3× 餘裕——
# 截斷會讓 canonical selection 失效造成跨檔雙算（金額正確性），放大到 1MiB
_PEEK_LIMIT = 1_048_576


def _scan_claude(config: AppConfig) -> tuple[list[Path], dict[str, str]]:
    """掃 claude 檔案 + realpath→account_key 對應。tie-break：按 account_key 排序遍歷，
    第一個命中該 realpath 的帳號勝（deterministic、不依 dict 迭代順序，設計 §3.4）。"""
    owner: dict[str, str] = {}   # realpath → account_key（先到先得；遍歷序＝key 排序）
    for key in sorted(config.accounts):
        projects = Path(config.accounts[key].get("config_dir", "")).expanduser() / "projects"
        if not projects.is_dir():
            continue
        for f in projects.rglob("*.jsonl"):
            if not f.is_file():   # rglob 也會匹配 *.jsonl 結尾的目錄
                continue
            try:
                rp = str(f.resolve())
            except OSError:
                continue
            owner.setdefault(rp, key)   # 第一個（account_key 最小）勝
    files = sorted(Path(rp) for rp in owner)
    return files, dict(owner)


def claude_files(config: AppConfig) -> list[Path]:
    return _scan_claude(config)[0]


def claude_account_map(config: AppConfig) -> dict[str, str]:
    return _scan_claude(config)[1]


def _peek_session_id(path: Path) -> str:
    """只讀首行找 session_meta.payload.id；失敗回 realpath（design §5.2 fallback）。"""
    try:
        with open(path, "rb") as f:
            first = f.readline(_PEEK_LIMIT)
        data = json.loads(first)
        if data.get("type") == "session_meta":
            sid = (data.get("payload") or {}).get("id")
            if sid:
                return str(sid)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError, AttributeError):
        pass
    return str(path.resolve())


def codex_files(codex_home: Path) -> list[Path]:
    candidates: list[tuple[str, tuple[bool, int, int, str], Path]] = []
    for sub, is_active in (("sessions", True), ("archived_sessions", False)):
        root = codex_home / sub
        if not root.is_dir():
            continue
        for f in root.rglob("rollout-*.jsonl"):
            if not f.is_file():
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            # 第 4 元素 str(f) 讓完全平手時仍有全序——canonical 選擇跨輪穩定，不抖 L2
            candidates.append((_peek_session_id(f),
                               (is_active, st.st_mtime_ns, st.st_size, str(f)), f))
    best: dict[str, tuple[tuple[bool, int, int, str], Path]] = {}
    for sid, key, f in candidates:
        if sid not in best or key > best[sid][0]:
            best[sid] = (key, f)
    out: list[Path] = []
    for _, f in best.values():
        try:
            out.append(Path(str(f.resolve())))   # 統一 realpath 契約（同 claude 源）
        except OSError:
            continue
    return sorted(out)

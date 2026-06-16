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
    """掃 claude 檔案 + realpath→account_key 對應（設計 §3.4）。

    同一 realpath 被多帳號命中時（兩帳號的 projects/ 經 symlink 共用同一份對話歷史，
    例：~/.claude-tc/projects symlink → ~/.claude/projects，為了切帳號 resume），歸屬規則：
    **偏好「正規擁有者」**——projects/ 不是經 symlink 重導向到別處的帳號（真實目錄帳號）勝過
    經 symlink alias 抵達的帳號；同層級（皆 canonical 或皆 alias）按 account_key 排序取第一
    （deterministic、不依 dict 迭代順序）。修正「symlink alias 帳號因字母序贏過真實目錄帳號」
    的錯誤歸屬（真機驗收：工作用量被標成私人）。

    canonical 判定在 **config_dir/projects 目錄層**做（非個別檔案層）：比較 `<anchor>/projects`
    與 `projects.resolve()`，其中 anchor = config_dir 的 parent resolve 後再接 config_dir 名字。
    先 resolve parent 是為了吸收祖先 symlink（如 macOS /var→/private/var、symlinked HOME），
    避免真實目錄帳號被祖先 symlink 誤判成 alias；保留 config_dir 自己的名字（不 resolve）是為了
    讓「config_dir 本身就是 symlink」的帳號仍正確判為 alias。"""
    best: dict[str, tuple[bool, str]] = {}   # realpath → (是否正規擁有, account_key)
    for key in sorted(config.accounts):       # 升序遍歷 → 同層級下先到（account_key 最小）勝
        base = Path(config.accounts[key].get("config_dir", "")).expanduser()
        projects = base / "projects"
        if not projects.is_dir():
            continue
        # 此帳號是否「正規擁有」其 projects/（沒被 symlink 重導向到別的真實目錄）
        try:
            anchor = base.parent.resolve() / base.name
            canonical = (anchor / "projects") == projects.resolve()
        except OSError:
            canonical = False
        for f in projects.rglob("*.jsonl"):
            if not f.is_file():   # rglob 也會匹配 *.jsonl 結尾的目錄
                continue
            try:
                rp = str(f.resolve())
            except OSError:
                continue
            cur = best.get(rp)
            # 只在「本帳號正規擁有、現任非正規」時覆寫；其餘保留先到者（account_key 較小）
            if cur is None or (canonical and not cur[0]):
                best[rp] = (canonical, key)
    files = sorted(Path(rp) for rp in best)
    account_map = {rp: ck for rp, (_, ck) in best.items()}
    return files, account_map


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

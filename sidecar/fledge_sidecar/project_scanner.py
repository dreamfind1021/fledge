"""專案掃描：根目錄 depth=1 掃描 + Claude Code 用過記錄合併。spec §5。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fledge_sidecar.app_config import AppConfig


def encode_cc_project_dir(abs_path: str) -> str:
    """Claude Code 把專案絕對路徑編碼成 ~/.claude/projects/ 下的目錄名：
    所有非英數字元（/、_、.、空白、CJK 等）一律換成 -（與 Claude Code 一致；
    已對使用者 19 個真實專案 round-trip 驗證，spec §2.2）。此編碼有損、碰撞可接受。"""
    return re.sub(r"[^a-zA-Z0-9]", "-", abs_path)


def scan_root(root: Path, account: str) -> list[dict[str, Any]]:
    """掃描單一根目錄的直接子資料夾（depth=1），排除隱藏資料夾。"""
    if not root.exists():
        return []
    projects: list[dict[str, Any]] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        if child.name.startswith("."):
            continue
        projects.append(
            {
                "name": child.name,
                "path": str(child.resolve()),
                "account": account,
                "source": "root",
                "root": str(root.resolve()),
                "recent": None,
            }
        )
    return projects


def _recent_mtime(config_dir: Path, project_path: str) -> float | None:
    """從 ~/.claude*/projects/<encoded>/ 最新 jsonl 的 mtime 推算最近使用時間。"""
    encoded = encode_cc_project_dir(project_path)
    cc_dir = config_dir.expanduser() / "projects" / encoded
    if not cc_dir.exists():
        return None
    jsonls = list(cc_dir.glob("*.jsonl"))
    if not jsonls:
        return None
    return max(f.stat().st_mtime for f in jsonls)


def scan_all(config: AppConfig) -> tuple[list[dict[str, Any]], bool]:
    """合併三來源（spec §5.1）。回 (projects, permission_error)：
    任一 root/recent 讀取撞 PermissionError（macOS TCC）→ 跳過該項、permission_error=True。"""
    by_path: dict[str, dict[str, Any]] = {}
    permission_error = False

    # 優先級 1：根目錄掃描（逐 root best-effort）
    for root in config.roots:
        try:
            for proj in scan_root(Path(root["path"]).expanduser(), root["default_account"]):
                by_path[proj["path"]] = proj
        except PermissionError:
            permission_error = True

    # 優先級 1.5：套用 project_overrides（永久改帳號；spec §7）——在 recent 之前
    for proj in by_path.values():
        override = config.project_overrides.get(proj["path"])
        if override:
            proj["account"] = override["account"]

    # 優先級 2：補 recent 標籤——跨帳號 union：取所有帳號 config_dir 的最新 mtime（spec §2.3）。
    # recent 語意＝專案層「任一帳號最近使用」（account-agnostic），解「實際用過但歸錯帳號被埋沒」。
    config_dirs = [
        a["config_dir"] for a in config.accounts.values() if a.get("config_dir")
    ]
    for proj in by_path.values():
        best: float | None = None
        for cd in config_dirs:
            try:
                mt = _recent_mtime(Path(cd), proj["path"])
            except PermissionError:
                permission_error = True  # 任一 config_dir 撞 TCC → 標記、續算其餘
                continue
            if mt is not None and (best is None or mt > best):
                best = mt
        proj["recent"] = best

    # 優先級 3：手動加入（獨立分組；也套 override，否則對 manual 設預設帳號會無效）
    manual: list[dict[str, Any]] = []
    for m in config.manual_projects:
        p = str(Path(m["path"]).expanduser())
        if p in by_path:
            continue  # 已在 root 掃出，不重複列（避免重複 row / React key 衝突；Codex review）
        override = config.project_overrides.get(p)
        manual.append(
            {
                "name": Path(p).name,
                "path": p,
                "account": override["account"] if override else m["account"],
                "source": "manual",
                "root": None,
                "recent": None,
            }
        )

    return list(by_path.values()) + manual, permission_error

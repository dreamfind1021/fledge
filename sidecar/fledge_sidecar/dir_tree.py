"""列一層目錄內容（lazy 檔案樹用）。內容層 no-raise，與 usage/memory parser 同契約：
壞項（broken symlink / 權限）跳過、不 raise；iterdir 的 I/O 例外由呼叫端 wrap。"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def list_dir_entries(dir_path: Path) -> list[dict[str, Any]]:
    """列 dir_path 直接子項（不遞迴）：排除 dotfiles、資料夾在前 + 名稱 casefold 升冪。"""
    entries: list[dict[str, Any]] = []
    for child in dir_path.iterdir():
        name = child.name
        if name.startswith("."):  # 隱藏檔（與 scan_root 一致）
            continue
        try:
            is_dir = child.is_dir()
        except OSError:
            continue  # 壞 symlink / 權限：跳過該項，不影響其餘
        entries.append({"name": name, "path": str(child), "is_dir": is_dir})
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].casefold()))
    return entries

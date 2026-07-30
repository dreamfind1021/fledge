"""備份腳本與其周邊資源的位置。

路徑解析沿用 `setup/templates.py` 的 `templates_root()` 三段式：env 覆蓋（測試用）
＞ 凍結資料目錄（PyInstaller onedir）＞ repo 內的實體目錄。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def scripts_root() -> str:
    """備份腳本與共用來源清單檔所在的目錄。

    兩者必須同目錄——`containment.load_extra_paths()` 由此取檔，打包後
    （`_MEIPASS/scripts/`）也維持同樣的相鄰關係，「單一權威」在打包版才仍然成立。"""
    override = os.environ.get("FLEDGE_BACKUP_SCRIPTS_DIR")
    if override:
        return override
    if getattr(sys, "frozen", False):
        return str(Path(getattr(sys, "_MEIPASS")) / "scripts")
    # dev：repo 的 scripts/（本檔在 sidecar/fledge_sidecar/backup/ 之下）
    return str(Path(__file__).resolve().parents[3] / "scripts")

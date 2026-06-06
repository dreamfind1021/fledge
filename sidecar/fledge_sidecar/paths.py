"""路徑正規化與 robust 目錄探測。寫入邊界與 scanner 一致用 resolve()。
設計見 docs/planning/path-normalization-design.md。"""
from __future__ import annotations

import os
import stat as stat_module
from pathlib import Path
from typing import Literal

DirStatus = Literal["dir", "missing", "not_dir", "denied"]


def expand_and_validate(raw: str) -> str:
    """trim → expanduser → 拒空/相對。回絕對的字面路徑（不解析 symlink/FS）。
    空字串或非絕對路徑 raise ValueError（路由層轉 400）。"""
    if not raw or not raw.strip():
        raise ValueError("路徑不可為空")
    p = Path(raw.strip()).expanduser()
    if not p.is_absolute():
        raise ValueError("路徑必須是絕對路徑")
    return str(p)


def resolve_best_effort(raw: str) -> str:
    """resolve(strict=False) 跟隨 symlink；任何 OSError fallback 回輸入。永不 raise
    （輸入應已過 expand_and_validate）。"""
    try:
        return str(Path(raw).resolve())
    except OSError:
        return raw


def canonicalize(raw: str) -> str:
    """= resolve_best_effort(expand_and_validate(raw))。給「要 canonical 但不驗存在」的
    寫入用（remove/clear/set_override/set_root_account）；ValueError 由路由轉 400。"""
    return resolve_best_effort(expand_and_validate(raw))


def probe_dir(raw: str) -> DirStatus:
    """robust 目錄探測：os.stat（刻意不用 Path.is_dir——它吞 PermissionError 回 False、
    無法區分 missing/denied，KL2 根因）。跟隨 symlink → broken symlink 的 target 不存在
    → FileNotFoundError → missing。"""
    try:
        st = os.stat(Path(raw).expanduser())
    except FileNotFoundError:
        return "missing"
    except PermissionError:
        return "denied"
    except OSError:
        return "missing"  # 其餘 OSError（如中段 ENOTDIR）視為 missing
    return "dir" if stat_module.S_ISDIR(st.st_mode) else "not_dir"

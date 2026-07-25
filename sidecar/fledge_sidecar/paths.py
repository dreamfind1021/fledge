"""路徑正規化、robust 目錄探測與目錄同一性判定。寫入邊界與 scanner 一致用 resolve()。
設計見 docs/planning/path-normalization-design.md。

同一性判定（`dir_identity`／`same_dir`／`is_same_or_within`）以 (st_dev, st_ino) 比對：
會刪改檔案的 containment 防呆不能只靠字串，macOS 的 APFS 預設不分大小寫。"""
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


def is_within_root(realpath: str, root: str) -> bool:
    """realpath 是否等於 root 或在其下。以 `root + os.sep` 比對避免 prefix 偽命中
    （/a/bc 不算落在 /a/b）。呼叫端須先各自 resolve（realpath）。"""
    norm_root = root.rstrip(os.sep)
    return realpath == norm_root or realpath.startswith(norm_root + os.sep)


def is_within_any_root(realpath: str, roots: list[str]) -> bool:
    return any(is_within_root(realpath, r) for r in roots)


def dir_identity(path: str) -> tuple[int, int] | None:
    """目錄的真實身分 (st_dev, st_ino)；不存在或讀不到回 None。

    字串比對不足以判斷「是不是同一個目錄」：macOS 的 APFS 預設不分大小寫，
    `~/.claude` 與 `~/.CLAUDE` 是同一個目錄，但 `Path.resolve()` 不做大小寫正規化，
    兩者 resolve 完仍是不同字串。"""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_dev, st.st_ino)


def same_dir(a: str, b: str) -> bool:
    """兩個路徑是否指向同一個目錄。字串相等涵蓋尚不存在的目錄，inode 身分涵蓋
    大小寫別名等字串看不出來的同一目錄。"""
    if a == b:
        return True
    identity = dir_identity(a)
    return identity is not None and identity == dir_identity(b)


def is_same_or_within(inner: str, outer: str) -> bool:
    """inner 是否等於 outer 或落在其下。先字串比對（涵蓋尚不存在的目錄），
    不中再以 inode 身分逐層上溯——大小寫別名的巢狀關係字串同樣看不出來。"""
    if is_within_root(inner, outer):
        return True
    outer_id = dir_identity(outer)
    if outer_id is None:
        return False
    current = inner
    while True:
        if dir_identity(current) == outer_id:
            return True
        parent = os.path.dirname(current)
        if parent == current:      # 上溯到根仍未命中
            return False
        current = parent

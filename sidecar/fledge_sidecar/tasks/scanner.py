"""掃 `.fledge/tasks/`、算總覽，並提供**所有端點共用的路徑邊界 resolver**（design §7.1）。

沒有那道檢查，一個過期或錯誤的路徑就能改寫或刪除專案外的檔案。既有的
`routes/memory.py:89-109` 與 `/api/projects/tree` 都有對等機制。

T1 只做唯讀側：resolver ＋ 未完成條數。`tasks_status` 三態、重複編號、`state.md` 的
「下一步」留待 T2；`POST` 需要的 `mkdir` 與建檔留待 T3（**仍寫在本檔，不新增模組**）。
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.paths import canonicalize, same_dir
from fledge_sidecar.project_scanner import scan_all
from fledge_sidecar.tasks.parser import effective_status

FLEDGE_DIRNAME = ".fledge"
TASKS_DIRNAME = "tasks"

# tasks_status 三態（design §6.3）。**不可壓成一個數字**——把「讀不到」顯示成「沒有」，
# 正是這個功能存在的理由的反面。
STATUS_OK = "ok"
STATUS_ABSENT = "absent"          # `.fledge/tasks/` 不存在 → 0 條，不是錯誤
STATUS_UNAVAILABLE = "unavailable"  # 存在但讀不到（權限、I/O、O_NOFOLLOW 擋下）
# P1 不過：`project` 未知或不合法。**不是 tasks_status 的值**，路由層一律轉 error code。
STATUS_UNKNOWN_PROJECT = "unknown_project"


@dataclass(frozen=True)
class TasksDir:
    """resolver 的結果。`fd` 只在 status == ok 時有值，且生命週期綁在 with 區塊內。"""

    fd: int | None
    status: str
    project: str  # 已知專案的 canonical 路徑；unknown_project 時為空字串


def _open_dir(name: str | int, dir_fd: int | None = None) -> int:
    """開一層目錄。`O_DIRECTORY` 擋非目錄、`O_NOFOLLOW` 擋 symlink（design §7.1 步驟 2）。"""
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def _match_known_project(project: str, projects: list[dict[str, Any]]) -> str | None:
    """P1 ＋ P2（design §7.1）：`project` 必須是 `scan_all` 的已知專案之一。

    同一性用 `paths.same_dir`（字串比對不中就退到 `(st_dev, st_ino)`）——macOS 的 APFS
    預設不分大小寫，`resolve()` 之後字串相等仍判不出是不是同一個目錄。"""
    try:
        wanted = canonicalize(project)
    except ValueError:
        return None
    for entry in projects:
        known = entry.get("path")
        if known and same_dir(wanted, known):
            return known
    return None


@contextmanager
def open_tasks_dir(
    project: str, config: AppConfig, *, projects: list[dict[str, Any]] | None = None
) -> Iterator[TasksDir]:
    """`project -> tasks_dir_fd` 的**唯一入口**（design §7.1）。

    所有端點都必須經過它，沒有任何端點自己組路徑。逐層開啟、不用字串拼路徑。
    `projects` 可傳入已掃好的清單，避免總覽逐專案重跑 `scan_all`。

    失敗分三種、不可壓成一條泛化規則（design §7.1 末）：P1 不過 → `unknown_project`
    （路由轉 error code）；目錄不存在 → `absent`；讀不到 → `unavailable`。
    """
    known = _match_known_project(project, projects if projects is not None else scan_all(config)[0])
    if known is None:
        yield TasksDir(None, STATUS_UNKNOWN_PROJECT, "")
        return

    proj_fd = fledge_fd = tasks_fd = None
    try:
        try:
            proj_fd = _open_dir(known)
            fledge_fd = _open_dir(FLEDGE_DIRNAME, dir_fd=proj_fd)
            tasks_fd = _open_dir(TASKS_DIRNAME, dir_fd=fledge_fd)
        except FileNotFoundError:
            yield TasksDir(None, STATUS_ABSENT, known)
            return
        except OSError:
            # 權限、I/O、ENOTDIR（該層是一般檔案）、ELOOP（該層是 symlink，被 O_NOFOLLOW 擋下）
            yield TasksDir(None, STATUS_UNAVAILABLE, known)
            return
        yield TasksDir(tasks_fd, STATUS_OK, known)
    finally:
        for fd in (tasks_fd, fledge_fd, proj_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def list_task_files(tasks_fd: int) -> list[str]:
    """列出 tasks 目錄下的 `.md` 一般檔。目錄、FIFO、symlink 一律不算票（design §7.1 T2/T3）。"""
    try:
        with os.scandir(tasks_fd) as it:
            return sorted(
                e.name for e in it if e.name.endswith(".md") and e.is_file(follow_symlinks=False)
            )
    except OSError:
        return []  # 契約 2：掃不動就當這個專案沒票，不讓整個總覽失敗


def read_task_text(tasks_fd: int, name: str) -> str | None:
    """在已 pin 的 `tasks_dir_fd` 上讀一張票。任何 OSError → None（契約 1、2）。

    `errors="replace"` 讓無效 UTF-8 也解得出字串——parser 的契約是永不拋例外。"""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=tasks_fd)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "rb") as fh:
            return fh.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def count_unfinished(tasks_fd: int) -> int:
    """未完成條數 ＝ effective status 為 `todo` 或 `doing` 的票數（design §5.1）。

    讀不到內容的票依 §6.1 的規則——`status` 本身判不出來 → fallback `todo` → 計入未完成。
    票不會因為讀不懂就從計數裡消失（契約 3）。"""
    total = 0
    for name in list_task_files(tasks_fd):
        text = read_task_text(tasks_fd, name)
        status = effective_status(text) if text is not None else "todo"
        if status in ("todo", "doing"):
            total += 1
    return total


def build_overview(config: AppConfig) -> dict[str, Any]:
    """第一層總覽（design §5.1）：`scan_all` 的**所有**已知專案各一列，沒有待辦的顯示 0。

    不隱藏 0 條的專案——隱藏了使用者就不知道那個專案可以開票。
    單一專案 resolver 失敗只影響那一列的 `tasks_status`，整體不報錯（design §7.1）。

    `unfinished` 在非 `ok` 時是 `None` 而不是 0：`unavailable` 與「真的沒有待辦」必須
    分得開（design §6.3），回 0 會讓前端無從分辨。
    """
    projects, permission_error = scan_all(config)
    rows: list[dict[str, Any]] = []
    for entry in projects:
        with open_tasks_dir(entry["path"], config, projects=projects) as td:
            if td.status == STATUS_OK and td.fd is not None:
                unfinished: int | None = count_unfinished(td.fd)
                status = STATUS_OK
            elif td.status == STATUS_ABSENT:
                unfinished, status = 0, STATUS_ABSENT
            else:
                # unknown_project 不會在這裡發生（清單就來自 scan_all），保守歸 unavailable
                unfinished, status = None, STATUS_UNAVAILABLE
        rows.append(
            {
                "path": entry["path"],
                "name": entry.get("name", ""),
                "account": entry.get("account", ""),
                "unfinished": unfinished,
                "tasks_status": status,
            }
        )
    return {"projects": rows, "permission_error": permission_error}

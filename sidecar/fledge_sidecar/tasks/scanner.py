"""掃 `.fledge/tasks/`、算總覽，並提供**所有端點共用的路徑邊界 resolver**（design §7.1）。

沒有那道檢查，一個過期或錯誤的路徑就能改寫或刪除專案外的檔案。既有的
`routes/memory.py:89-109` 與 `/api/projects/tree` 都有對等機制。

寫入側（`POST` 的 `mkdir` 與建檔）留待 T3，**仍寫在本檔、不新增模組**。
"""
from __future__ import annotations

import hashlib
import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.paths import canonicalize, same_dir
from fledge_sidecar.project_scanner import scan_all
from fledge_sidecar.tasks.parser import (
    ANOMALY_NUMBER_DUPLICATE, ANOMALY_UNREADABLE, Task,
    is_plain_name, make_short_name, parse_task, render_task,
)

FLEDGE_DIRNAME = ".fledge"
TASKS_DIRNAME = "tasks"
STATE_FILENAME = "state.md"
STATE_HEAD_LINES = 20  # 只讀前 20 行（design §5.1）

# tasks_status 三態（design §6.3）。**不可壓成一個數字**——把「讀不到」顯示成「沒有」，
# 正是這個功能存在的理由的反面。
STATUS_OK = "ok"
STATUS_ABSENT = "absent"            # `.fledge/tasks/` 不存在 → 0 條，不是錯誤
STATUS_UNAVAILABLE = "unavailable"  # 存在但讀不到（權限、I/O、O_NOFOLLOW 擋下）
# P1 不過：`project` 未知或不合法。**不是 tasks_status 的值**，路由層一律轉 error code。
STATUS_UNKNOWN_PROJECT = "unknown_project"

# `/resume-note` skill 寫死的格式合約（該 skill 不需要修改）。中英兩種標籤、全半形冒號都認。
_NEXT_STEP = re.compile(r"^\*\*(?:下一步|Next)\*\*[:：]\s*(.+)$")


@dataclass(frozen=True)
class TasksDir:
    """resolver 的結果。fd 的生命週期綁在 with 區塊內，離開就關閉。

    `fledge_fd` 在 `.fledge` 開得起來時就有值——即使 `tasks/` 不存在。理由：`state.md`
    住在 `.fledge/` 而不是 `tasks/`，而實測 22 個專案中唯一有 `state.md` 的那個
    （Meeting Agent）正好沒有 `tasks/`。綁在一起會讓它的「下一步」永遠是空的。"""

    fd: int | None          # tasks 目錄；只在 status == ok 時有值
    fledge_fd: int | None   # .fledge 目錄；開得起來就有值
    status: str
    project: str            # 已知專案的 canonical 路徑；unknown_project 時為空字串


def _open_dir(name: str | int, dir_fd: int | None = None) -> int:
    """開一層目錄。`O_DIRECTORY` 擋非目錄、`O_NOFOLLOW` 擋 symlink（design §7.1 步驟 2）。"""
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def _open_or_make(name: str, dir_fd: int, create: bool) -> int:
    """開一層目錄；`create` 時不存在就先 `mkdir`（design §7.1 步驟 3）。

    `mkdir` 撞到 `EEXIST` 不算失敗——交給下面的 open 決定，**symlink 仍會被
    `O_NOFOLLOW` 擋下**，所以「先建再開」不會變成繞過 symlink 檢查的路徑。"""
    try:
        return _open_dir(name, dir_fd=dir_fd)
    except FileNotFoundError:
        if not create:
            raise
        try:
            os.mkdir(name, dir_fd=dir_fd)
        except FileExistsError:
            pass
        return _open_dir(name, dir_fd=dir_fd)


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
    project: str, config: AppConfig, *, projects: list[dict[str, Any]] | None = None,
    create: bool = False,
) -> Iterator[TasksDir]:
    """`project -> tasks_dir_fd` 的**唯一入口**（design §7.1）。

    所有端點都必須經過它，沒有任何端點自己組路徑。逐層開啟、不用字串拼路徑。
    `projects` 可傳入已掃好的清單，避免總覽逐專案重跑 `scan_all`。

    失敗分三種、不可壓成一條泛化規則（design §7.1 末）：P1 不過 → `unknown_project`
    （路由轉 error code）；目錄不存在 → `absent`；讀不到 → `unavailable`。
    """
    known = _match_known_project(project, projects if projects is not None else scan_all(config)[0])
    if known is None:
        yield TasksDir(None, None, STATUS_UNKNOWN_PROJECT, "")
        return

    proj_fd = fledge_fd = tasks_fd = None
    status = STATUS_OK
    try:
        try:
            proj_fd = _open_dir(known)
            fledge_fd = _open_or_make(FLEDGE_DIRNAME, proj_fd, create)
            tasks_fd = _open_or_make(TASKS_DIRNAME, fledge_fd, create)
        except FileNotFoundError:
            status = STATUS_ABSENT
        except OSError:
            # 權限、I/O、ENOTDIR（該層是一般檔案）、ELOOP（該層是 symlink，被 O_NOFOLLOW 擋下）
            status = STATUS_UNAVAILABLE
        yield TasksDir(tasks_fd, fledge_fd, status, known)
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


def read_task_bytes(tasks_fd: int, name: str) -> bytes | None:
    """在已 pin 的 `tasks_dir_fd` 上讀一張票的**原始位元組**。任何 OSError → None。

    回位元組而不是字串：fingerprint 必須算在原始內容上，解碼過的字串會把無效 UTF-8
    換成替代字元，兩個不同的檔案可能算出同一個雜湊。"""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=tasks_fd)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def fingerprint(raw: bytes) -> str:
    """票檔內容的雜湊（design §7.2）。**best-effort stale detection，不是併發保證。**"""
    return hashlib.sha256(raw).hexdigest()


def _decode(raw: bytes) -> str:
    """`errors="replace"` 讓無效 UTF-8 也解得出字串——parser 的契約是永不拋例外。"""
    return raw.decode("utf-8", errors="replace")


def _unreadable_task(name: str) -> Task:
    """讀不到內容的票：仍然回一張票（契約 3 不隱藏），status 判不出來 → fallback todo。"""
    return Task(name=name, number=None, title=name, body="", status="todo",
                source="", created="", anomalies=(ANOMALY_UNREADABLE,))


def _row(task: Task, fp: str) -> dict[str, Any]:
    """一張票的 API 形狀。`scan_tasks` 與 `create_task` 共用，避免兩份必然漂移。"""
    return {
        "name": task.name, "number": task.number, "title": task.title,
        "status": task.status, "source": task.source, "created": task.created,
        "anomalies": list(task.anomalies), "fingerprint": fp,
    }


def scan_tasks(tasks_fd: int) -> list[dict[str, Any]]:
    """掃出一個專案的全部票，逐檔隔離（契約 2）。回 API 形狀的 dict。

    重複編號（design §2.4.2）不只來自併發——手動改檔名、複製一份票檔都會造成。
    **兩張票都顯示、都標異常**，提示使用者手動改名。"""
    rows: list[dict[str, Any]] = []
    for name in list_task_files(tasks_fd):
        raw = read_task_bytes(tasks_fd, name)
        if raw is None:
            task, fp = _unreadable_task(name), ""
        else:
            task, fp = parse_task(name, _decode(raw)), fingerprint(raw)
        rows.append(_row(task, fp))

    seen: dict[int, int] = {}
    for row in rows:
        if row["number"] is not None:
            seen[row["number"]] = seen.get(row["number"], 0) + 1
    for row in rows:
        if row["number"] is not None and seen[row["number"]] > 1:
            row["anomalies"].append(ANOMALY_NUMBER_DUPLICATE)
    return rows


def count_unfinished(tasks_fd: int) -> int:
    """未完成條數 ＝ effective status 為 `todo` 或 `doing` 的票數（design §5.1）。

    讀不到內容的票依 §6.1 的規則——`status` 本身判不出來 → fallback `todo` → 計入未完成。
    票不會因為讀不懂就從計數裡消失（契約 3）。"""
    return sum(1 for row in scan_tasks(tasks_fd) if row["status"] in ("todo", "doing"))


def read_next_step(fledge_fd: int | None) -> str:
    """從 `.fledge/state.md` 的前 20 行抽「下一步」（design §5.1）。讀不到一律回空字串。

    這是 `/resume-note` skill 已經寫死的格式合約，**該 skill 完全不需要修改**。"""
    if fledge_fd is None:
        return ""
    try:
        fd = os.open(STATE_FILENAME, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fledge_fd)
    except OSError:
        return ""
    try:
        with os.fdopen(fd, "rb") as fh:
            head = _decode(fh.read(64 * 1024))
    except OSError:
        return ""
    for line in head.splitlines()[:STATE_HEAD_LINES]:
        m = _NEXT_STEP.match(line.strip())
        if m:
            return m.group(1).strip()
    return ""


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
            elif td.status == STATUS_ABSENT:
                unfinished = 0
            else:
                unfinished = None
            rows.append({
                "path": entry["path"],
                "name": entry.get("name", ""),
                "account": entry.get("account", ""),
                "unfinished": unfinished,
                "tasks_status": td.status,
                "next_step": read_next_step(td.fledge_fd),
            })
    return {"projects": rows, "permission_error": permission_error}


def _create_file(name: str, tasks_fd: int) -> int:
    """建一個新檔。`O_EXCL` 保證不覆蓋既有檔案、`O_NOFOLLOW` 擋 symlink（design §7.1）。

    獨立成一個函式是為了讓測試能注入「選完號之後、open 之前才出現同名檔」的競態——
    預置同名檔測不到重試（那個檔案本身就成了最大號，下一次配號會直接跳過它）。"""
    return os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=tasks_fd)


def create_task(tasks_fd: int, title: str, *, created: str, max_attempts: int = 64) -> dict[str, Any]:
    """建一張新票（design §2.4、§7.1）。

    編號取當前資料夾內最大號 +1。**撞到 `EEXIST` 取下一個編號重試，不是直接失敗**——
    使用者手動複製或改名就會造成同號，這是單一寫入者也會遇到的正常情境。

    **併發建票與配號是未定義行為**（design §2.4.1）：本函式不偵測、不加固。
    `O_EXCL` 保護的是完整路徑，不是 `NN` 前綴——兩個寫入者同時建票且短名相同時，
    先寫的那份會被覆蓋，且 `.fledge/` 不進 git，不可回復。
    """
    rows = scan_tasks(tasks_fd)
    number = max((r["number"] for r in rows if r["number"] is not None), default=0) + 1
    short = make_short_name(title)
    raw = render_task(title, created=created).encode("utf-8")
    for _ in range(max_attempts):
        name = f"{number:02d}-{short}.md"
        # allowlist 與 T1 是兩道，不是二選一（design §7.1）
        if not is_plain_name(name):
            raise ValueError("generated name is not a plain filename")
        try:
            fd = _create_file(name, tasks_fd)
        except FileExistsError:
            number += 1
            continue
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        return _row(parse_task(name, raw.decode("utf-8")), fingerprint(raw))
    raise OSError("too many number collisions")

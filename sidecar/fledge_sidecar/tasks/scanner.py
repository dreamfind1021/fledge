"""掃 `.fledge/tasks/`、算總覽，並提供**所有端點共用的路徑邊界 resolver**（design §7.1）。

沒有那道檢查，一個過期或錯誤的路徑就能改寫或刪除專案外的檔案。既有的
`routes/memory.py:89-109` 與 `/api/projects/tree` 都有對等機制。

寫入側（`POST` 的 `mkdir` 與建檔）留待 T3，**仍寫在本檔、不新增模組**。
"""
from __future__ import annotations

import hashlib
import os
import re
import stat as stat_module
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterator

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.paths import canonicalize, same_dir
from fledge_sidecar.project_scanner import scan_all
from fledge_sidecar.tasks.parser import (
    ANOMALY_NUMBER_DUPLICATE, ANOMALY_UNREADABLE, Task,
    VALID_STATUS, can_round_trip, is_plain_name, make_short_name, parse_task,
    render_task, replace_body, replace_status,
)

FLEDGE_DIRNAME = ".fledge"
TASKS_DIRNAME = "tasks"
STATE_FILENAME = "state.md"
STATE_HEAD_LINES = 20  # 只讀前 20 行（design §5.1）
RECENT_DAYS = 7   # 「最近 N 天新增」的 N（spec §4.1）。前端用 payload 的 recent_days 插值，不另抄一份
NOTE_MAX_BYTES = 64 * 1024   # `GET /tasks/note` 全文上限（spec §4.4），與 _read_state_text 同值

# tasks_status 三態（design §6.3）。**不可壓成一個數字**——把「讀不到」顯示成「沒有」，
# 正是這個功能存在的理由的反面。
STATUS_OK = "ok"
STATUS_ABSENT = "absent"            # `.fledge/tasks/` 不存在 → 0 條，不是錯誤
STATUS_UNAVAILABLE = "unavailable"  # 存在但讀不到（權限、I/O、O_NOFOLLOW 擋下）
# P1 不過：`project` 未知或不合法。**不是 tasks_status 的值**，路由層一律轉 error code。
STATUS_UNKNOWN_PROJECT = "unknown_project"

# `/resume-note` skill 寫死的格式合約（該 skill 不需要修改）。中英兩種標籤、全半形冒號都認。
_NEXT_STEP = re.compile(r"^\*\*(?:下一步|Next)\*\*[:：]\s*(.+)$")
# `/handoff` skill 寫在 state.md 末尾的段落標題（票 21）。**這個標題從此是格式合約**：
# skill 那邊改了字，面板會靜默找不到、指令區塊消失。改之前兩邊要一起改。
_HANDOFF_HEADING = "## 貼進新對話的指令"
# 圍籬用**近似** CommonMark 的規則：開圍籬＝行首 ≥3 個反引號（可帶語言標記）；關圍籬＝**只含**
# 反引號的行，且數量 ≥ 開圍籬。兩輪 Codex 各打掉一個「以 ``` 開頭」的變體（R1 漏認 ```text、
# R2 內文行以 ``` 開頭被提早關閉）——與其再補條件，不如用標準規則。
# **已知不處理**：比對前 strip() 掉了縮排，內文裡縮排 ≥4 格的 ``` 會被當關圍籬、後面截掉
# （Codex R3）。使用者決定不修：這段的 producer 是 handoff skill、寫的永遠是裸圍籬＋三句中文，
# state.md 的標頭與指令段不會人手編輯；要改寫法會經過 skill。抓不到＝排除，可接受。
_FENCE_OPEN = re.compile(r"^(`{3,})")
_FENCE_CLOSE = re.compile(r"^(`{3,})\s*$")


class TaskWriteError(OSError):
    """寫票檔時的 I/O 失敗。**與「目標不合法」分開**——後者是使用者送錯東西（400），
    這個是磁碟／檔案系統出問題（500）。混在一起會讓真正的 I/O 故障被報成參數錯誤。"""


# 既有票的三個寫入函式（update_content／update_status／delete_task）用一把全域鎖序列化
# （spec §5.4、K9）。建票走 O_EXCL ＋ 編號碰撞重試，不經這把鎖。
#
# 為什麼是全域一把而不是 per-name：per-name 需要「票的身分」當鍵，而本 repo 記錄過 APFS 上
# realpath 字串比對判不出同一個目錄（大小寫別名），name 也一樣——鍵錯了就是兩把鎖，
# 序列化形同虛設；per-name 還需要 registry 的回收規則。這些複雜度換來的只是「不同票之間
# 不互等」，而互等的代價是毫秒：單人本機工具，寫入頻率是人手按按鈕。
#
# 用 `with` 不用手動 acquire：任何 return 或例外都由語法釋放，沒有「某條路徑忘了放」的問題。
_WRITE_LOCK = threading.Lock()


@dataclass(frozen=True)
class TasksDir:
    """resolver 的結果。fd 的生命週期綁在 with 區塊內，離開就關閉。

    `fledge_fd` 在 `.fledge` 開得起來時就有值——即使 `tasks/` 不存在。理由：`state.md`
    住在 `.fledge/` 而不是 `tasks/`，而實測 22 個專案中唯一有 `state.md` 的那個
    正好沒有 `tasks/`。綁在一起會讓它的「下一步」永遠是空的。"""

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
        # `O_NONBLOCK`：列目錄與這裡開檔之間有窗口，外部若把某個 `.md` 換成 FIFO，
        # 少了它就會**阻塞到有寫入端出現**——整個 `/tasks` 掃描掛在這一行，
        # 而契約 2 要求的是「隔離那一個檔案」不是「拖垮整個專案」。
        # （`_open_existing` 原本就防了這個，這裡漏掉；2026-08-31 Codex 審查抓到。）
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=tasks_fd)
    except OSError:
        return None
    try:
        if not stat_module.S_ISREG(os.fstat(fd).st_mode):
            return None                      # 目錄、FIFO、裝置檔一律不是票
        with os.fdopen(fd, "rb", closefd=False) as fh:
            return fh.read()
    except OSError:
        return None
    finally:
        os.close(fd)


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


def _row(task: Task, fp: str, raw: bytes) -> dict[str, Any]:
    """一張票的 API 形狀。四個寫入／讀取點共用，避免多份必然漂移。

    `raw` 是原始位元組：`editable` 的 round-trip 檢查要在原始位元組上做，`Task` 裡只有
    解碼修剪過的字串（spec §3）。讀不到的票傳 `b""`，round-trip 自然 False。"""
    return {
        "name": task.name, "number": task.number, "title": task.title,
        "status": task.status, "source": task.source, "created": task.created,
        "anomalies": list(task.anomalies), "fingerprint": fp,
        "body": task.body,
        "editable": can_round_trip(raw),
    }


def scan_tasks(tasks_fd: int) -> list[dict[str, Any]]:
    """掃出一個專案的全部票，逐檔隔離（契約 2）。回 API 形狀的 dict。

    重複編號（design §2.4.2）不只來自併發——手動改檔名、複製一份票檔都會造成。
    **兩張票都顯示、都標異常**，提示使用者手動改名。"""
    rows: list[dict[str, Any]] = []
    for name in list_task_files(tasks_fd):
        raw = read_task_bytes(tasks_fd, name)
        if raw is None:
            task, fp, raw = _unreadable_task(name), "", b""
        else:
            task, fp = parse_task(name, _decode(raw)), fingerprint(raw)
        rows.append(_row(task, fp, raw))

    seen: dict[int, int] = {}
    for row in rows:
        if row["number"] is not None:
            seen[row["number"]] = seen.get(row["number"], 0) + 1
    for row in rows:
        if row["number"] is not None and seen[row["number"]] > 1:
            row["anomalies"].append(ANOMALY_NUMBER_DUPLICATE)
    return rows


@dataclass(frozen=True)
class OpenCounts:
    """未完成票的計數。`doing` 是 `unfinished` 的**子集合**，不是另一個維度——
    總覽的刻度總數仍然是 `unfinished`，`doing` 只決定其中幾根要上色。

    `parked`（擱置，票 19）是**獨立維度**：不在 `unfinished` 裡、跟它沒有子集合關係。
    「不多回一個會互相牽制的數字」的理由仍成立——`parked` 與 `unfinished` 互斥、不牽制。"""

    unfinished: int
    doing: int
    parked: int


def count_rows(rows: list[dict[str, Any]]) -> OpenCounts:
    """從已掃好的列算計數。拆出來是為了 `build_overview` 只掃一次就能同時算計數與挑票。"""
    unfinished = doing = parked = 0
    for row in rows:
        if row["status"] in ("todo", "doing"):
            unfinished += 1
            if row["status"] == "doing":
                doing += 1
        elif row["status"] == "parked":
            parked += 1
    return OpenCounts(unfinished=unfinished, doing=doing, parked=parked)


def count_open(tasks_fd: int) -> OpenCounts:
    """未完成條數 ＝ effective status 為 `todo` 或 `doing` 的票數（design §5.1）。

    讀不到內容的票依 §6.1 的規則——`status` 本身判不出來 → fallback `todo` → 計入未完成。
    票不會因為讀不懂就從計數裡消失（契約 3）。

    **fallback 的票只進 `unfinished`、不進 `doing`**：把它算成進行中，等於在畫面上宣稱
    「有人在動這張票」，而我們連它的 status 都沒讀出來。"""
    return count_rows(scan_tasks(tasks_fd))


def _number_key(row: dict[str, Any]) -> tuple[bool, int, str]:
    """編號升冪；沒編號的排最後、依檔名。"""
    return (row["number"] is None, row["number"] or 0, row["name"])


def pick_highlights(rows: list[dict[str, Any]], today: date) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """總覽用的兩組票（spec §4.1）。

    `doing_tasks`：effective status 為 doing，編號升冪。
    `recent_tasks`：`created` 合法且 ≥ today − RECENT_DAYS、不是 done、不在 doing 裡；
    created 降冪、同日編號升冪。`parked` **會**進 recent（軸是時間不是狀態）。
    `created` 壞掉的票（parser 已清成空字串）不進——判不出日期就不宣稱它是新的。
    邊界含等號：剛好 7 天算「最近」。"""
    cutoff = (today - timedelta(days=RECENT_DAYS)).isoformat()
    doing = sorted((r for r in rows if r["status"] == "doing"), key=_number_key)
    recent = [r for r in rows if r["status"] not in ("done", "doing") and r["created"] and r["created"] >= cutoff]
    recent.sort(key=_number_key)                                   # 先編號，再穩定排 created 降冪
    recent.sort(key=lambda r: r["created"], reverse=True)
    return doing, recent


def _read_state_text(fledge_fd: int | None) -> str:
    """讀 `.fledge/state.md` 的前 64KB 文字。讀不到一律回空字串——兩個抽取函式共用。"""
    if fledge_fd is None:
        return ""
    try:
        fd = os.open(STATE_FILENAME, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fledge_fd)
    except OSError:
        return ""
    try:
        with os.fdopen(fd, "rb") as fh:
            return _decode(fh.read(NOTE_MAX_BYTES))
    except OSError:
        return ""


def read_next_step(fledge_fd: int | None) -> str:
    """從 `.fledge/state.md` 的前 20 行抽「下一步」（design §5.1）。讀不到一律回空字串。

    這是 `/resume-note` skill 已經寫死的格式合約，**該 skill 完全不需要修改**。"""
    for line in _read_state_text(fledge_fd).splitlines()[:STATE_HEAD_LINES]:
        m = _NEXT_STEP.match(line.strip())
        if m:
            return m.group(1).strip()
    return ""


def read_handoff_command(fledge_fd: int | None) -> str:
    """從 `.fledge/state.md` 抽「貼進新對話的指令」（票 21）：`_HANDOFF_HEADING` 之後
    第一個 ``` 圍籬的內容，不含圍籬行。讀不到、沒標題、圍籬沒關，一律回空字串。

    掃**前 64KB 內的所有行**而不是前 20 行——handoff skill 把這段寫在檔案末尾。
    64KB 是 `_read_state_text` 既有的上限（實測最大的 state.md 是 12KB）；超過的部分
    靜默不讀，這是知情的取捨，不是「整份」（Codex R1）。
    圍籬沒關視為「沒有」：那代表檔案寫到一半或被截斷，半段指令給人複製比不顯示更糟。
    圍籬判定見 `_FENCE_OPEN`／`_FENCE_CLOSE` 的註解——開關分開認，關圍籬的反引號數要
    ≥ 開圍籬，內文裡以 ``` 開頭的行（說明文字、巢狀程式碼區塊）才不會提早關閉。"""
    lines = _read_state_text(fledge_fd).splitlines()
    try:
        start = lines.index(_HANDOFF_HEADING)
    except ValueError:
        return ""
    body: list[str] | None = None
    fence_len = 0
    for line in lines[start + 1:]:
        stripped = line.strip()
        if body is None:
            m = _FENCE_OPEN.match(stripped)
            if m:
                body, fence_len = [], len(m.group(1))   # 進入圍籬，記住開圍籬的長度
            continue
        m = _FENCE_CLOSE.match(stripped)
        if m and len(m.group(1)) >= fence_len:
            return "\n".join(body).strip()   # 圍籬關上，只取第一段
        body.append(line)
    return ""                      # 沒有圍籬，或開了沒關


@dataclass(frozen=True)
class NoteResult:
    """`GET /tasks/note` 的結果（spec §4.4）。三態與 tasks_status 同名，語意：
    ok＝讀到了；absent＝`.fledge/` 開得起來但沒有 state.md（或 .fledge 不存在）；
    unavailable＝resolver 拒絕或讀取失敗。"""

    status: str
    content: str | None
    mtime: str | None       # YYYY-MM-DD
    fingerprint: str | None  # ok 時算在**讀到的位元組**上（與票同一個函式）；超過上限時是前 64KB 的
    editable: bool          # ＝ PUT 的接受條件：ok 且大小 ≤ NOTE_MAX_BYTES（D15）且 _note_can_round_trip


def note_path(project: str) -> str:
    """`.fledge/state.md` 的絕對路徑，給「用編輯器打開」用。同 `task_path` 的理由：佈局是本檔的常數。"""
    return os.path.join(project, FLEDGE_DIRNAME, STATE_FILENAME)


def read_note(td: TasksDir) -> NoteResult:
    """讀 state.md 全文（前 NOTE_MAX_BYTES）。

    **分類順序**（Task 3 審查 R1）：`fledge_fd is None` 不代表「不存在」——要看 `td.status`
    才知道是 resolver 拒絕（symlink、權限不足 → unavailable）還是真的沒有 `.fledge`
    （→ absent）。`fledge_fd` 有值就直接往下讀、**不再看 `td.status`**：`tasks/` 壞掉
    （例如被換成一般檔案）會讓 resolver 回 `unavailable`，但 state.md 住在 `.fledge/`、
    跟 `tasks/` 無關，總覽的 `next_step` 也是用同一個 `fledge_fd` 讀——兩者要一致，
    否則畫面上有「下一步」可看，點進去卻說讀不到。有 fd 之後只有 FileNotFoundError
    是 absent；其餘 OSError（state.md 是 symlink 的 ELOOP、EACCES、讀取中途失敗）都是 unavailable。
    不能沿用 `_read_state_text()`——它把所有失敗壓成空字串。

    票 19 增補（spec §10.2）：ok 時多算 `fingerprint`／`editable`，給介面內編輯用；非 ok 一律
    `None`／`False`。**`editable` 就是 `update_note` 的接受條件，兩邊同一個判斷**：大小 ≤ 上限
    且 `_note_can_round_trip`。GET 說 True 而 PUT 回 not_editable 就是宣稱高於實際保證——UI 會
    畫出「編輯」、使用者編完才吃 400（fix round 1 裁定）。"""
    if td.fledge_fd is None:
        # resolver 開不了 .fledge/：symlink／權限不足是 unavailable、不存在才是 absent（Codex R1）。
        # fledge_fd 有值就往下讀——tasks/ 壞掉不影響 state.md，總覽也是用同一個 fd 讀 next_step
        return NoteResult(STATUS_UNAVAILABLE if td.status == STATUS_UNAVAILABLE else STATUS_ABSENT,
                          None, None, fingerprint=None, editable=False)
    try:
        fd = os.open(STATE_FILENAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=td.fledge_fd)
    except FileNotFoundError:
        return NoteResult(STATUS_ABSENT, None, None, fingerprint=None, editable=False)
    except OSError:
        return NoteResult(STATUS_UNAVAILABLE, None, None, fingerprint=None, editable=False)
    try:
        st = os.fstat(fd)
        if not stat_module.S_ISREG(st.st_mode):
            return NoteResult(STATUS_UNAVAILABLE, None, None, fingerprint=None, editable=False)   # FIFO／目錄／裝置檔
        with os.fdopen(fd, "rb", closefd=False) as fh:
            raw = fh.read(NOTE_MAX_BYTES)
    except OSError:
        return NoteResult(STATUS_UNAVAILABLE, None, None, fingerprint=None, editable=False)
    finally:
        os.close(fd)
    # fingerprint 算在讀到的位元組上：≤ 上限時就是整檔；超過時是前 64KB——那份 editable 是 False，
    # PUT 也會用整檔重算再拒絕，所以這個「不完整」的 fingerprint 不會被拿去寫。大小用同一次 fstat
    # 的 st_size 而不是 len(raw)：len(raw) 在超過時永遠等於上限，分不出「剛好」與「超過」。
    # 先判大小再判 round-trip：超過時 raw 只是前 64KB，可能切在多位元組字元中間，那個結果沒有意義
    # （短路後根本不算）。`_note_can_round_trip` 對任意位元組不拋例外，讀取路徑的契約不變。
    return NoteResult(STATUS_OK, _decode(raw), date.fromtimestamp(st.st_mtime).isoformat(),
                      fingerprint=fingerprint(raw),
                      editable=st.st_size <= NOTE_MAX_BYTES and _note_can_round_trip(raw))


def build_overview(config: AppConfig, *, today: date | None = None) -> dict[str, Any]:
    """第一層總覽（design §5.1）：`scan_all` 的**所有**已知專案各一列，沒有待辦的顯示 0。

    不隱藏 0 條的專案——隱藏了使用者就不知道那個專案可以開票。
    單一專案 resolver 失敗只影響那一列的 `tasks_status`，整體不報錯（design §7.1）。

    `unfinished` 與 `doing` 在非 `ok` 時是 `None` 而不是 0：`unavailable` 與「真的沒有待辦」
    必須分得開（design §6.3），回 0 會讓前端無從分辨。`absent` 兩者都是 0。

    `doing` 是 `unfinished` 的子集合，給總覽的刻度上色用（票 02）。

    票 19：每列多回 `parked` 計數與 `doing_tasks`／`recent_tasks` 兩組票（同 GET /tasks 的列形狀、含 path），
    頂層多回 `recent_days`。`today` 可注入給測試；路由不傳＝sidecar 本地日期。
    一次 `scan_tasks()` 同時算計數與挑票，不多跑 I/O。
    """
    today = today or date.today()
    projects, permission_error = scan_all(config)
    rows: list[dict[str, Any]] = []
    for entry in projects:
        with open_tasks_dir(entry["path"], config, projects=projects) as td:
            if td.status == STATUS_OK and td.fd is not None:
                scanned = scan_tasks(td.fd)
                counts = count_rows(scanned)
                unfinished: int | None = counts.unfinished
                doing: int | None = counts.doing
                parked: int | None = counts.parked
                doing_tasks, recent_tasks = pick_highlights(scanned, today)
                for r in (*doing_tasks, *recent_tasks):
                    r["path"] = task_path(td.project, r["name"])
                highlights: tuple[list | None, list | None] = (doing_tasks, recent_tasks)
            elif td.status == STATUS_ABSENT:
                unfinished = doing = parked = 0
                highlights = ([], [])
            else:
                # 三個欄位同一套規則：讀不到都是 None，不是 0（design §6.3）
                unfinished = doing = parked = None
                highlights = (None, None)
            rows.append({
                "path": entry["path"],
                "name": entry.get("name", ""),
                "account": entry.get("account", ""),
                "unfinished": unfinished,
                "doing": doing,
                "parked": parked,
                "doing_tasks": highlights[0],
                "recent_tasks": highlights[1],
                "tasks_status": td.status,
                "next_step": read_next_step(td.fledge_fd),
            })
    return {"projects": rows, "permission_error": permission_error, "recent_days": RECENT_DAYS}


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
        return _row(parse_task(name, raw.decode("utf-8")), fingerprint(raw), raw)
    raise OSError("too many number collisions")


def task_path(project: str, name: str) -> str:
    """票檔的絕對路徑，給前端「用編輯器打開」用（design §5.2）。

    由 sidecar 組而不是前端拼：`.fledge/tasks` 這個佈局是本檔的常數，
    寫兩份必然漂移。**這是唯讀資訊，寫入端點仍然只收 `project` ＋ `name`。**"""
    return os.path.join(project, FLEDGE_DIRNAME, TASKS_DIRNAME, name)


def _open_existing(tasks_fd: int, name: str, *, write: bool = False) -> int:
    """開一張既有票，套用 design §7.1 的 T1–T3。不合條件一律 raise ValueError／OSError。

    - **T1**：純檔名——不含 `/`、不是 `.` 或 `..`
    - **T2**：必須是一般檔案且副檔名 `.md`——目錄、FIFO、裝置檔一律拒絕
    - **T3**：`O_NOFOLLOW`，是 symlink 就拒絕

    `O_NONBLOCK`：FIFO 用 `O_RDONLY` 開會**阻塞到有寫入端出現**，那會把整個 sidecar 卡住。
    先用非阻塞開起來，再靠 `fstat` 把非一般檔擋掉。"""
    if not is_plain_name(name) or not name.endswith(".md"):
        raise ValueError("invalid task name")
    flags = (os.O_RDWR if write else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags, dir_fd=tasks_fd)
    try:
        info = os.fstat(fd)
        if not stat_module.S_ISREG(info.st_mode):
            raise ValueError("not a regular file")
        # **T4（寫入專用）：hard link 不是 symlink，`O_NOFOLLOW` 擋不住它。**
        # 在 tasks 目錄裡放一個指向專案外檔案的 hard link，T1–T3 全部會過，
        # 而寫入是寫到共用的那個 inode 上——實測會改寫專案外的檔案，
        # 直接推翻 design §7.1「目標語意上不可能指到 tasks 目錄以外」那句話
        # （2026-08-31 Codex 實作階段審查抓到）。
        # 只擋寫入：讀取只是顯示使用者自己連進來的內容，而 `unlink` 移除的是
        # 這個目錄項、動不到連結指向的那個檔案。
        if write and info.st_nlink != 1:
            raise ValueError("hard-linked target")
    except BaseException:
        os.close(fd)
        raise
    return fd


def _write_all(fd: int, data: bytes) -> None:
    """把 `data` 全部寫進 fd。**`os.write` 允許短寫，回傳值不能忽略**。

    初版只呼叫一次 `os.write` 就接著 `ftruncate`：短寫（磁碟滿、被訊號打斷）時
    檔案會變成「新內容的前半 ＋ 舊內容的尾巴」，而端點照樣回報成功、還回傳
    一個與磁碟內容不符的 fingerprint（2026-08-31 Codex 實作階段審查抓到）。"""
    view = memoryview(data)
    written = 0
    while written < len(data):
        n = os.write(fd, view[written:])
        if n <= 0:
            raise OSError("short write: 寫入未完成")
        written += n


def _read_all(fd: int) -> bytes:
    chunks: list[bytes] = []
    while True:
        block = os.read(fd, 65536)
        if not block:
            return b"".join(chunks)
        chunks.append(block)


def update_status(
    tasks_fd: int, name: str, *, status: str, expected_fingerprint: str
) -> dict[str, Any] | None:
    """改狀態（design §5.2、§7.2）。fingerprint 不符回 `None`（路由轉 409）並**拒絕寫入**。

    **保證等級：best-effort stale detection。就這樣，不多。** 它擋得住的是已經發生完畢的
    外部改動——你在編輯器改完存檔了，之後在面板點狀態，會拿到 409 而不是覆蓋。
    重算到實際寫入之間仍有窗口（design §10.4 的 K1），**這裡刻意不試圖關閉它**。

    **寫入不是原子的，這裡照實說（design §10.4 的 K5）**：在已 pin 的 fd 上原地覆寫。
    寫到一半失敗（磁碟滿、I/O 錯誤、斷電）會留下「新內容前半 ＋ 舊內容尾巴」的壞檔，
    而 `.fledge/` 不進 git，**不可回復**。與 §2.4.1 對建票的處置一致：這個定位是
    單人、本機、純文字筆記，不撐交易語意。

    > **2026-08-31：這段曾經寫成「暫存檔 ＋ `os.rename` 原子替換」，之後整段拿掉。**
    > 連續三輪 Codex 審查都落在同一段自己發明的寫入協定上，每補一塊就長出新的邊界
    > （固定暫存檔在併發下互相 unlink、rename 讓覆蓋外部存檔的窗口比原地寫更寬、
    > umask 吃掉檔案 mode、目錄沒 fsync）。依本 repo 既有教訓——**連三輪打同一段
    > 自己寫的邏輯，訊號是那段不該自己寫**——處置是縮小承諾，不是寫第四個版本。
    > 拿掉之後那四條 finding 是「消失」而不是「修好」。
    """
    if status not in VALID_STATUS:
        raise ValueError("invalid status")
    with _WRITE_LOCK:
        fd = _open_existing(tasks_fd, name, write=True)
        try:
            raw = _read_all(fd)
            if fingerprint(raw) != expected_fingerprint:
                return None
            new_raw = replace_status(raw, status)   # 在位元組上改，不解碼（見 parser.replace_status）
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                _write_all(fd, new_raw)             # os.write 允許短寫，回傳值不能忽略
                os.ftruncate(fd, len(new_raw))
            except OSError as exc:
                # I/O 失敗與「目標不合法」分開回報（路由：500 vs 400）。
                # **這裡不做復原**——見本函式 docstring 的保證等級宣告。
                raise TaskWriteError(str(exc)) from exc
        finally:
            os.close(fd)
    # 回傳更新後的票（含新 fingerprint）。沒有這個，使用者改一次狀態之後本地的
    # fingerprint 就過期了，**下一次改狀態或刪除會被錯誤地判成 409**（design §7.2）。
    return _row(parse_task(name, _decode(new_raw)), fingerprint(new_raw), new_raw)


def _validate_content_domain(title: str, body: str) -> None:
    """§5.2.2 值域：sidecar 端再驗一次。UI 已正規化過，這一層是防前端漏掉。"""
    if not title or title != " ".join(title.split()):
        raise ValueError("invalid_content")
    if body != body.replace("\r\n", "\n").replace("\r", "\n").strip("\n"):
        raise ValueError("invalid_content")


def update_content(
    tasks_fd: int, name: str, *, title: str, body: str, expected_fingerprint: str
) -> dict[str, Any] | None:
    """改標題與內文（spec §5.4）。fingerprint 不符回 None（路由轉 409）並拒絕寫入。

    流程固定：pin fd → round-trip 資格 → fingerprint → replace_body → 原地覆寫。
    **檔案身分自始至終是同一個 fd，檔名完全不碰**（D3）。

    保真範圍：**frontmatter 位元組一字不動**；圍籬之後由 `replace_body` 重組。
    圍籬之後的內容經過前端往返已是解碼字串，所以只有 round-trip 過的票才准編輯（§5.2.1），
    否則 parser 讀取時削掉的東西會在這裡永久消失。

    寫入不是原子的（K5、K6）——與 `update_status` 同一個等級，刻意不重新發明寫入協定。
    安全網是前端的草稿（§7.3）。

    ValueError 的訊息是 error code，路由直接用：`not_editable`／`invalid_content`／
    `_open_existing` 的既有訊息。
    """
    _validate_content_domain(title, body)
    with _WRITE_LOCK:
        fd = _open_existing(tasks_fd, name, write=True)
        try:
            try:
                raw = _read_all(fd)
            except OSError as exc:
                # fd 已經過 _open_existing 的 T1–T4，讀失敗只可能是 I/O（EIO、掛載掉了…），
                # 不是目標不合法。不轉成 TaskWriteError 的話會落到路由的 generic OSError
                # 分支回 400 invalid_target，而 spec §8 的 400 是封閉列舉、I/O 失敗屬 500。
                raise TaskWriteError(str(exc)) from exc
            if not can_round_trip(raw):
                raise ValueError("not_editable")
            if fingerprint(raw) != expected_fingerprint:
                return None
            new_raw = replace_body(raw, title, body)
            # 寫下去的東西自己要讀得回來（spec §5.2.1）。值域檢查只認 \r\n，但 parser 用
            # str.splitlines()，它還會在 \x0b\x0c\x1c-\x1e\x85\u2028\u2029 斷行——那些字元
            # 從網頁／PDF 貼上很常見，放行的話這張票寫完就自己拒絕再編輯，且面板顯示的
            # 內文與磁碟位元組不符。用後置條件而不是補字元清單：往後 parser 若再長出新的
            # 分岔，這裡自動擋得住，不必記得回來同步。
            if not can_round_trip(new_raw):
                raise ValueError("invalid_content")
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                _write_all(fd, new_raw)
                os.ftruncate(fd, len(new_raw))
            except OSError as exc:
                raise TaskWriteError(str(exc)) from exc
        finally:
            os.close(fd)
    return _row(parse_task(name, _decode(new_raw)), fingerprint(new_raw), new_raw)


def _note_can_round_trip(raw: bytes) -> bool:
    """筆記版的 round-trip 資格——spec §10.2 寫的是「`can_round_trip` 不過 → not_editable」，
    但 `parser.can_round_trip` 驗的是**票的形狀**（frontmatter ＋ `# 標題` ＋ 內文重組後逐位元組
    相等），而 resume-note skill 寫的 state.md 以 `# <專案名> — …` 起頭、沒有 frontmatter，
    照抄會讓每一份真實筆記都被判 not_editable，功能等於沒做。這裡改驗**同一個性質**在筆記形狀
    上的等價條件。

    前端拿到的是整份 `_decode(raw)`，「寫回去不弄丟東西」只有兩個條件：
    - 嚴格 UTF-8 解得開——否則 `errors="replace"` 換進去的 U+FFFD 會被永久寫回磁碟
      （與票的 `can_round_trip` 第一步相同）
    - 沒有 `\\r`——textarea 的 API value 會把 CRLF／CR 正規化成 LF，使用者只改一個字存回去，
      整份換行會靜默翻掉（票的 CRLF 判 not_editable 是同一條規則）

    **不列舉 `splitlines()` 的其他分行字元**（\\x0b、\\u2028…）：票要擋是因為 parser 逐行拆過
    再重組，筆記全文不經過那一步、寫什麼讀回什麼，擋了只是多一條沒有對應風險的規則。"""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return "\r" not in text


def update_note(fledge_fd: int, content: str, *, expected_fingerprint: str) -> NoteResult | None:
    """改離場筆記全文（票 19 增補，spec §10.2、D13）。fingerprint 不符回 None（路由轉 409）並拒絕寫入。

    **與票內容走同一套規則、不另造協定（D13）**：流程與 `update_content` 逐段對應——
    `_open_existing(write=True)` 釘 fd（T1–T4：純檔名、一般檔、`O_NOFOLLOW`、不是 hard link）
    → `_WRITE_LOCK` → 讀全檔 → round-trip 資格 → fingerprint → 原地覆寫。
    **檔案身分自始至終是同一個 fd，檔名完全不碰。**

    `_open_existing` 沒有 `O_CREAT`：state.md 不存在就 `FileNotFoundError`（路由 404）。
    **這裡刻意不建檔**——建立離場筆記是 resume-note skill 的事（spec §10.2）。

    保真範圍與票不同：票只換圍籬之後的內容、frontmatter 一字不動；筆記沒有那個結構，
    **整份原樣寫入**，所以資格檢查用 `_note_can_round_trip`，不用票形狀的 `can_round_trip`
    （理由見該函式）。值域檢查也不沿用 `_validate_content_domain`：它對空 title 必拋
    （筆記沒有 title），而它對 body 的 `strip("\\n")` 要求是因為票的寫入端自己補首尾換行——
    筆記原樣寫入，首尾換行是內容的一部分，不能拒。等價的 body 檢查就只剩「沒有 `\\r`」，
    已包在 `_note_can_round_trip(new_raw)` 這個後置條件裡。

    超過 `NOTE_MAX_BYTES` 一律 not_editable（D15）：GET 只讀前 64KB，寫回去會把後面截掉。
    大小看 `_read_all` 讀到的整檔，不看 GET 那份——GET 的 fingerprint 在超過時本來就不會
    等於整檔的，但擋在大小這關比擋在 409 誠實：那不是「別人改過」，是「這份不給改」。

    寫入不是原子的（spec §10.6 第 9 條）——與 `update_status`／`update_content` 同一個等級，
    在已 pin 的 fd 上 `lseek`＋`_write_all`＋`ftruncate`。硬中斷可能留半檔，安全網是外部編輯器
    與 git（spec §10.6 第 9 條原話）；**這裡刻意不重新發明寫入協定**（`update_status` 的
    docstring 記著三輪審查打在自製協定上的教訓）。

    ValueError 的訊息是 error code，路由直接用：`not_editable`／`invalid_content`／
    `_open_existing` 的既有訊息（歸 `invalid_target`）。
    """
    with _WRITE_LOCK:
        fd = _open_existing(fledge_fd, STATE_FILENAME, write=True)
        try:
            try:
                raw = _read_all(fd)
            except OSError as exc:
                # 同 update_content：fd 已過 T1–T4，讀失敗只可能是 I/O → 500，不是 400 invalid_target
                raise TaskWriteError(str(exc)) from exc
            if len(raw) > NOTE_MAX_BYTES or not _note_can_round_trip(raw):
                raise ValueError("not_editable")
            if fingerprint(raw) != expected_fingerprint:
                return None
            new_raw = content.encode("utf-8")
            # 後置條件：寫下去的東西自己要讀得回來（同 update_content 對 new_raw 的檢查）
            if not _note_can_round_trip(new_raw):
                raise ValueError("invalid_content")
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                _write_all(fd, new_raw)
                os.ftruncate(fd, len(new_raw))
                st = os.fstat(fd)
            except OSError as exc:
                raise TaskWriteError(str(exc)) from exc
        finally:
            os.close(fd)
    # 回傳更新後的筆記（含新 fingerprint）——前端用它取代本地狀態，否則存一次之後本地的
    # fingerprint 就過期、下一次儲存會被誤判 409（同 update_status 的理由）。
    return NoteResult(STATUS_OK, content, date.fromtimestamp(st.st_mtime).isoformat(),
                      fingerprint=fingerprint(new_raw), editable=True)


def delete_task(tasks_fd: int, name: str, *, expected_fingerprint: str) -> bool:
    """刪票（design §5.2）。fingerprint 不符回 `False`（路由轉 409）。

    **TOCTOU 窗口沒有關閉，這裡照實說**（design §7.1 末、§10.4 的 K1）：POSIX 的 `unlink`
    必須指定目錄項名稱，無法對已開啟的 fd 執行。所以重算 fingerprint 與 `unlink` 之間有窗口
    ——外部編輯器若剛好在窗口內存檔，`DELETE` **仍會刪掉那個新版本並回成功，不會有 409**。
    `dir_fd` ＋ `O_NOFOLLOW` ＋ fingerprint 是把窗口縮到最小，**不是關閉它**。
    """
    with _WRITE_LOCK:
        fd = _open_existing(tasks_fd, name)
        try:
            if fingerprint(_read_all(fd)) != expected_fingerprint:
                return False
        finally:
            os.close(fd)
        os.unlink(name, dir_fd=tasks_fd)
        return True

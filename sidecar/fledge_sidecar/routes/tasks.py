"""待辦面板路由（design §7）。七個端點。

錯誤一律回 error code，不回 user-facing 中文 prose（`CLAUDE.md` §4.6.13）。
路徑邊界一律經 `tasks/scanner.py` 的 resolver，本檔不自己組路徑（design §7.1）。
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.tasks import scanner

router = APIRouter(prefix="/tasks")


def _with_path(rows: list[dict], project: str) -> list[dict]:
    """替每張票補上絕對路徑，給前端「用編輯器打開」用（design §5.2）。

    **這是唯讀資訊**——寫入端點仍然只收 `project` ＋ `name`（design §7.1）。"""
    for row in rows:
        row["path"] = scanner.task_path(project, row["name"])
    return rows


def _target(td: scanner.TasksDir) -> JSONResponse | None:
    """寫入端點共用的前置檢查。回 `None` 代表可以動手。

    `absent`／`unavailable` 一律硬拒——`unavailable` 是給唯讀端點表達「讀不到」用的，
    不是讓寫入降級（design §7.1 末）。"""
    if td.status == scanner.STATUS_UNKNOWN_PROJECT:
        return JSONResponse({"error": "unknown_project"}, status_code=400)
    if td.status != scanner.STATUS_OK or td.fd is None:
        return JSONResponse({"error": "tasks_dir_" + td.status}, status_code=400)
    return None


@router.get("/overview")
def overview() -> JSONResponse:
    """第一層：每個已知專案的未完成條數、`tasks_status` 與「下一步」（design §5.1、§6.3）。"""
    return JSONResponse(scanner.build_overview(AppConfig.load()))


def _note_payload(r: scanner.NoteResult, project: str) -> dict:
    """`GET`／`PUT /tasks/note` 共用的回應形狀（spec §10.2：PUT 成功回 GET 的形狀）。

    `path` 只在 ok 時給——給了 absent 的 path 等於邀請前端去開一個不存在的檔。"""
    return {
        "status": r.status,
        "content": r.content,
        "mtime": r.mtime,
        "path": scanner.note_path(project) if r.status == scanner.STATUS_OK else None,
        "fingerprint": r.fingerprint,
        "editable": r.editable,
    }


@router.get("/note")
def note(project: str = "") -> JSONResponse:
    """離場筆記全文（票 19，spec §4.4）。只讀；點「下一步」才打，不隨總覽回。

    三態分類在 `scanner.read_note` 裡，本函式不自己判 fd。票 19 增補（spec §10.2）多回
    `fingerprint`／`editable`，給 `PUT /tasks/note` 用。"""
    with scanner.open_tasks_dir(project, AppConfig.load()) as td:
        if td.status == scanner.STATUS_UNKNOWN_PROJECT:
            return JSONResponse({"error": "unknown_project"}, status_code=400)
        return JSONResponse(_note_payload(scanner.read_note(td), td.project))


@router.put("/note")
def update_note(project: str = Body(""), content: str = Body(""), fingerprint: str = Body("")) -> JSONResponse:
    """改離場筆記全文（票 19 增補，spec §10.2、D13）。必須帶 `fingerprint`，不符回 409 並拒絕寫入。

    前置檢查**不走 `_target`**——那個要求 `td.fd`（tasks/ 目錄），而 state.md 住在 `.fledge/`、
    與 `tasks/` 無關；這裡看的是 `fledge_fd`，與 `read_note` 同一條規則（§4.4）：`fledge_fd is None`
    時 `absent` → 404 `not_found`、`unavailable` → 400 `fledge_dir_unavailable`；有 `fledge_fd` 就往下，
    不看 `tasks/` 狀態。

    **不建檔**：state.md 不存在就 404，建立離場筆記是 resume-note skill 的事。
    400 的 error code 直接來自 `update_note` 的 ValueError 訊息：`not_editable`（超過 64KB 或
    round-trip 不過）、`invalid_content`（值域不符）、其餘歸 `invalid_target`；錯誤映射與
    `PUT /tasks/content` 逐條相同。
    """
    if not fingerprint:
        return JSONResponse({"error": "fingerprint_required"}, status_code=400)
    with scanner.open_tasks_dir(project, AppConfig.load()) as td:
        if td.status == scanner.STATUS_UNKNOWN_PROJECT:
            return JSONResponse({"error": "unknown_project"}, status_code=400)
        if td.fledge_fd is None:
            if td.status == scanner.STATUS_UNAVAILABLE:
                return JSONResponse({"error": "fledge_dir_unavailable"}, status_code=400)
            return JSONResponse({"error": "not_found"}, status_code=404)
        try:
            r = scanner.update_note(td.fledge_fd, content, expected_fingerprint=fingerprint)
        except (scanner.TaskWriteError, PermissionError):
            return JSONResponse({"error": "write_failed"}, status_code=500)
        except ValueError as exc:
            code = str(exc) if str(exc) in ("not_editable", "invalid_content") else "invalid_target"
            return JSONResponse({"error": code}, status_code=400)
        except FileNotFoundError:
            return JSONResponse({"error": "not_found"}, status_code=404)
        except OSError:
            return JSONResponse({"error": "invalid_target"}, status_code=400)
        if r is None:
            return JSONResponse({"error": "stale"}, status_code=409)
        return JSONResponse(_note_payload(r, td.project))


@router.get("")
def list_tasks(project: str = "") -> JSONResponse:
    """第二層：單一專案的票列表（含異常標記與 fingerprint）。

    `tasks` 在讀不到時是 `null` 而不是空清單（design §6.3）：點進一個讀不到的專案，
    若只顯示空清單，使用者分不出「這個專案沒待辦」與「讀不到」——與第一層是同一個問題。
    用 `null` 讓前端在結構上不可能把它畫成「沒有待辦」。
    """
    config = AppConfig.load()
    with scanner.open_tasks_dir(project, config) as td:
        if td.status == scanner.STATUS_UNKNOWN_PROJECT:
            return JSONResponse({"error": "unknown_project"}, status_code=400)
        if td.status == scanner.STATUS_OK and td.fd is not None:
            tasks: list | None = _with_path(scanner.scan_tasks(td.fd), td.project)
        elif td.status == scanner.STATUS_ABSENT:
            tasks = []
        else:
            tasks = None
        return JSONResponse({
            "project": td.project,
            "tasks_status": td.status,
            "tasks": tasks,
            "next_step": scanner.read_next_step(td.fledge_fd),
            # 票 21：只有這一層帶指令段。總覽不帶——那層每個專案都要掃，指令卻只在點進來後才用
            "handoff_command": scanner.read_handoff_command(td.fledge_fd),
        })


@router.post("")
def create_task(project: str = Body(""), title: str = Body("")) -> JSONResponse:
    """建票（design §5.2）。`source: me`、`status: todo`、`created` 為當天。

    **寫入端點不收絕對路徑，收 `project` ＋ `title`。** 目標檔名只能由 resolver ＋
    短名 allowlist 算出，語意上不可能指到 tasks 目錄以外（design §7.1）。

    `absent`／`unavailable` 一律硬拒回 error code——`unavailable` 是給唯讀端點表達
    「讀不到」用的，不是讓寫入降級（design §7.1 末）。`create=True` 會把 `absent`
    變成 `ok`（逐層 mkdir），所以走到這裡還是 `absent` 就代表建立失敗。
    """
    clean = " ".join(title.split())
    if not clean:
        return JSONResponse({"error": "title_required"}, status_code=400)
    with scanner.open_tasks_dir(project, AppConfig.load(), create=True) as td:
        rejected = _target(td)
        if rejected is not None:
            return rejected
        try:
            row = scanner.create_task(td.fd, clean, created=date.today().isoformat())
            _with_path([row], td.project)
        except OSError:
            return JSONResponse({"error": "create_failed"}, status_code=500)
        return JSONResponse(row, status_code=201)


@router.patch("")
def update_task(
    project: str = Body(""), name: str = Body(""),
    status: str = Body(""), fingerprint: str = Body(""),
) -> JSONResponse:
    """改狀態（design §5.2、§7.2）。必須帶 `fingerprint`，不符回 409 並拒絕寫入。

    成功時**回傳更新後的票（含新 fingerprint）**，前端用它取代本地狀態。沒有這條的話，
    使用者改一次狀態之後本地的 fingerprint 就過期了，下一次操作會被錯誤地判成 409。
    """
    if not name:
        return JSONResponse({"error": "name_required"}, status_code=400)
    if not fingerprint:
        return JSONResponse({"error": "fingerprint_required"}, status_code=400)
    with scanner.open_tasks_dir(project, AppConfig.load()) as td:
        rejected = _target(td)
        if rejected is not None:
            return rejected
        try:
            row = scanner.update_status(td.fd, name, status=status, expected_fingerprint=fingerprint)
        except (scanner.TaskWriteError, PermissionError):
            # I/O 失敗要與「目標不合法」分開回報，否則磁碟滿或唯讀檔案系統
            # 會被報成參數錯誤，讓人往查錯的方向找。PermissionError 也歸這裡：
            # 檔案存在、名字合法、型別正確，只是開不起來——那不是「目標不合法」
            return JSONResponse({"error": "write_failed"}, status_code=500)
        except ValueError:
            return JSONResponse({"error": "invalid_target"}, status_code=400)
        except FileNotFoundError:
            return JSONResponse({"error": "not_found"}, status_code=404)
        except OSError:
            return JSONResponse({"error": "invalid_target"}, status_code=400)
        if row is None:
            return JSONResponse({"error": "stale"}, status_code=409)
        return JSONResponse(_with_path([row], td.project)[0])


@router.put("/content")
def update_content(
    project: str = Body(""), name: str = Body(""),
    title: str = Body(""), body: str = Body(""), fingerprint: str = Body(""),
) -> JSONResponse:
    """改標題與內文（spec §8）。與 PATCH 分開：PATCH 只換 status 一行、其餘位元組不動；
    這個端點換圍籬之後的全部、frontmatter 不動——兩種保真等級不混進同一個端點（§4）。

    400 的 error code 直接來自 `update_content` 的 ValueError 訊息：`not_editable`
    （round-trip 不過）、`invalid_content`（值域不符）、其餘歸 `invalid_target`。
    **anomaly 標記不是 400 的理由**——`number_duplicate`／`number_missing` 的票照樣 200。
    """
    if not name:
        return JSONResponse({"error": "name_required"}, status_code=400)
    if not fingerprint:
        return JSONResponse({"error": "fingerprint_required"}, status_code=400)
    with scanner.open_tasks_dir(project, AppConfig.load()) as td:
        rejected = _target(td)
        if rejected is not None:
            return rejected
        try:
            row = scanner.update_content(
                td.fd, name, title=title, body=body, expected_fingerprint=fingerprint,
            )
        except (scanner.TaskWriteError, PermissionError):
            return JSONResponse({"error": "write_failed"}, status_code=500)
        except ValueError as exc:
            code = str(exc) if str(exc) in ("not_editable", "invalid_content") else "invalid_target"
            return JSONResponse({"error": code}, status_code=400)
        except FileNotFoundError:
            return JSONResponse({"error": "not_found"}, status_code=404)
        except OSError:
            return JSONResponse({"error": "invalid_target"}, status_code=400)
        if row is None:
            return JSONResponse({"error": "stale"}, status_code=409)
        return JSONResponse(_with_path([row], td.project)[0])


@router.delete("")
def remove_task(project: str = "", name: str = "", fingerprint: str = "") -> JSONResponse:
    """刪票（design §5.2）。檔案直接消失且 `.fledge/` 不進 git——確認由前端負責。"""
    if not name:
        return JSONResponse({"error": "name_required"}, status_code=400)
    if not fingerprint:
        return JSONResponse({"error": "fingerprint_required"}, status_code=400)
    with scanner.open_tasks_dir(project, AppConfig.load()) as td:
        rejected = _target(td)
        if rejected is not None:
            return rejected
        try:
            ok = scanner.delete_task(td.fd, name, expected_fingerprint=fingerprint)
        except ValueError:
            return JSONResponse({"error": "invalid_target"}, status_code=400)
        except FileNotFoundError:
            return JSONResponse({"error": "not_found"}, status_code=404)
        except OSError:
            return JSONResponse({"error": "invalid_target"}, status_code=400)
        if not ok:
            return JSONResponse({"error": "stale"}, status_code=409)
        return JSONResponse({"deleted": name})

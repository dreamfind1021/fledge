"""待辦面板路由（design §7）。T1 `overview`、T2 `GET /tasks`、T3 `POST /tasks`。

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


@router.get("/overview")
def overview() -> JSONResponse:
    """第一層：每個已知專案的未完成條數、`tasks_status` 與「下一步」（design §5.1、§6.3）。"""
    return JSONResponse(scanner.build_overview(AppConfig.load()))


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
            tasks: list | None = scanner.scan_tasks(td.fd)
        elif td.status == scanner.STATUS_ABSENT:
            tasks = []
        else:
            tasks = None
        return JSONResponse({
            "project": td.project,
            "tasks_status": td.status,
            "tasks": tasks,
            "next_step": scanner.read_next_step(td.fledge_fd),
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
        if td.status == scanner.STATUS_UNKNOWN_PROJECT:
            return JSONResponse({"error": "unknown_project"}, status_code=400)
        if td.status != scanner.STATUS_OK or td.fd is None:
            return JSONResponse({"error": "tasks_dir_" + td.status}, status_code=400)
        try:
            row = scanner.create_task(td.fd, clean, created=date.today().isoformat())
        except OSError:
            return JSONResponse({"error": "create_failed"}, status_code=500)
        return JSONResponse(row, status_code=201)

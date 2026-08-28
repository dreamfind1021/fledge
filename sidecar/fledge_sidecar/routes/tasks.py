"""待辦面板路由（design §7）。T1 只有 `GET /tasks/overview`。

錯誤一律回 error code，不回 user-facing 中文 prose（`CLAUDE.md` §4.6.13）。
路徑邊界一律經 `tasks/scanner.py` 的 resolver，本檔不自己組路徑（design §7.1）。
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.tasks.scanner import build_overview

router = APIRouter(prefix="/tasks")


@router.get("/overview")
def overview() -> JSONResponse:
    """第一層：每個已知專案的未完成條數 ＋ `tasks_status`（design §5.1、§6.3）。"""
    return JSONResponse(build_overview(AppConfig.load()))

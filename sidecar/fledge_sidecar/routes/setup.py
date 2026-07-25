"""Setup 路由：開發環境偵測狀態（spec §5）＋雙帳號共通設置（spec §6.3）。

安裝／登入不在此處——走 POST /api/sessions 的 kind=install/login（spec §2 #13）。
"""
from __future__ import annotations

import threading
from dataclasses import asdict

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.setup import common_config
from fledge_sidecar.setup.env_detect import detect_all

router = APIRouter()

# 沿用 routes/config.py 的慣例：單 process 鎖序列化並發寫入（apply 會動 FS）
_setup_lock = threading.Lock()


class CommonConfigBody(BaseModel):
    model_config = ConfigDict(extra="forbid")  # 未知欄位（如注入 "command"）→ 422
    source: str
    targets: list[str]
    entries: list[str]


class OverwriteItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account: str
    entry: str


class CommonConfigApplyBody(CommonConfigBody):
    # 被授權破壞既有內容的 (account, entry)；未列者回 conflict 不動。
    # 用 pair 而非裸 entry 名——否則勾了 A 帳號的 commands 會連帶炸掉 B 帳號的。
    overwrite: list[OverwriteItem] = []


@router.get("/api/setup/status")
def setup_status():
    # detect_all 以模組層名稱呼叫，測試可 monkeypatch 注入假資料
    return {"tools": [asdict(s) for s in detect_all()]}


class _PlanError(Exception):
    """帶 HTTP 狀態碼的判別碼，兩個端點共用同一組錯誤轉換規則。"""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def _build_plan(body: CommonConfigBody) -> common_config.Plan:
    try:
        config = AppConfig.load()
    except ValueError as exc:
        # json.JSONDecodeError 是 ValueError 子類，與模組的判別碼共用一個 except 的話，
        # JSON 剖析訊息會被當成 error code 回給前端（CLAUDE.md §4.6.13）。
        # 且設定檔壞掉是伺服端狀況，不是 client 輸入錯誤——狀態碼也不該是 400。
        raise _PlanError(500, "config_unreadable") from exc
    try:
        graph = common_config.build_account_graph(config.accounts, body.source, body.targets)
        return common_config.plan(graph, body.entries)
    except ValueError as exc:
        raise _PlanError(400, str(exc)) from exc     # 模組保證 ValueError 內容是英文判別碼
    except OSError as exc:
        # 探測期間 FS 出狀況（目錄不可讀、競態中消失）：同樣不是 client 輸入錯誤，
        # 但必須回判別碼而不是裸 500，否則前端無從分辨與 i18n。
        raise _PlanError(500, "probe_failed") from exc


@router.post("/api/setup/common-config/plan")
def common_config_plan(body: CommonConfigBody):
    """唯讀預覽：回每個 (target, entry) 的目前狀態與建議動作，不動檔案系統。"""
    try:
        result = _build_plan(body)
    except _PlanError as exc:
        return JSONResponse(status_code=exc.status, content={"error": exc.code})
    return {
        "source_dir": result.source_dir,
        "operations": [asdict(o) for o in result.operations],
    }


@router.post("/api/setup/common-config/apply")
def common_config_apply(body: CommonConfigApplyBody):
    """套用共通設置。plan 由 server 以相同輸入**重算**（ADR-0002）——不接受 client
    回傳的 plan 物件，client 狀態不可信且 dry-run 後 FS 可能已變。"""
    with _setup_lock:
        try:
            result = _build_plan(body)
        except _PlanError as exc:
            return JSONResponse(status_code=exc.status, content={"error": exc.code})
        applied = common_config.apply(
            result, [(o.account, o.entry) for o in body.overwrite]
        )
    return {"results": [asdict(r) for r in applied.results]}

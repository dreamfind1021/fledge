"""還原路由：備份包與展開位置的唯讀預覽，以及移機的 install 端點（票 03 起）。

**位置問題不是錯誤**（沿用 `routes/backup.py` 的取向）：一律 200 用 `dest_status` 旗標表達，
錯誤碼只留給請求本身壞掉（未知的備份包名、不是絕對路徑的展開位置）。塞進 HTTP 錯誤碼就只
剩「壞了」一個資訊，卡片沒辦法分辨「那個位置非空」與「選到現役資料裡面」。

實際的展開不在此處，走 `POST /api/sessions` 的 kind=restore（PTY 跑
`scripts/restore-claude.sh`）：那是長時間工作，而它的輸出本身就是使用者要看的差異報告。

寫入能力的邊界：`/api/restore/install` 是本檔唯一會寫現役目錄的端點，而它的全部寫入能力
與安全不變式都在 `backup/install.py` 模組內——route 只轉譯 HTTP，不做任何路徑判斷。
`backup/restore.py` 模組維持零寫入能力（票 09 的結構性不變式，未被本檔改變）。
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from fledge_sidecar.app_config import AppConfig, default_config_path
from fledge_sidecar.backup import install, restore
from fledge_sidecar.backup.containment import source_roots
from fledge_sidecar.backup.script import scripts_root
from fledge_sidecar.routes.setup import setup_lock

router = APIRouter()


class RestorePlanBody(BaseModel):
    model_config = ConfigDict(extra="forbid")  # 未知欄位（如注入 "command"）→ 422
    bundle: str
    dest: str | None = None                    # 未給＝用後端算的預設位置


@router.post("/api/restore/plan")
def restore_plan(body: RestorePlanBody):
    """回「這份備份包會解到哪裡、那個位置能不能用」。唯讀，不動檔案系統。"""
    try:
        config = AppConfig.load()
    except ValueError:
        # json.JSONDecodeError 是 ValueError 子類：與判別碼共用一個 except 的話，JSON 剖析
        # 訊息會被當成 error code 回給前端（CLAUDE.md §4.6.13）。也不是 client 輸入錯誤。
        return JSONResponse(status_code=500, content={"error": "config_unreadable"})
    try:
        backup_dir = restore.resolve_backup_dir(config)
        restore.bundle_path(backup_dir, body.bundle)   # allowlist，只驗不取值
        dest_abs = restore.resolve_dest(body.dest, body.bundle)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return {
        "bundle": body.bundle,
        "dest": dest_abs,
        "dest_status": restore.check_dest(dest_abs, source_roots(config, scripts_root())),
    }


class DestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")  # ADR-0002：client 塞 plan 之類的欄位 → 422
    dest: str


# 模組保證 ValueError 內容是英文判別碼；不在此集合的 ValueError 只剩 AppConfig.load()
# 的剖析失敗（JSONDecodeError 是 ValueError 子類，訊息不可外洩當判別碼）。
_INSTALL_CLIENT_ERRORS = frozenset({
    "source_not_a_bundle", "invalid_config_dir", "unsafe_config_dir", "source_root_moved",
})


def _plan_or_error(dest: str) -> install.InstallPlan:
    """install-plan 與 install 共用：落點一律從**已落檔的 config.json** 讀。

    那份是使用者確認過的（走設定頁或票 07 的 adopt-config），不是 manifest 說的——
    這是 spec §4.2.2 授權模型的另一半：manifest 只能描述來源，不能授權目的地。"""
    config = AppConfig.load()                # ValueError 由呼叫端轉 config_unreadable 500
    return install.plan(dest, config.accounts)


@router.post("/api/restore/install-plan")
def install_plan(body: DestBody):
    """唯讀預覽：會裝幾項、跳過哪些、刻意不處理哪些。不動檔案系統。"""
    try:
        plan = _plan_or_error(body.dest)
    except ValueError as exc:
        if str(exc) in _INSTALL_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        return JSONResponse(status_code=500, content={"error": "config_unreadable"})
    return asdict(plan)


@router.post("/api/restore/install")
def install_route(body: DestBody):
    """實際寫入。server 以相同輸入**重算 plan**（ADR-0002，不吃 client 送來的 plan）。

    與共通設置／範本部署共用同一把 `setup_lock`：三者可能改寫同一批目錄，各自持鎖
    等於併發互踩。"""
    # 破壞性端點自己強制 readiness（與 common-config 的 apply／repair 同款閘）：config
    # 未落檔時 AppConfig.load() 會 fallback 到 DEFAULT_CONFIG（default=~/.claude），
    # bundle 的 manifest 含 "default" 帳號就會把備份內容寫進現役 Claude 目錄——「落點
    # 來自使用者確認過的 config.json」的前提在 fallback 下不成立。唯讀預覽不設此閘。
    if not default_config_path().exists():
        return JSONResponse(status_code=400, content={"error": "config_not_initialized"})
    try:
        with setup_lock:
            plan = _plan_or_error(body.dest)
            results = install.install(plan)
    except ValueError as exc:
        if str(exc) in _INSTALL_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        return JSONResponse(status_code=500, content={"error": "config_unreadable"})
    return {"results": [asdict(r) for r in results]}

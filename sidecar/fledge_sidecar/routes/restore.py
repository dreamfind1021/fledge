"""還原路由：備份包與展開位置的唯讀預覽。

**位置問題不是錯誤**（沿用 `routes/backup.py` 的取向）：一律 200 用 `dest_status` 旗標表達，
錯誤碼只留給請求本身壞掉（未知的備份包名、不是絕對路徑的展開位置）。塞進 HTTP 錯誤碼就只
剩「壞了」一個資訊，卡片沒辦法分辨「那個位置非空」與「選到現役資料裡面」。

實際的展開不在此處，走 `POST /api/sessions` 的 kind=restore（PTY 跑
`scripts/restore-claude.sh`）：那是長時間工作，而它的輸出本身就是使用者要看的差異報告。
本模組完全沒有寫入任何目錄的能力。
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.backup import restore
from fledge_sidecar.backup.containment import source_roots
from fledge_sidecar.backup.script import scripts_root

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

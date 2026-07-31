"""Setup 路由：開發環境偵測狀態（spec §5）＋雙帳號共通設置（spec §6.3）。

安裝／登入不在此處——走 POST /api/sessions 的 kind=install/login（spec §2 #13）。
"""
from __future__ import annotations

import threading
from dataclasses import asdict

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from fledge_sidecar.app_config import AppConfig, default_config_path
from fledge_sidecar.setup import common_config, templates
from fledge_sidecar.setup.env_detect import detect_all

router = APIRouter()

# 沿用 routes/config.py 的慣例：單 process 鎖序列化並發寫入（apply 會動 FS）
setup_lock = threading.Lock()


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
    # 破壞性端點自己強制 readiness：設定檔不存在時 AppConfig.load() 會 fallback 到
    # DEFAULT_CONFIG（default=~/.claude），未 onboard 的使用者一送出就會對真實 home
    # 目錄動手。唯讀預覽不設此閘（精靈要能先看狀態）。
    if not default_config_path().exists():
        return JSONResponse(status_code=400, content={"error": "config_not_initialized"})
    with setup_lock:
        try:
            result = _build_plan(body)
        except _PlanError as exc:
            return JSONResponse(status_code=exc.status, content={"error": exc.code})
        applied = common_config.apply(
            result, [(o.account, o.entry) for o in body.overwrite]
        )
    return {"results": [asdict(r) for r in applied.results]}


@router.post("/api/setup/common-config/repair")
def common_config_repair(body: CommonConfigBody):
    """修復共通設置的斷鏈（票 08 的 `repair`）：移機／還原後 target 帳號的連結全指著舊機器的
    絕對路徑，這裡拿同一份 entry allowlist 重新指向本機的 source。

    **與 `apply` 共用 `setup_lock`**：兩者改寫的是同一批 symlink，各自持鎖等於併發時互相踩。
    plan 同樣由 server 以相同輸入重算（ADR-0002）。body 不收 `overwrite`——repair 從不做破壞
    既有內容的動作，收那個欄位只會讓呼叫端以為它有效。"""
    # 與 apply 同一道 readiness 閘：設定檔不存在時 AppConfig.load() 會 fallback 到
    # DEFAULT_CONFIG（default=~/.claude），修復是會寫檔的動作，不能對真實 home 目錄動手。
    if not default_config_path().exists():
        return JSONResponse(status_code=400, content={"error": "config_not_initialized"})
    with setup_lock:
        try:
            result = _build_plan(body)
        except _PlanError as exc:
            return JSONResponse(status_code=exc.status, content={"error": exc.code})
        try:
            repaired = common_config.repair(result)
        except ValueError as exc:
            # 模組保證是英文判別碼（source_dir_missing／source_dir_unusable）。與
            # build_account_graph 的判別碼同樣走 400——都是「前提不成立」而非伺服端故障。
            return JSONResponse(status_code=400, content={"error": str(exc)})
    return {"results": [asdict(r) for r in repaired.results]}


class TemplateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")   # 未知欄位 → 422
    template: str
    destination: str


def _template_available(template_id: str) -> bool:
    """這個 build 是否真的內建了該範本（manifest 讀得出來才算）。"""
    try:
        templates.load_manifest(template_id)
    except ValueError:
        return False
    return True


@router.get("/api/setup/templates")
def list_templates():
    """列出 allowlist 內的所有範本；未內建者標 available=false 讓前端顯示「未內建」。"""
    return {"templates": [
        {
            "id": spec.id,
            "label": spec.label,
            "description": spec.description,
            "source_class": spec.source_class,
            "available": _template_available(spec.id),
        }
        for spec in templates.TEMPLATE_SPECS
    ]}


@router.post("/api/setup/templates/plan")
def templates_plan(body: TemplateBody):
    """唯讀預覽：回逐檔狀態與整體狀態，不動檔案系統。"""
    try:
        result = templates.plan(body.template, body.destination)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except OSError:
        # 探測期 FS 出狀況（目錄不可讀、競態中消失）：非 client 輸入錯誤，但仍回判別碼
        return JSONResponse(status_code=500, content={"error": "probe_failed"})
    return {
        "template": result.template,
        "destination": result.destination,
        "state": result.state,
        "operations": [asdict(o) for o in result.operations],
    }


@router.post("/api/setup/templates/deploy")
def templates_deploy(body: TemplateBody):
    """部署範本。plan 由 server 重算（不接受 client 傳入的 plan），寫入以 setup_lock 序列化。"""
    with setup_lock:
        try:
            result = templates.deploy(body.template, body.destination)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        except OSError:
            return JSONResponse(status_code=500, content={"error": "probe_failed"})
    return {
        "template": result.template,
        "destination": result.destination,
        "results": [asdict(r) for r in result.results],
    }

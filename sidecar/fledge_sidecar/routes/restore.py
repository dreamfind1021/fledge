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
from pydantic import BaseModel, ConfigDict, Field

from fledge_sidecar import app_config
from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.backup import install, restore
from fledge_sidecar.backup.containment import source_roots
from fledge_sidecar.backup.script import scripts_root
from fledge_sidecar.paths import expand_and_validate, probe_dir, resolve_best_effort
from fledge_sidecar.routes.config import _config_lock
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


class MappingEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    old: str
    new: str


class DestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")  # ADR-0002：client 塞 plan 之類的欄位 → 422
    dest: str
    # 專案路徑對應（票 06）：舊絕對路徑 → 使用者確認的新絕對路徑。驗證全在模組內
    # （絕對路徑／確實存在的專案／編碼碰撞），route 只轉譯。
    mapping: list[MappingEntry] = []


# 模組保證 ValueError 內容是英文判別碼；不在此集合的 ValueError 只剩 AppConfig.load()
# 的剖析失敗（JSONDecodeError 是 ValueError 子類，訊息不可外洩當判別碼）。
_INSTALL_CLIENT_ERRORS = frozenset({
    "source_not_a_bundle", "invalid_config_dir", "unsafe_config_dir", "source_root_moved",
    "invalid_account_key", "overlapping_config_dirs",
    "mapping_not_absolute", "mapping_collision", "mapping_unknown_project",
})


class AdoptAccount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str
    config_dir: str


class AdoptExtra(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    path: str


class AdoptRoot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    default_account: str


class AdoptConfigBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dest: str
    accounts: list[AdoptAccount] = Field(min_length=1)   # 落點是使用者的授權，必填
    roots: list[AdoptRoot] = []
    extra: list[AdoptExtra] = []


_ADOPT_CLIENT_ERRORS = frozenset({
    "source_not_a_bundle", "invalid_config_dir", "unsafe_config_dir",
    "invalid_account_key", "overlapping_config_dirs",
})


@router.post("/api/restore/adopt-config")
def adopt_config(body: AdoptConfigBody):
    """用備份包重建 config.json（票 07）。**落點由使用者逐項確認後送回**，server 全部
    重驗（spec §4.2.2：manifest 只能描述來源與建議值，不能授權目的地——限制前端送的
    欄位並不會讓不可信的資料源變可信）。

    不擴充 onboard：它的 first-run 語意是審查後刻意加的，且「採用備份包」與「手動
    onboard」是兩種語意。兩支共用 `create_if_absent` 原語與同一把 `_config_lock`
    （spec §4.3.1——各寫一份 first-run 判定必然漂移）。"""
    account_keys = [a.key for a in body.accounts]
    extra_names = [e.name for e in body.extra]
    # 同名重複＝「後蓋前」的授權歧義，直接拒——不讓 dict 建構默默挑一個
    if len(set(account_keys)) != len(account_keys):
        return JSONResponse(status_code=400, content={"error": "duplicate_account_key"})
    if len(set(extra_names)) != len(extra_names):
        return JSONResponse(status_code=400, content={"error": "duplicate_extra_name"})
    try:
        manifest = install.read_manifest(resolve_best_effort(body.dest))
        # 只採用備份包宣稱的成員——這是確認流的**輸入 hygiene**，不是把授權綁定到這份
        # bundle：config 落點授權的是「目的地」，install 對任意 bundle 一視同仁地靠
        # no-clobber／containment／provenance 防護（票 03 起的模型，正常 onboard 的
        # 使用者本來就能對任意 bundle 呼叫 install）。

        if not set(account_keys) <= set(manifest["accounts"]):
            return JSONResponse(status_code=400, content={"error": "unknown_account_key"})
        if not set(extra_names) <= set(manifest.get("extra", {})):
            return JSONResponse(status_code=400, content={"error": "unknown_extra_name"})
        install.validate_landing_spots(
            {**{a.key: a.config_dir for a in body.accounts},
             **{f"extra:{e.name}": e.path for e in body.extra}})
    except ValueError as exc:
        if str(exc) in _ADOPT_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        raise                               # read_manifest／validate 只拋判別碼，其餘不吞
    roots: list[tuple[str, str]] = []
    for r in body.roots:
        if r.default_account not in set(account_keys):
            return JSONResponse(status_code=400, content={"error": "unknown_account"})
        try:
            abs_ = expand_and_validate(r.path)
        except ValueError:
            return JSONResponse(status_code=400, content={"error": "invalid_root"})
        if probe_dir(abs_) in ("missing", "not_dir"):   # denied 放行，比照 onboard
            return JSONResponse(status_code=400, content={"error": "invalid_root"})
        roots.append((resolve_best_effort(abs_), r.default_account))

    def _build(config: AppConfig) -> None:
        config.accounts = {}                # 不留 DEFAULT_CONFIG 的 default 帳號
        for a in body.accounts:
            config.add_account(a.key, a.config_dir.strip(), "")   # 存 raw，比照帳號慣例
        for path, acct in roots:
            config.add_root(path, acct)
        config.extra = {e.name: e.path.strip() for e in body.extra}

    try:
        with _config_lock:
            config = app_config.create_if_absent(_build)
    except FileExistsError:
        return JSONResponse(status_code=409,
                            content={"error": "config_already_initialized"})
    return config.to_dict()


@router.get("/api/restore/project-paths")
def project_paths_route(dest: str):
    """唯讀（票 06）：備份包裡有哪些專案、各自的舊路徑（讀歷史檔 cwd——編碼不可逆，
    無法從目錄名反推）、建議的新路徑與其存在性。不動檔案系統。"""
    try:
        return {"projects": install.project_paths(dest)}
    except ValueError as exc:
        if str(exc) in _INSTALL_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        raise                               # 模組只拋判別碼，其餘不吞


@router.post("/api/restore/install-plan")
def install_plan(body: DestBody):
    """唯讀預覽：會裝幾項、跳過哪些、刻意不處理哪些。不動檔案系統。

    落點從 config.json 讀，不由前端送（spec §4.2.2：manifest 只能描述來源，不能授權
    目的地）。預覽沿用會 fallback 的 `AppConfig.load()`——與 common-config 的預覽同一
    慣例（精靈 pre-onboard 要能看狀態），fallback 下的探測全是唯讀 lstat。"""
    try:
        config = AppConfig.load()            # ValueError → 下方轉 config_unreadable 500
        # extra 落點同樣只來自 config（adopt-config 確認後寫入），不由前端送（票 07）
        plan = install.plan(body.dest, config.accounts, extra=config.extra,
                            mapping=[(m.old, m.new) for m in body.mapping])
    except ValueError as exc:
        if str(exc) in _INSTALL_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        return JSONResponse(status_code=500, content={"error": "config_unreadable"})
    return asdict(plan)


@router.post("/api/restore/install")
def install_route(body: DestBody):
    """實際寫入。server 以相同輸入**重算 plan**（ADR-0002，不吃 client 送來的 plan）。

    與共通設置／範本部署共用同一把 `setup_lock`：三者可能改寫同一批目錄，各自持鎖
    等於併發互踩。

    落點只能來自**使用者確認過的 config.json**，所以走 `load_existing`（單次讀取、
    永不 fallback）而非 exists→load 兩段式閘——後者在等鎖期間 config 被刪時仍會退回
    DEFAULT_CONFIG（default=~/.claude），把備份內容寫進現役 Claude 目錄（Codex 票 03
    R3／R4）。讀取放在鎖內，與寫入同一臨界區。唯讀預覽不設此限。"""
    try:
        with setup_lock:
            try:
                config = AppConfig.load_existing()
            except FileNotFoundError:
                return JSONResponse(status_code=400,
                                    content={"error": "config_not_initialized"})
            plan = install.plan(body.dest, config.accounts, extra=config.extra,
                                mapping=[(m.old, m.new) for m in body.mapping])
            results = install.install(plan)
    except ValueError as exc:
        if str(exc) in _INSTALL_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        return JSONResponse(status_code=500, content={"error": "config_unreadable"})
    return {"results": [asdict(r) for r in results]}

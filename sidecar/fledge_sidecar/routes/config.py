"""設定讀寫路由：細粒度寫入，每個操作在鎖內 load→驗證→改→save→回 updated config。spec §6.3 §7。"""
from __future__ import annotations

import re
import threading

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from fledge_sidecar import app_config
from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.backup.containment import check_backup_dir, source_roots
from fledge_sidecar.backup.script import scripts_root
from fledge_sidecar.paths import canonicalize, expand_and_validate, probe_dir, resolve_best_effort

router = APIRouter()

# 全域鎖：整個 load-mutate-save 是 critical section，避免並發請求互相覆蓋（Codex round 1 High）
_config_lock = threading.Lock()


class PathAccountBody(BaseModel):
    path: str
    account: str


class PathBody(BaseModel):
    path: str


class OnboardRoot(BaseModel):
    path: str
    default_account: str


class OnboardBody(BaseModel):
    roots: list[OnboardRoot]


class AccountBody(BaseModel):
    key: str
    config_dir: str
    label: str = ""


class AccountPatchBody(BaseModel):
    config_dir: str | None = None
    label: str | None = None


class AccountDeleteBody(BaseModel):
    reassign_to: str | None = None


class CheckDirBody(BaseModel):
    path: str


def _require_account(config: AppConfig, account: str) -> None:
    if account not in config.accounts:
        raise HTTPException(status_code=400, detail=f"unknown account: {account}")


def _canonical_or_400(raw: str) -> str:
    """移除/改帳號類：canonicalize（拒空/相對→400），不驗存在。"""
    try:
        return canonicalize(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _validated_dir_or_400(raw: str) -> str:
    """add 類三步：expand_and_validate（拒空/相對→400）→ probe_dir（missing/not_dir→400）
    → resolve_best_effort 回 canonical（denied 放行）。"""
    try:
        abs_ = expand_and_validate(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    st = probe_dir(abs_)
    if st == "missing":
        raise HTTPException(status_code=400, detail="找不到此資料夾")
    if st == "not_dir":
        raise HTTPException(status_code=400, detail="這不是資料夾")
    # denied（存在但 TCC 不可讀）仍放行：掃描器已 best-effort 容錯，強制拒絕反而讓使用者
    # 加不了受限目錄（如外接磁碟、受保護路徑）。設計決策見 path-normalization-design §3。
    return resolve_best_effort(abs_)


_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")  # account key 會進 URL path 與 env，限英數/底線/連字號


def _with_first_run(config: AppConfig) -> dict:
    """在 config dict 附上 is_first_run（= 設定檔尚未落地）。
    GET 時 load 不 save → 檔不存在 → True；任何寫入 save 後 → 檔存在 → False。無特例。"""
    return {**config.to_dict(), "is_first_run": not config.path.exists()}


@router.get("/api/config")
def get_config():
    return _with_first_run(AppConfig.load())


@router.post("/api/config/roots")
def add_root(body: PathAccountBody):
    path = _validated_dir_or_400(body.path)
    with _config_lock:
        config = AppConfig.load()
        _require_account(config, body.account)
        if any(r["path"] == path for r in config.roots):
            raise HTTPException(status_code=400, detail="duplicate root")
        config.add_root(path, body.account)
        config.save()
        return config.to_dict()


@router.delete("/api/config/roots")
def remove_root(body: PathBody):
    path = _canonical_or_400(body.path)
    with _config_lock:
        config = AppConfig.load()
        config.remove_root(path)
        config.save()
        return config.to_dict()


@router.patch("/api/config/roots")
def set_root_account(body: PathAccountBody):
    path = _canonical_or_400(body.path)
    with _config_lock:
        config = AppConfig.load()
        _require_account(config, body.account)
        config.set_root_account(path, body.account)
        config.save()
        return config.to_dict()


@router.post("/api/config/manual")
def add_manual(body: PathAccountBody):
    path = _validated_dir_or_400(body.path)
    with _config_lock:
        config = AppConfig.load()
        _require_account(config, body.account)
        if any(m["path"] == path for m in config.manual_projects):
            raise HTTPException(status_code=400, detail="duplicate manual project")
        config.add_manual(path, body.account)
        config.save()
        return config.to_dict()


@router.delete("/api/config/manual")
def remove_manual(body: PathBody):
    path = _canonical_or_400(body.path)
    with _config_lock:
        config = AppConfig.load()
        config.remove_manual(path)
        config.save()
        return config.to_dict()


@router.put("/api/config/overrides")
def set_override(body: PathAccountBody):
    path = _canonical_or_400(body.path)
    with _config_lock:
        config = AppConfig.load()
        _require_account(config, body.account)
        config.set_override(path, body.account)
        config.save()
        return config.to_dict()


@router.delete("/api/config/overrides")
def clear_override(body: PathBody):
    path = _canonical_or_400(body.path)
    with _config_lock:
        config = AppConfig.load()
        config.clear_override(path)
        config.save()
        return config.to_dict()


@router.post("/api/config/onboard")
def onboard(body: OnboardBody):
    """onboarding 完成：一次原子寫入多個根。任一帳號非法則整批不寫（save 前 raise）。

    first-run 判定走 `app_config.create_if_absent`（票 07，spec §4.3.1）：adopt-config
    也會建立同一個 config.json，兩支各寫一份判定必然漂移——漂移的樣態是一支擋住另一支
    放行、後寫者整份覆蓋前者。跨 process 的 save race 限制見原語 docstring／Plan 04。
    既有加根請走 POST /api/config/roots。"""
    if not body.roots:
        raise HTTPException(status_code=400, detail="onboard 需要至少一個根目錄")

    def _build(config: AppConfig) -> None:
        for r in body.roots:  # 先全驗證帳號，任一非法則整批不落檔（raise 在 save 前）
            _require_account(config, r.default_account)
        config.set_created_by({"source": "onboard"})   # 票 15：兩支都要記，否則不對稱
        seen: set[str] = set()
        for r in body.roots:
            path = _validated_dir_or_400(r.path)
            if path in seen or any(rt["path"] == path for rt in config.roots):
                continue  # 同批重複或已存在 → 略過
            seen.add(path)
            config.add_root(path, r.default_account)

    with _config_lock:
        try:
            config = app_config.create_if_absent(_build)
        except FileExistsError:
            raise HTTPException(status_code=409, detail="已完成初始設定，onboard 僅供首次初始化")
        return _with_first_run(config)


@router.post("/api/config/accounts")
def add_account(body: AccountBody):
    key = body.key.strip()
    if not _KEY_RE.match(key):
        raise HTTPException(status_code=400, detail="帳號代號只能含英數字、底線、連字號（會進 URL path 與 env）")
    config_dir = body.config_dir.strip()
    if not config_dir:
        raise HTTPException(status_code=400, detail="config_dir 不可為空")
    with _config_lock:
        config = AppConfig.load()
        if key in config.accounts:
            raise HTTPException(status_code=400, detail=f"帳號代號已存在: {key}")
        config.add_account(key, config_dir, body.label.strip())  # config_dir 存 raw（含 ~）
        config.save()
        return config.to_dict()


@router.patch("/api/config/accounts/{key}")
def patch_account(key: str, body: AccountPatchBody):
    with _config_lock:
        config = AppConfig.load()
        if key not in config.accounts:
            raise HTTPException(status_code=404, detail=f"unknown account: {key}")
        if body.config_dir is not None:
            config_dir = body.config_dir.strip()
            if not config_dir:
                raise HTTPException(status_code=400, detail="config_dir 不可為空")
            config.set_account_config_dir(key, config_dir)
        if body.label is not None:
            config.set_account_label(key, body.label.strip())
        config.save()
        return config.to_dict()


@router.delete("/api/config/accounts/{key}")
def delete_account(key: str, body: AccountDeleteBody):
    with _config_lock:
        config = AppConfig.load()
        if key not in config.accounts:
            raise HTTPException(status_code=404, detail=f"unknown account: {key}")
        if len(config.accounts) <= 1:
            raise HTTPException(status_code=400, detail="至少保留一個帳號")
        # reassign_to 給了就驗證合法（不論有無引用）：不可等於自己、必須存在
        if body.reassign_to is not None:
            if body.reassign_to == key or body.reassign_to not in config.accounts:
                raise HTTPException(status_code=400, detail=f"invalid reassign_to: {body.reassign_to}")
        refs = config.account_references(key)
        has_refs = bool(refs["roots"] or refs["manual"] or refs["overrides"])
        if has_refs and not body.reassign_to:
            raise HTTPException(status_code=400, detail=f"帳號 {key} 仍被引用，需指定 reassign_to")
        config.remove_account(key, body.reassign_to)
        config.save()
        return config.to_dict()


@router.post("/api/config/check-dir")
def check_dir(body: CheckDirBody):
    """查 config_dir 狀態（給前端 config_dir 警告用；不改任何狀態）。"""
    return {"status": probe_dir(body.path)}


class SubscriptionsBody(BaseModel):
    # `list[dict]` 這個註記是判準的一部分（非物件的 item → 422）：判準本體雖然搬進了
    # `normalize_subscription`，這一層不能拿掉——拿掉之後非物件會變成 400，對外行為就變了。
    subscriptions: list[dict]


# `normalize_subscription` 的判別碼 → 本端點的 400 文案。移機端（`adopt-config`）拿到同樣的
# 判別碼卻是丟棄該項——**判準共用、處置各自**（票 09）。`bad_shape` 在這裡被 Pydantic 先擋成
# 422 走不到，仍列出來：少一個 key 會變成 KeyError 裸 500。
_SUBSCRIPTION_DETAIL = {
    "bad_shape": "訂閱項目須為物件",
    "bad_cost": "monthly_cost 須為數字",
    "bad_values": "name 不可為空、monthly_cost 不可為負或非有限值",
}


@router.put("/api/config/subscriptions")
def put_subscriptions(body: SubscriptionsBody):
    cleaned = []
    for s in body.subscriptions:
        try:
            cleaned.append(app_config.normalize_subscription(s))
        except ValueError as exc:
            raise HTTPException(status_code=400,
                                detail=_SUBSCRIPTION_DETAIL[str(exc)]) from exc
    with _config_lock:
        config = AppConfig.load()
        config.subscriptions = cleaned
        config.save()
        return config.to_dict()


class KmsRootBody(BaseModel):
    path: str = ""


@router.put("/api/config/kms-root")
def put_kms_root(body: KmsRootBody):
    """設 KMS（Obsidian 知識庫）根目錄。存 raw（含 ~，掃描時才展開）；空字串＝清除。
    不驗目錄存在——掃描器查無目錄回 [] 即可（spec：保持簡單）。"""
    with _config_lock:
        config = AppConfig.load()
        config.set_kms_root(body.path)
        config.save()
        return {"ok": True, "kms_root": config.kms_root}


class BackupDirBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = ""


@router.put("/api/config/backup-dir")
def put_backup_dir(body: BackupDirBody):
    """設備份輸出目錄。存 raw（含 ~）；空字串＝清除。不驗目錄存在——存在與否
    交給 `GET /api/backup/status` 的 `dir_status` 表達，卡片才能說明是哪一種異常。

    但**相對路徑必須擋**：備份跑在家目錄、sidecar 的 cwd 是別的地方，`"foo"` 會讓
    「檢查的目錄」與「實際寫入的目錄」變成兩個不同的地方，探測與 UI 顯示同時失真。

    錯誤走 `JSONResponse({"error": code})` 而非本檔其他地方的 `HTTPException(detail=…)`：
    前端讀的是 `error` 欄位，且判別碼必須是穩定英文碼、不能像既有 detail 那樣夾中文
    prose（CLAUDE.md §4.6.13）。"""
    raw = (body.path or "").strip()
    abs_path: str | None = None
    if raw:  # 空字串＝清除，不必驗
        try:
            abs_path = expand_and_validate(raw)
        except ValueError:
            return JSONResponse(status_code=400, content={"error": "backup_dir_invalid"})
    with _config_lock:
        config = AppConfig.load()
        if abs_path is not None:
            # 存檔時的 containment 檢查是 UX：錯誤在使用者按下選擇器的當場出現。
            # 真正的守門在 spawn 前（備份執行票）——存檔時合法的值之後可能變得不合法，
            # 最常見的是新增了一個 config_dir 剛好包住它的帳號。
            verdict = check_backup_dir(abs_path, source_roots(config, scripts_root()))
            if verdict != "ok":
                return JSONResponse(status_code=400, content={"error": f"backup_dir_{verdict}"})
        config.set_backup_dir(raw)
        config.save()
        return {"ok": True, "backup_dir": config.backup_dir}

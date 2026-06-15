from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.dir_tree import list_dir_entries
from fledge_sidecar.paths import expand_and_validate, is_within_any_root, probe_dir, resolve_best_effort
from fledge_sidecar.project_scanner import scan_all, scan_root

router = APIRouter()


class PreviewBody(BaseModel):
    path: str


@router.get("/api/projects")
def list_projects():
    config = AppConfig.load()
    projects, permission_error = scan_all(config)
    return {"projects": projects, "permission_error": permission_error}


@router.post("/api/projects/scan-preview")
def scan_preview(body: PreviewBody):
    """試掃單一路徑回專案數（不落檔）。回 status 判別碼，讓 onboarding 在加入 draft 前
    就知道路徑能不能用（與 add 驗證對齊；onboard 原子、一個 typo 整批失敗）。
    status ∈ ok|denied|missing|not_dir|invalid。"""
    try:
        abs_ = expand_and_validate(body.path)
    except ValueError:
        return {"path": "", "count": 0, "status": "invalid"}  # 空/相對
    st = probe_dir(abs_)  # 先分類（與 paths.py 原則一致：probe 在 resolve 前）
    canonical = resolve_best_effort(abs_)  # 永不 raise
    if st in ("missing", "not_dir"):
        return {"path": canonical, "count": 0, "status": st}
    if st == "denied":
        return {"path": canonical, "count": 0, "status": "denied"}
    try:  # st == "dir" → 實際試掃
        count = len(scan_root(Path(abs_), ""))
        return {"path": canonical, "count": count, "status": "ok"}
    except PermissionError:  # stat 過但 iterdir 不可讀
        return {"path": canonical, "count": 0, "status": "denied"}
    except OSError:
        return {"path": canonical, "count": 0, "status": "missing"}


class TreeBody(BaseModel):
    path: str


@router.post("/api/projects/tree")
def project_tree(body: TreeBody):
    """列單層目錄（lazy 檔案樹）。containment 順序固定：expand → realpath → 限 allowed roots。
    回 status：ok（200）/ invalid（400）/ forbidden（403）/ denied|missing|not_dir（200）。
    設計見 docs/planning/sidebar-tree-and-tab-dnd-design.md §7.1。"""
    try:
        abs_ = expand_and_validate(body.path)
    except ValueError:
        raise HTTPException(status_code=400, detail={"status": "invalid"})

    real = resolve_best_effort(abs_)  # 永不 raise；支援不存在 leaf（§7.1 R3-F2）
    config = AppConfig.load()

    # allowed roots = roots ∪ manual（config 已 canonical，再 resolve 一次保險）。
    # 不特別 deny kms_root：它可同時是 sidebar 專案（如「創意發想」既是 KMS vault 又是工作專案），
    # 使用者有權瀏覽其檔案樹。containment（限 allowed roots＝使用者自己的 roots/manual）是唯一且
    # 足夠的安全邊界——撤銷 PR review F1 的 kms deny（基於「kms 與專案互斥」的錯誤假設，見 spec §15）。
    roots = [resolve_best_effort(r["path"]) for r in config.roots]
    roots += [resolve_best_effort(m["path"]) for m in config.manual_projects]
    if not is_within_any_root(real, roots):
        raise HTTPException(status_code=403, detail={"status": "forbidden"})

    # probe + 列出（內容層錯誤回 200 帶 status，§7.1 L2）
    st = probe_dir(abs_)
    if st in ("missing", "not_dir", "denied"):
        return {"path": real, "entries": [], "status": st}
    try:
        return {"path": real, "entries": list_dir_entries(Path(abs_)), "status": "ok"}
    except PermissionError:
        return {"path": real, "entries": [], "status": "denied"}
    except OSError:
        return {"path": real, "entries": [], "status": "missing"}

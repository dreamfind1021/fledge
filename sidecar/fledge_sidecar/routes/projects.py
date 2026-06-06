from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.paths import expand_and_validate, probe_dir, resolve_best_effort
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

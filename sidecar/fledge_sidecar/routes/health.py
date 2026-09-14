import shutil

from fastapi import APIRouter

from fledge_sidecar import __version__

router = APIRouter()


@router.get("/api/health")
def health():
    # claude_found：前端用來判斷是否顯示「請先安裝 Claude Code」引導（spec §9 #1）
    return {"ok": True, "version": __version__, "claude_found": shutil.which("claude") is not None}

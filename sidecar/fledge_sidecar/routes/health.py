import shutil

from fastapi import APIRouter

from fledge_sidecar import __version__

router = APIRouter()


@router.get("/api/health")
def health():
    # claude_found：前端用來判斷是否顯示「請先安裝 Claude Code」引導（spec §9 #1）。
    # agents：每個 agent CLI 一個布林（Pi 作為第二種 agent，spec 2026-10-29 §6.1 #6）；claude_found 保留。
    agents = {name: shutil.which(name) is not None for name in ("claude", "pi")}
    return {"ok": True, "version": __version__, "claude_found": agents["claude"], "agents": agents}

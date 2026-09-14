import shutil

from fastapi import APIRouter

from fledge_sidecar import __version__
from fledge_sidecar.api.codex_usage import tls_context

router = APIRouter()


@router.get("/api/health")
def health():
    # claude_found：前端用來判斷是否顯示「請先安裝 Claude Code」引導（spec §9 #1）
    # tls_ca_certs：成品自檢用（release CI 把系統憑證路徑指向不存在處後讀它，見 tls_context）——
    # CI 沒有 auth.json 也沒網路可打 Codex，這是唯一不用登入就能證明 cacert.pem 有打進成品的地方
    return {
        "ok": True,
        "version": __version__,
        "claude_found": shutil.which("claude") is not None,
        "tls_ca_certs": len(tls_context().get_ca_certs()),
    }

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from fledge_sidecar import auth
from fledge_sidecar.routes import config, health, projects, sessions, usage

logger = logging.getLogger(__name__)


class TokenAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # 真 preflight（OPTIONS + Access-Control-Request-Method）放行交給 CORS；
        # preflight 不帶自訂 header，擋它會讓帶 X-Fledge-Token 的 fetch 永遠發不出。
        # 註：Starlette Headers 的 in/get 是 case-insensitive，故小寫 key 比對安全（Codex PR L3）。
        if request.method == "OPTIONS" and "access-control-request-method" in request.headers:
            return await call_next(request)
        if not auth.token_ok(request.headers.get("X-Fledge-Token")):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    # shutdown：關所有 PTY session，避免 claude 子進程 orphan
    sessions.close_all_sessions()


def create_app() -> FastAPI:
    app = FastAPI(title="Fledge Sidecar", lifespan=_lifespan)
    # 啟動 log：說清楚目前認證狀態（fail-closed 漏設要醒目）
    if auth.auth_disabled():
        logger.warning("FLEDGE_TEST_UNAUTH=1：sidecar 以【無認證】模式啟動，僅供測試/手動執行")
    elif auth.configured_token() is None:
        logger.error("FLEDGE_TOKEN 未設定且未 opt-out：所有請求將回 401（production 應由 Tauri 殼注入 token）")

    # 先掛 auth、再掛 CORS → CORS 在最外層（add_middleware 後加者外層）。CORS 在外有兩個作用：
    # (1) preflight 由 CORS 短路、不進 auth；(2) auth 回的 401 也會帶上 CORS 標頭，否則 webview
    # 看到的是 CORS error 而非 401、難以除錯。
    app.add_middleware(TokenAuthMiddleware)
    app.add_middleware(
        CORSMiddleware,
        # dev vite + Tauri prod webview origin。tauri://localhost（macOS）與 https://tauri.localhost
        # 都列入：Tauri v2 不同平台/版本 prod origin 不一，列錯會讓正式版 webview 讀不到回應而打不開。
        # 實際 prod origin 必須在 E2E 確認（dev 的 localhost:1420 確定）。
        allow_origins=["http://localhost:1420", "tauri://localhost", "https://tauri.localhost"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health.router)
    app.include_router(projects.router)
    app.include_router(sessions.router)
    app.include_router(config.router)
    app.include_router(usage.router)
    return app

"""sidecar 認證：per-launch token（fail-closed 預設 + FLEDGE_TEST_UNAUTH opt-out）。
所有函式在 call time 讀 os.environ（不快取），讓測試可動態切換。
設計見 docs/planning/auth-token-cors-design.md。"""
from __future__ import annotations

import hmac
import os


def auth_disabled() -> bool:
    """明確 opt-out（測試/手動執行）：FLEDGE_TEST_UNAUTH=1。"""
    return os.environ.get("FLEDGE_TEST_UNAUTH") == "1"


def configured_token() -> str | None:
    """sidecar 端設定的 token；空字串視同未設。"""
    tok = os.environ.get("FLEDGE_TOKEN")
    return tok or None


def token_ok(provided: str | None) -> bool:
    """fail-closed：opt-out → 放行；沒設 token 又沒 opt-out → 拒絕；否則 constant-time 比對。"""
    if auth_disabled():
        return True
    tok = configured_token()
    if tok is None:
        return False  # fail-closed：漏設 token 不會靜默全開
    return provided is not None and hmac.compare_digest(provided, tok)


def require_ws_token(websocket) -> bool:
    """WS 共用驗證：所有 @router.websocket 入口都該呼叫，避免未來新增漏驗。"""
    return token_ok(websocket.query_params.get("token"))

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from fledge_sidecar import auth
from fledge_sidecar.app import create_app


def test_token_ok_opt_out(monkeypatch):
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    monkeypatch.delenv("FLEDGE_TOKEN", raising=False)
    assert auth.token_ok(None) is True
    assert auth.token_ok("anything") is True


def test_token_ok_fail_closed_when_no_token_no_optout(monkeypatch):
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.delenv("FLEDGE_TOKEN", raising=False)
    assert auth.token_ok(None) is False
    assert auth.token_ok("anything") is False


def test_token_ok_enforced(monkeypatch):
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    assert auth.token_ok("secret") is True
    assert auth.token_ok("wrong") is False
    assert auth.token_ok(None) is False


def test_configured_token_empty_is_none(monkeypatch):
    monkeypatch.setenv("FLEDGE_TOKEN", "")
    assert auth.configured_token() is None


def _enforce(monkeypatch):
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")


def test_http_requires_token(monkeypatch):
    _enforce(monkeypatch)
    client = TestClient(create_app())
    assert client.get("/api/health").status_code == 401
    assert client.get("/api/health", headers={"X-Fledge-Token": "wrong"}).status_code == 401
    assert client.get("/api/health", headers={"X-Fledge-Token": "secret"}).status_code == 200


def test_http_fail_closed_when_no_token(monkeypatch):
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.delenv("FLEDGE_TOKEN", raising=False)
    client = TestClient(create_app())
    assert client.get("/api/health").status_code == 401  # 漏設 token → 全 401、非全開


def test_opt_out_opens(monkeypatch):
    # 預設 conftest 已設 FLEDGE_TEST_UNAUTH=1 → 開放
    client = TestClient(create_app())
    assert client.get("/api/health").status_code == 200


def test_simple_request_no_preflight_blocked(monkeypatch):
    # 威脅核心：惡意網頁送 simple request（text/plain、不觸發 preflight）、無 token → 全 401
    _enforce(monkeypatch)
    client = TestClient(create_app())
    h = {"Origin": "http://evil.test", "Content-Type": "text/plain"}
    for path in ("/api/sessions", "/api/config/onboard", "/api/config/accounts",
                 "/api/config/roots", "/api/config/manual", "/api/projects/scan-preview"):
        r = client.post(path, headers=h, content="{}")
        assert r.status_code == 401, path


def test_true_preflight_not_blocked(monkeypatch):
    _enforce(monkeypatch)
    client = TestClient(create_app())
    # 真 preflight：OPTIONS + Access-Control-Request-Method、無 token → 不 401
    r = client.options("/api/health", headers={
        "Origin": "http://localhost:1420",
        "Access-Control-Request-Method": "GET",
    })
    assert r.status_code == 200  # CORS 對合法 preflight 回 200（不被 auth 攔）
    # 一般 OPTIONS（無該 header）、無 token → 仍 401
    assert client.options("/api/health").status_code == 401


def test_cors_origin_tightened(monkeypatch):
    _enforce(monkeypatch)
    client = TestClient(create_app())
    r = client.get("/api/health", headers={"X-Fledge-Token": "secret", "Origin": "http://localhost:1420"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:1420"


def test_ws_requires_token(tmp_path, monkeypatch):
    _enforce(monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    cfg = tmp_path / "config.json"
    cfg.write_text('{"version":1,"roots":[],"accounts":{"work":{"config_dir":"/tmp/x","label":"w"}},'
                   '"manual_projects":[],"project_overrides":{},"ui":{}}', encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    client = TestClient(create_app())
    sid = client.post("/api/sessions", headers={"X-Fledge-Token": "secret"},
                      json={"path": str(tmp_path), "account": "work"}).json()["session_id"]
    # 無 token query → handshake 被拒（close 1008）
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/{sid}"):
            pass
    # 帶正確 token query → 能連
    with client.websocket_connect(f"/ws/{sid}?token=secret") as ws:
        ws.send_bytes(b"hi\n")
        assert b"hi" in ws.receive_bytes()
    client.delete(f"/api/sessions/{sid}", headers={"X-Fledge-Token": "secret"})


def test_only_one_ws_route_all_guarded():
    # 路由完整性：未來新增 @router.websocket 要記得走 require_ws_token，且要在 accept 之前。
    src = Path(__file__).resolve().parents[1] / "fledge_sidecar" / "routes" / "sessions.py"
    text = src.read_text(encoding="utf-8")
    assert len(re.findall(r"@router\.websocket", text)) == 1
    assert "require_ws_token" in text
    # guard 必須在 accept 之前（文字順序檢查）
    assert text.index("require_ws_token") < text.index("websocket.accept()")

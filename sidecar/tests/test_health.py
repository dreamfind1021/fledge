from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app


def test_health_returns_ok():
    client = TestClient(create_app())
    resp = client.get("/api/health")
    assert resp.status_code == 200
    # 用包含關係斷言，允許回應有額外 key（例如 claude_found）
    body = resp.json()
    assert body["ok"] is True
    assert body["version"] == "1.5.0"


def test_cors_headers_present():
    # CORS 收緊後回應的是具體 origin、不再是 *（Tauri webview 跨 origin fetch 仍需 ACAO 才讀得到回應）
    client = TestClient(create_app())
    resp = client.get("/api/health", headers={"Origin": "http://localhost:1420"})
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:1420"
    assert resp.headers.get("access-control-allow-origin") != "*"


def test_health_reports_claude_found(monkeypatch):
    import fledge_sidecar.routes.health as health_mod
    from fastapi.testclient import TestClient
    from fledge_sidecar.app import create_app

    monkeypatch.setattr(health_mod.shutil, "which", lambda _: "/usr/local/bin/claude")
    body = TestClient(create_app()).get("/api/health").json()
    assert body["claude_found"] is True

    monkeypatch.setattr(health_mod.shutil, "which", lambda _: None)
    body = TestClient(create_app()).get("/api/health").json()
    assert body["claude_found"] is False

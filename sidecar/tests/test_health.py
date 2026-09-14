from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app


def test_health_returns_ok():
    client = TestClient(create_app())
    resp = client.get("/api/health")
    assert resp.status_code == 200
    # 用包含關係斷言，允許回應有額外 key（例如 claude_found）
    body = resp.json()
    assert body["ok"] is True
    assert body["version"] == "1.7.0"


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


def test_health_reports_tls_ca_certs_independent_of_system_paths(tmp_path, monkeypatch):
    """release CI 的自檢入口（2026-09-14 根因）：打包版 OpenSSL 編死的憑證路徑在使用者機器
    不存在。CI 沒有 auth.json 也沒有網路可打 Codex，需要一個不用登入就能證明
    「成品真的帶了根憑證」的地方——health 回載到的 CA 張數，CI 起成品時把系統路徑指向
    不存在的地方再讀它。這裡同樣模擬：預設 context 必須是 0 張（模擬成立），health 仍 >100。"""
    import ssl
    monkeypatch.setenv("SSL_CERT_FILE", str(tmp_path / "nope.pem"))
    monkeypatch.setenv("SSL_CERT_DIR", str(tmp_path / "nope"))
    assert len(ssl.create_default_context().get_ca_certs()) == 0
    body = TestClient(create_app()).get("/api/health").json()
    assert isinstance(body["tls_ca_certs"], int) and body["tls_ca_certs"] > 100

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from fledge_sidecar.app import create_app


@pytest.fixture(autouse=True)
def _clear_shared_bridge():
    from fledge_sidecar.routes import sessions as sr
    sr._bridge.close_all()
    yield
    sr._bridge.close_all()


def _write_config(tmp_path: Path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(
        json.dumps(
            {
                "version": 1,
                "roots": [],
                "accounts": {"work": {"config_dir": "/tmp/fake-claude", "label": "工作"}},
                "manual_projects": [],
                "project_overrides": {},
                "ui": {"theme": "dark"},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg_path))


def test_create_session_then_ws_echo(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    # 測試模式用 cat 取代 claude，透過 env 指示（見實作 Step 3）
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")

    client = TestClient(create_app())
    resp = client.post(
        "/api/sessions",
        json={"path": str(tmp_path), "account": "work"},
    )
    assert resp.status_code == 200
    body = resp.json()
    session_id = body["session_id"]
    assert body["ws_url"] == f"/ws/{session_id}"

    with client.websocket_connect(f"/ws/{session_id}") as ws:
        ws.send_bytes(b"ping\n")
        data = ws.receive_bytes()
        assert b"ping" in data

    # 關閉
    resp = client.delete(f"/api/sessions/{session_id}")
    assert resp.status_code == 200


def test_ws_disconnect_keeps_session(tmp_path: Path, monkeypatch):
    # 模式 A：WS 斷線不關 session（session 生命週期歸前端 store、由 DELETE 關）
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    from fledge_sidecar.routes.sessions import _bridge

    client = TestClient(create_app())
    resp = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"})
    session_id = resp.json()["session_id"]

    with client.websocket_connect(f"/ws/{session_id}") as ws:
        ws.send_bytes(b"hi\n")
        ws.receive_bytes()
    # WS 斷線後 session 仍存在（不像 plan-01 #3 會被關掉）
    assert session_id in _bridge.sessions
    # 只有 DELETE 才關閉
    resp = client.delete(f"/api/sessions/{session_id}")
    assert resp.status_code == 200
    assert session_id not in _bridge.sessions


def test_resize_session(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    client = TestClient(create_app())
    resp = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"})
    sid = resp.json()["session_id"]

    resp = client.post(f"/api/sessions/{sid}/resize", json={"rows": 40, "cols": 120})
    assert resp.status_code == 200
    assert resp.json() == {"resized": sid, "rows": 40, "cols": 120}

    client.delete(f"/api/sessions/{sid}")


def test_ws_pty_eof_closes_4001_and_cleans_session(tmp_path: Path, monkeypatch):
    """claude 退出（PTY EOF）→ WS 以 code 4001 關閉、dead session 從 bridge 清掉。"""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "true")  # 立刻退出 → PTY EOF
    from fledge_sidecar.routes.sessions import _bridge

    client = TestClient(create_app())
    resp = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"})
    session_id = resp.json()["session_id"]

    with client.websocket_connect(f"/ws/{session_id}") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            # process 已退出 → server pump 偵測 is_alive False → close 4001
            while True:
                ws.receive_bytes()
        assert exc.value.code == 4001
    # dead session 已被清（不需等 DELETE）
    assert session_id not in _bridge.sessions


def test_close_all_sessions_uses_shared_bridge(tmp_path):
    from fledge_sidecar.routes import sessions as sr
    s = sr._bridge.create_session(command=["cat"], cwd=str(tmp_path), env_overrides={})
    assert s.session_id in sr._bridge.sessions
    sr.close_all_sessions()
    assert sr._bridge.sessions == {}


def test_app_lifespan_shutdown_closes_sessions(tmp_path):
    from fastapi.testclient import TestClient
    from fledge_sidecar.app import create_app
    from fledge_sidecar.routes import sessions as sr
    s = sr._bridge.create_session(command=["cat"], cwd=str(tmp_path), env_overrides={})
    with TestClient(create_app()):
        assert s.session_id in sr._bridge.sessions
    assert sr._bridge.sessions == {}

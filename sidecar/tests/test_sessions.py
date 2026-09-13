import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace

import anyio
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


def _capture_bridge_create(monkeypatch, session_id: str) -> dict:
    """monkeypatch 共用 bridge 的 create_session（不真的開 PTY），回傳捕捉 kwargs 的 dict。"""
    captured = {}

    def _fake_create_session(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(session_id=session_id)

    from fledge_sidecar.routes import sessions as sr
    monkeypatch.setattr(sr._bridge, "create_session", _fake_create_session)
    return captured


def _try_recv_message(ws, timeout: float):
    """有限等待 app→client 訊息；逾時回 None。透過 TestClient 的 portal 包 anyio.move_on_after
    取內部 _send_rx：逾時以 cancel 結束 receive、不消耗訊息、不留 orphan thread（之後 receive_bytes
    仍能正常收）。回傳原始 ASGI message dict 或 None。"""
    async def _recv():
        with anyio.move_on_after(timeout):
            return await ws._send_rx.receive()
        return None
    return ws.portal.call(_recv)


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


def test_apply_flow_control_pause_clears_gate():
    from fledge_sidecar.routes.sessions import _apply_flow_control
    gate = asyncio.Event()
    gate.set()
    _apply_flow_control(json.dumps({"type": "pause"}), gate)
    assert not gate.is_set()  # pause → 停讀


def test_apply_flow_control_resume_sets_gate():
    from fledge_sidecar.routes.sessions import _apply_flow_control
    gate = asyncio.Event()
    gate.clear()
    _apply_flow_control(json.dumps({"type": "resume"}), gate)
    assert gate.is_set()  # resume → 恢復讀


def test_apply_flow_control_unknown_type_noop():
    from fledge_sidecar.routes.sessions import _apply_flow_control
    gate = asyncio.Event()
    gate.set()
    _apply_flow_control(json.dumps({"type": "bogus"}), gate)
    assert gate.is_set()  # 未知 type：不動 gate、不拋（向前相容）


def test_apply_flow_control_bad_json_noop():
    from fledge_sidecar.routes.sessions import _apply_flow_control
    gate = asyncio.Event()
    gate.clear()
    _apply_flow_control("not json at all", gate)
    assert not gate.is_set()  # 壞 JSON：不動 gate、不拋


def test_apply_flow_control_non_object_noop():
    from fledge_sidecar.routes.sessions import _apply_flow_control
    gate = asyncio.Event()
    gate.set()
    _apply_flow_control("123", gate)  # 合法 JSON 但非物件
    assert gate.is_set()  # 非 dict：不動 gate、不拋


def test_flow_pause_actually_gates_pty_to_ws(tmp_path: Path, monkeypatch):
    """pause 真的閘住 PTY→WS：暫停期間 server 不交付輸出，resume 後才補送。
    核心防呆——漏掉 pump 的 flow_gate.wait() 時，唯獨此測試會失敗（design §9「pause 後 server 停送」）。"""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    client = TestClient(create_app())
    sid = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"}).json()["session_id"]

    with client.websocket_connect(f"/ws/{sid}") as ws:
        ws.send_bytes(b"first\n")
        assert b"first" in ws.receive_bytes()  # baseline：未暫停 echo 正常
        # drain 掉 baseline 殘留的 echo chunk，回到 quiet（否則殘留會被後面誤判成 held 漏出）
        while _try_recv_message(ws, 0.3) is not None:
            pass
        # 送 pause 後 sleep > read_nonblocking 的 poll timeout(0.2s)：讓任何「已通過 gate、正卡在
        # select」的在途 read 先返回、pump 卡回「已 clear」的 gate。否則該在途 read 會讀到隨後寫入的
        # held（design §9「在途 ≤1 chunk」），正確實作下仍偽失敗。time.sleep 在測試 thread；
        # TestClient 的 app 跑在另一條 portal thread，不阻塞 server。
        ws.send_text(json.dumps({"type": "pause"}))
        time.sleep(0.35)
        ws.send_bytes(b"held\n")
        # 此刻 pump 已確定阻塞在 gate → held echo 不被讀 → 有界視窗內必為 None
        assert _try_recv_message(ws, 0.5) is None
        # resume → 暫停期間累積的輸出補送（證明解閘）
        ws.send_text(json.dumps({"type": "resume"}))
        data = b""
        while b"held" not in data:
            data += ws.receive_bytes()

    client.delete(f"/api/sessions/{sid}")


def test_flow_pause_resume_roundtrip_no_data_loss(tmp_path: Path, monkeypatch):
    """pause/resume 一個週期不破壞 echo、不丟資料：暫停期間的輸出 resume 後完整補送。"""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    client = TestClient(create_app())
    sid = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"}).json()["session_id"]

    with client.websocket_connect(f"/ws/{sid}") as ws:
        ws.send_bytes(b"first\n")
        assert b"first" in ws.receive_bytes()
        ws.send_text(json.dumps({"type": "pause"}))
        ws.send_bytes(b"second\n")
        ws.send_text(json.dumps({"type": "resume"}))
        # `first\n` 會產生兩份輸出（tty 回顯 + cat 的輸出），有時合在一個訊框、有時分兩個；
        # 分兩個時上面那次 receive 只吃掉回顯，這裡第一個訊框是 cat 的 `first` 而不是 `second`。
        # 所以累積讀到 `second` 出現為止（同 test_flow_pause_holds_output 的寫法），設上限避免
        # 真的丟資料時掛住。
        data = b""
        for _ in range(10):
            data += ws.receive_bytes()
            if b"second" in data:
                break
        assert b"second" in data

    client.delete(f"/api/sessions/{sid}")


def test_flow_text_frame_never_reaches_pty(tmp_path: Path, monkeypatch):
    """安全不變式：text 控制 frame 不被當輸入寫進 PTY（否則 cat 會 echo 出 JSON）。"""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    client = TestClient(create_app())
    sid = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"}).json()["session_id"]

    with client.websocket_connect(f"/ws/{sid}") as ws:
        ws.send_text(json.dumps({"type": "pause"}))
        ws.send_text(json.dumps({"type": "resume"}))  # 回到可讀
        ws.send_bytes(b"clean\n")
        data = ws.receive_bytes()
        # 若 JSON 被誤寫進 cat，第一個 chunk 會是 echo 出來的 JSON（含 "type"）
        assert b"clean" in data
        assert b"type" not in data

    client.delete(f"/api/sessions/{sid}")


def test_flow_bad_control_frame_does_not_disconnect(tmp_path: Path, monkeypatch):
    """壞 JSON / 未知 type 不斷線：之後仍能正常雙向通訊。"""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    client = TestClient(create_app())
    sid = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"}).json()["session_id"]

    with client.websocket_connect(f"/ws/{sid}") as ws:
        ws.send_text("not json")
        ws.send_text(json.dumps({"type": "bogus"}))
        ws.send_bytes(b"alive\n")
        assert b"alive" in ws.receive_bytes()  # 連線仍活著

    client.delete(f"/api/sessions/{sid}")


def test_flow_paused_pty_eof_still_closes_4001(tmp_path: Path, monkeypatch):
    """paused 中 PTY EOF：pump 仍在 ≤1s 內醒來偵測 is_alive False → 清 session + close 4001。"""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    from fledge_sidecar.routes.sessions import _bridge

    client = TestClient(create_app())
    sid = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"}).json()["session_id"]

    with client.websocket_connect(f"/ws/{sid}") as ws:
        ws.send_text(json.dumps({"type": "pause"}))  # 閘住 PTY→WS
        ws.send_bytes(b"\x04")  # Ctrl-D：cat 在行首讀到 EOF → 退出 → PTY master EOF
        with pytest.raises(WebSocketDisconnect) as exc:
            while True:
                ws.receive_bytes()
        assert exc.value.code == 4001
    assert sid not in _bridge.sessions


def test_resolve_command_terminal_returns_login_shell(monkeypatch):
    from fledge_sidecar.routes.sessions import _resolve_command
    monkeypatch.setenv("SHELL", "/bin/bash")
    assert _resolve_command("terminal") == ["/bin/bash", "-l"]


def test_resolve_command_terminal_fallback_when_no_shell(monkeypatch):
    from fledge_sidecar.routes.sessions import _resolve_command
    monkeypatch.delenv("SHELL", raising=False)
    assert _resolve_command("terminal") == ["/bin/zsh", "-l"]


def test_resolve_command_claude_default(monkeypatch):
    from fledge_sidecar.routes.sessions import _resolve_command
    monkeypatch.delenv("FLEDGE_TEST_COMMAND", raising=False)
    assert _resolve_command("claude") == ["claude"]


def test_resolve_command_test_command_only_affects_claude(monkeypatch):
    from fledge_sidecar.routes.sessions import _resolve_command
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "cat")
    monkeypatch.setenv("SHELL", "/bin/bash")
    assert _resolve_command("claude") == ["cat"]           # claude 受測試命令影響
    assert _resolve_command("terminal") == ["/bin/bash", "-l"]  # terminal 不受影響


def test_create_session_passes_terminal_command(tmp_path, monkeypatch):
    """POST kind=terminal → create_session 收到 [$SHELL, -l]。用 spy 攔命令、實際以 cat 起無害 session。"""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setenv("SHELL", "/bin/bash")
    from fledge_sidecar.routes import sessions as sr
    captured = {}
    real = sr._bridge.create_session

    def spy(command, **kw):
        captured["command"] = command
        return real(command=["cat"], **kw)  # 用 cat 起真 Session、避免 spawn 互動 shell

    monkeypatch.setattr(sr._bridge, "create_session", spy)
    client = TestClient(create_app())
    resp = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work", "kind": "terminal"})
    assert resp.status_code == 200
    assert captured["command"] == ["/bin/bash", "-l"]
    client.delete(f"/api/sessions/{resp.json()['session_id']}")


def test_create_session_defaults_to_claude_when_kind_omitted(tmp_path, monkeypatch):
    """不傳 kind → 預設 claude（向後相容）。"""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.delenv("FLEDGE_TEST_COMMAND", raising=False)
    from fledge_sidecar.routes import sessions as sr
    captured = {}
    real = sr._bridge.create_session

    def spy(command, **kw):
        captured["command"] = command
        return real(command=["cat"], **kw)

    monkeypatch.setattr(sr._bridge, "create_session", spy)
    client = TestClient(create_app())
    resp = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work"})
    assert resp.status_code == 200
    assert captured["command"] == ["claude"]
    client.delete(f"/api/sessions/{resp.json()['session_id']}")


def test_create_session_unknown_account_400(tmp_path, monkeypatch):
    import json
    from pathlib import Path
    from fastapi.testclient import TestClient
    from fledge_sidecar.app import create_app
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "roots": [], "manual_projects": [],
        "project_overrides": {}, "ui": {}, "subscriptions": [],
        "accounts": {"work": {"config_dir": str(tmp_path / "c"), "label": "工作"}}}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    monkeypatch.setenv("FLEDGE_ACCOUNT_ACTIVITY", str(tmp_path / "activity.jsonl"))
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "true")
    with TestClient(create_app()) as client:
        r = client.post("/api/sessions", json={"path": str(tmp_path), "account": "nope", "kind": "claude"})
        assert r.status_code == 400
        assert not (tmp_path / "activity.jsonl").exists() or \
               (tmp_path / "activity.jsonl").read_text() == ""


def test_create_claude_session_records_open(tmp_path, monkeypatch):
    import json
    from fastapi.testclient import TestClient
    from fledge_sidecar.app import create_app
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "roots": [], "manual_projects": [],
        "project_overrides": {}, "ui": {}, "subscriptions": [],
        "accounts": {"work": {"config_dir": str(tmp_path / "c"), "label": "工作"}}}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    monkeypatch.setenv("FLEDGE_ACCOUNT_ACTIVITY", str(tmp_path / "activity.jsonl"))
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "true")
    with TestClient(create_app()) as client:
        r = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work", "kind": "claude"})
        assert r.status_code == 200
        sid = r.json()["session_id"]
    events = [json.loads(l) for l in (tmp_path / "activity.jsonl").read_text().splitlines() if l.strip()]
    opens = [e for e in events if e["event"] == "open"]
    assert len(opens) == 1
    assert opens[0]["account"] == "work" and opens[0]["session"] == sid
    from pathlib import Path
    assert opens[0]["project"] == str(Path(tmp_path).resolve())


def test_terminal_session_does_not_record(tmp_path, monkeypatch):
    import json
    from fastapi.testclient import TestClient
    from fledge_sidecar.app import create_app
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "roots": [], "manual_projects": [],
        "project_overrides": {}, "ui": {}, "subscriptions": [],
        "accounts": {"work": {"config_dir": str(tmp_path / "c"), "label": "工作"}}}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    monkeypatch.setenv("FLEDGE_ACCOUNT_ACTIVITY", str(tmp_path / "activity.jsonl"))
    with TestClient(create_app()) as client:
        r = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work", "kind": "terminal"})
        assert r.status_code == 200
    assert not (tmp_path / "activity.jsonl").exists() or \
           (tmp_path / "activity.jsonl").read_text() == ""


def test_spawn_failure_records_close(tmp_path, monkeypatch):
    # SC6a：spawn 失敗 → open 後立即補 close（不留 phantom live span）
    import json
    from fastapi.testclient import TestClient
    from fledge_sidecar.app import create_app
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "roots": [], "manual_projects": [],
        "project_overrides": {}, "ui": {}, "subscriptions": [],
        "accounts": {"work": {"config_dir": str(tmp_path / "c"), "label": "工作"}}}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    monkeypatch.setenv("FLEDGE_ACCOUNT_ACTIVITY", str(tmp_path / "activity.jsonl"))
    monkeypatch.setenv("FLEDGE_TEST_COMMAND", "/nonexistent/binary/xyz")   # PtyProcess.spawn 拋 FileNotFoundError
    with TestClient(create_app(), raise_server_exceptions=False) as client:
        r = client.post("/api/sessions", json={"path": str(tmp_path), "account": "work", "kind": "claude"})
        assert r.status_code == 500   # spawn 失敗重拋 → 500
    events = [json.loads(l) for l in (tmp_path / "activity.jsonl").read_text().splitlines() if l.strip()]
    opens = [e for e in events if e["event"] == "open"]
    closes = [e for e in events if e["event"] == "close"]
    assert len(opens) == 1 and len(closes) == 1
    assert closes[0]["session"] == opens[0]["session"]


def test_install_session_rejects_unknown_id(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.post("/api/sessions", json={
        "path": str(tmp_path), "account": "work", "kind": "install",
        "install_id": "rm-rf-slash",
    })
    assert resp.status_code == 400
    assert resp.json()["error"] == "unknown_install_id"


def test_install_session_uses_allowlist_command_no_account_env(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    captured = _capture_bridge_create(monkeypatch, "sess-install")
    # 用已知 id（node）；命令應來自 install_specs，而非請求帶入
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": str(tmp_path), "account": "work", "kind": "install", "install_id": "node",
    })
    assert resp.status_code == 200
    # 命令是 [shell, "-lc", "brew install node"]，不是請求傳入的字串
    assert captured["command"][-1] == "brew install node"
    assert captured["command"][-2] == "-lc"
    # 安裝 session：env_overrides 不含 CLAUDE_CONFIG_DIR，且要求移除它
    assert "CLAUDE_CONFIG_DIR" not in captured["env_overrides"]
    assert "CLAUDE_CONFIG_DIR" in (captured.get("env_remove") or [])
    # 安裝跑在 home、不在專案目錄；不傳 account（不歸屬）（plan review #5）
    assert captured["cwd"] == str(Path.home())
    assert captured["project_path"] == str(tmp_path)
    assert "account" not in captured


def test_session_rejects_unknown_field_fail_closed(tmp_path: Path, monkeypatch):
    # spec §9 驗收：注入 raw command 應被拒（extra="forbid" → 422），plan review #1
    _write_config(tmp_path, monkeypatch)
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": str(tmp_path), "account": "work", "command": "rm -rf /",
    })
    assert resp.status_code == 422


def test_codex_login_needs_no_account_and_no_claude_env(tmp_path: Path, monkeypatch):
    # codex 登入是全域的（不分帳號，B-1 收尾票已確認）：不驗帳號、不注入 CLAUDE_CONFIG_DIR，
    # 比照 kind=install。否則前端只能借一個帳號去通過驗證，等於把 workaround 固化在 UI。
    _write_config(tmp_path, monkeypatch)
    captured = _capture_bridge_create(monkeypatch, "sess-codex")
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "kind": "login", "login_target": "codex",
    })
    assert resp.status_code == 200
    assert captured["command"] == ["codex", "login"]
    assert captured["cwd"] == str(Path.home())
    assert "CLAUDE_CONFIG_DIR" not in captured["env_overrides"]
    assert "CLAUDE_CONFIG_DIR" in (captured.get("env_remove") or [])
    assert "account" not in captured          # 不歸屬、不綁帳號


def test_claude_login_still_requires_valid_account(tmp_path: Path, monkeypatch):
    # 只有 codex 目標免帳號；claude 登入的重點就是寫進「哪一個」帳號的 config_dir
    _write_config(tmp_path, monkeypatch)
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "account": "nope", "kind": "login", "login_target": "claude",
    })
    assert resp.status_code == 400
    assert resp.json()["error"] == "unknown_account"


def test_login_session_runs_in_home_not_project(tmp_path: Path, monkeypatch):
    # 登入不屬於任何專案（它也刻意不進活動歸屬），而精靈的登入頁根本沒有專案路徑可傳——
    # 沿用 cwd=req.path 的話前端只能編一個假路徑，空字串則直接 spawn 失敗。與 kind=install 一致跑在 home。
    _write_config(tmp_path, monkeypatch)
    captured = _capture_bridge_create(monkeypatch, "sess-login-home")
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "account": "work", "kind": "login",
    })
    assert resp.status_code == 200
    assert captured["cwd"] == str(Path.home())
    # 帳號 env 仍要注入（登入的重點就是寫進該帳號的 config_dir）
    assert captured["env_overrides"]["CLAUDE_CONFIG_DIR"] == "/tmp/fake-claude"


def test_login_session_injects_account_env_claude(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    captured = _capture_bridge_create(monkeypatch, "sess-login")
    from fledge_sidecar.routes import sessions as sr
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": str(tmp_path), "account": "work", "kind": "login", "login_target": "claude",
    })
    assert resp.status_code == 200
    assert captured["command"] == ["claude"]
    # 登入 session：注入該帳號 CLAUDE_CONFIG_DIR（_write_config 設 work=/tmp/fake-claude）
    assert captured["env_overrides"]["CLAUDE_CONFIG_DIR"] == "/tmp/fake-claude"
    # login 不是 claude → 不歸屬（不進 _opened_session_ids），與 terminal 對稱（plan review #6）
    assert captured["session_id"] not in sr._opened_session_ids


def test_login_session_codex_target_runs_codex_login(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    captured = _capture_bridge_create(monkeypatch, "sess-login2")
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": str(tmp_path), "account": "work", "kind": "login", "login_target": "codex",
    })
    assert resp.status_code == 200
    assert captured["command"] == ["codex", "login"]


def test_login_session_unknown_account_400(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": str(tmp_path), "account": "ghost", "kind": "login",
    })
    assert resp.status_code == 400
    assert resp.json()["error"] == "unknown_account"


# ── kind=backup（票 05）────────────────────────────────────────────────────────


def _backup_config(tmp_path: Path, monkeypatch, backup_dir: str, with_script: bool = True) -> None:
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({
        "version": 1, "roots": [],
        "accounts": {"default": {"config_dir": str(tmp_path / "claude"), "label": ""}},
        "backup_dir": backup_dir,
    }), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    scripts = tmp_path / "scripts"
    scripts.mkdir(exist_ok=True)
    if with_script:
        (scripts / "backup-claude.sh").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(scripts))


def _post_backup(client, mode: str | None = "run"):
    body = {"path": "", "kind": "backup"}
    if mode is not None:
        body["backup_mode"] = mode
    return client.post("/api/sessions", json=body)


def _capture_create(captured: dict):
    class _Session:
        session_id = "test-backup-session"

    def _create(**kwargs):
        captured.update(kwargs)
        return _Session()

    return _create


def test_backup_session_rejects_injected_command(tmp_path: Path, monkeypatch):
    """安全不變式：未知欄位一律擋掉，命令字串永遠不可能從前端進來。"""
    out = tmp_path / "backups"
    out.mkdir()
    _backup_config(tmp_path, monkeypatch, backup_dir=str(out))
    client = TestClient(create_app())
    resp = client.post("/api/sessions", json={
        "path": "", "kind": "backup", "backup_mode": "run", "command": "rm -rf /",
    })
    assert resp.status_code == 422


def test_backup_session_rejects_unknown_mode(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    _backup_config(tmp_path, monkeypatch, backup_dir=str(out))
    assert _post_backup(TestClient(create_app()), mode="wipe").status_code == 422


def test_backup_session_requires_mode(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    _backup_config(tmp_path, monkeypatch, backup_dir=str(out))
    resp = _post_backup(TestClient(create_app()), mode=None)
    assert resp.status_code == 400
    assert resp.json()["error"] == "backup_mode_required"


def test_backup_session_blocked_when_not_configured(tmp_path: Path, monkeypatch):
    _backup_config(tmp_path, monkeypatch, backup_dir="")
    resp = _post_backup(TestClient(create_app()))
    assert resp.status_code == 400
    assert resp.json()["error"] == "backup_dir_not_set"


def test_backup_session_blocked_on_relative_path(tmp_path: Path, monkeypatch):
    _backup_config(tmp_path, monkeypatch, backup_dir="foo")
    resp = _post_backup(TestClient(create_app()))
    assert resp.json()["error"] == "backup_dir_invalid"


def test_backup_session_blocked_when_inside_source(tmp_path: Path, monkeypatch):
    """spawn 前的閘才是真正的守門：存檔時合法的值可能因為新增帳號而變得不合法。"""
    inside = tmp_path / "claude" / "projects" / "backups"
    inside.mkdir(parents=True)
    _backup_config(tmp_path, monkeypatch, backup_dir=str(inside))
    resp = _post_backup(TestClient(create_app()))
    assert resp.json()["error"] == "backup_dir_inside_source"


def test_backup_session_blocked_when_dir_missing(tmp_path: Path, monkeypatch):
    _backup_config(tmp_path, monkeypatch, backup_dir=str(tmp_path / "gone"))
    resp = _post_backup(TestClient(create_app()))
    assert resp.json()["error"] == "backup_dir_unusable"


def test_backup_session_blocked_when_script_missing(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    _backup_config(tmp_path, monkeypatch, backup_dir=str(out), with_script=False)
    resp = _post_backup(TestClient(create_app()))
    assert resp.json()["error"] == "backup_script_missing"


def test_backup_session_blocked_when_python3_missing(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    _backup_config(tmp_path, monkeypatch, backup_dir=str(out))
    monkeypatch.setattr("fledge_sidecar.routes.sessions.python3_available", lambda: False)
    resp = _post_backup(TestClient(create_app()))
    assert resp.json()["error"] == "python3_missing"


def test_backup_session_gate_order_matches_card(tmp_path: Path, monkeypatch):
    """多個阻斷條件同時成立時回優先序最前的——卡片顯示的修復指引必須與後端
    下一個會擋的東西一致。"""
    _backup_config(tmp_path, monkeypatch, backup_dir="", with_script=False)
    monkeypatch.setattr("fledge_sidecar.routes.sessions.python3_available", lambda: False)
    assert _post_backup(TestClient(create_app())).json()["error"] == "backup_dir_not_set"


def test_backup_session_spawns_with_backend_built_argv(tmp_path: Path, monkeypatch):
    """成功路徑：跑的是後端組的 argv（前端沒有任何影響力），且不綁帳號。"""
    out = tmp_path / "My Backups"  # 含空白，驗證不經 shell
    out.mkdir()
    _backup_config(tmp_path, monkeypatch, backup_dir=str(out))
    captured: dict = {}
    monkeypatch.setattr(
        "fledge_sidecar.routes.sessions._bridge.create_session", _capture_create(captured)
    )
    resp = _post_backup(TestClient(create_app()), mode="list")
    assert resp.status_code == 200
    assert captured["command"][0] == "/bin/bash"
    assert str(out) in captured["command"]
    assert captured["command"][-1] == "--list"
    assert captured["cwd"] == str(Path.home())
    assert captured["env_overrides"] == {}
    assert "CLAUDE_CONFIG_DIR" in captured["env_remove"]

import time

from fledge_sidecar.pty_bridge import PtyBridge


def test_create_and_echo_roundtrip(tmp_path):
    bridge = PtyBridge()
    # 用 cat 當假命令：寫進去什麼就回什麼
    session = bridge.create_session(
        command=["cat"],
        cwd=str(tmp_path),
        env_overrides={},
    )
    assert session.session_id in bridge.sessions

    bridge.write(session.session_id, b"hello\n")
    time.sleep(0.2)
    output = bridge.read_nonblocking(session.session_id)
    assert b"hello" in output

    bridge.close_session(session.session_id)
    assert session.session_id not in bridge.sessions


def test_write_to_missing_session_is_silent():
    bridge = PtyBridge()
    bridge.write("no-such-session", b"data")  # 不拋例外即通過


def test_has_session_and_is_alive_on_missing():
    bridge = PtyBridge()
    assert bridge.has_session("nope") is False
    assert bridge.is_alive("nope") is False


def test_env_overrides_passed(tmp_path):
    bridge = PtyBridge()
    # 用 sh 印出環境變數驗證 CLAUDE_CONFIG_DIR 有傳進去
    session = bridge.create_session(
        command=["sh", "-c", "echo CFG=$CLAUDE_CONFIG_DIR; sleep 0.3"],
        cwd=str(tmp_path),
        env_overrides={"CLAUDE_CONFIG_DIR": "/tmp/fake-claude"},
    )
    time.sleep(0.3)
    output = bridge.read_nonblocking(session.session_id)
    assert b"CFG=/tmp/fake-claude" in output
    bridge.close_session(session.session_id)


def test_close_session_closes_pty_fd(tmp_path):
    # close_session 必須關閉 PTY master fd（用 close 而非只 terminate），
    # 否則每開關一個 session 漏一個 fd，最終撞 EMFILE（Codex 對抗式審查 HIGH）。
    bridge = PtyBridge()
    session = bridge.create_session(
        command=["cat"], cwd=str(tmp_path), env_overrides={}
    )
    assert session.pty.fd >= 0  # fd 開著
    bridge.close_session(session.session_id)
    assert session.pty.fd == -1  # close() 會把 fd 設 -1；terminate() 不會


def test_close_all_closes_every_session(tmp_path):
    bridge = PtyBridge()
    s1 = bridge.create_session(command=["cat"], cwd=str(tmp_path), env_overrides={})
    s2 = bridge.create_session(command=["cat"], cwd=str(tmp_path), env_overrides={})
    assert len(bridge.sessions) == 2
    bridge.close_all()
    assert bridge.sessions == {}
    assert s1.pty.fd == -1 and s2.pty.fd == -1  # close() 把 fd 設 -1


def test_close_all_is_best_effort_when_one_fails(tmp_path):
    bridge = PtyBridge()
    good = bridge.create_session(command=["cat"], cwd=str(tmp_path), env_overrides={})

    class _BadPty:
        fd = 7
        def close(self, force=False):
            raise OSError("boom")

    from fledge_sidecar.pty_bridge import Session
    bridge.sessions["bad"] = Session(session_id="bad", pty=_BadPty())  # type: ignore[arg-type]
    bridge.close_all()  # 不應拋
    assert bridge.sessions == {}
    assert good.pty.fd == -1


def test_create_session_strips_secrets_from_child_env(monkeypatch):
    from fledge_sidecar import pty_bridge

    captured = {}

    class _FakePty:
        def isalive(self):
            return True

    def _fake_spawn(command, cwd, env):
        captured["env"] = env
        return _FakePty()

    monkeypatch.setattr(pty_bridge.PtyProcess, "spawn", staticmethod(_fake_spawn))
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")

    bridge = pty_bridge.PtyBridge()
    # 連 caller 若不慎在 overrides 傳入 secret 也要被剔除（最終 env 剔除）
    bridge.create_session(command=["x"], cwd=".",
                          env_overrides={"CLAUDE_CONFIG_DIR": "/tmp/cc", "FLEDGE_TOKEN": "sneaky"})
    env = captured["env"]
    assert "FLEDGE_TOKEN" not in env
    assert "FLEDGE_TEST_UNAUTH" not in env
    assert env["CLAUDE_CONFIG_DIR"] == "/tmp/cc"  # 正常 override 仍在

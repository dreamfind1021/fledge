"""Codex 帳號每日用量的背景更新（spec 5.4、§6-6／8／9）：routes/usage.py 的 refresh／poller 與 app lifespan。"""
import json
import os
import signal
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app
from fledge_sidecar.routes import usage as usage_route
from fledge_sidecar.usage import codex_account_store

_SIDECAR_ROOT = Path(__file__).parents[1]
LIVE = {"source": "live", "account_key": "acc-1", "daily": {"2026-10-21": 5}, "default_model": "gpt-6.1-sol"}


def _poll_threads():
    return [t for t in threading.enumerate() if t.name == "codex-account-poll"]


# ---- refresh_codex_account_usage：抓一次、併進歷史檔 ----

def test_refresh_merges_into_history(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_CODEX_ACCOUNT_USAGE", str(tmp_path / "h.json"))
    monkeypatch.setenv("FLEDGE_CODEX_HOME", str(tmp_path / "codex"))
    homes = []
    monkeypatch.setattr(usage_route, "fetch_codex_account_usage", lambda home, **kw: homes.append(home) or LIVE)
    usage_route.refresh_codex_account_usage()
    h = codex_account_store.load(tmp_path / "h.json")
    assert h.accounts == {"acc-1": {"2026-10-21": 5}} and h.default_model == "gpt-6.1-sol"
    assert [f["count"] for f in h.fetches] == [1]
    assert homes == [tmp_path / "codex"]                  # 跟儀表板讀同一個 codex home


@pytest.mark.parametrize("reason", ["bad_response", "no_auth", "network"])
def test_refresh_failure_writes_nothing(tmp_path: Path, monkeypatch, reason):
    """§6-6：沒有 accountId（bad_response）等失敗 → 那一輪不寫入任何東西，已存的資料不動。"""
    p = tmp_path / "h.json"
    monkeypatch.setenv("FLEDGE_CODEX_ACCOUNT_USAGE", str(p))
    monkeypatch.setattr(usage_route, "fetch_codex_account_usage",
                        lambda home, **kw: {"source": "unavailable", "failure_reason": reason, "observed_at": None})
    usage_route.refresh_codex_account_usage()
    assert list(tmp_path.iterdir()) == []                 # 沒有檔案時不建檔、也不建鎖
    codex_account_store.merge(p, "acc-1", {"2026-10-20": 1}, None, now=1.0)
    before = p.read_bytes()
    usage_route.refresh_codex_account_usage()
    assert p.read_bytes() == before


# ---- poller 與 lifespan ----

def test_test_env_never_starts_the_poller(monkeypatch):
    """§6-9：conftest 預設設了 FLEDGE_TEST_NO_CODEX_POLL；app 啟動時不起背景工作，碰不到真的 ~/.codex。"""
    assert os.environ.get("FLEDGE_TEST_NO_CODEX_POLL")
    monkeypatch.setattr(usage_route, "CODEX_ACCOUNT_FIRST_DELAY_SEC", 0)
    calls = []
    monkeypatch.setattr(usage_route, "refresh_codex_account_usage", lambda: calls.append(1))
    with TestClient(create_app()):
        time.sleep(0.3)
        assert _poll_threads() == []
    assert calls == []


def test_first_fetch_waits_for_the_delay(monkeypatch):
    """啟動後先等一段時間才抓第一次；還沒到就關閉，一次都不抓。"""
    monkeypatch.delenv("FLEDGE_TEST_NO_CODEX_POLL")
    monkeypatch.setattr(usage_route, "CODEX_ACCOUNT_FIRST_DELAY_SEC", 1.0)
    calls = []
    monkeypatch.setattr(usage_route, "refresh_codex_account_usage", lambda: calls.append(1))
    with TestClient(create_app()):
        time.sleep(0.2)
        assert len(_poll_threads()) == 1
    time.sleep(1.2)
    assert calls == []


def test_poller_repeats_survives_errors_and_stops_on_shutdown(monkeypatch):
    monkeypatch.delenv("FLEDGE_TEST_NO_CODEX_POLL")
    monkeypatch.setattr(usage_route, "CODEX_ACCOUNT_FIRST_DELAY_SEC", 0)
    monkeypatch.setattr(usage_route, "CODEX_ACCOUNT_INTERVAL_SEC", 0.02)
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise OSError("disk full")
    monkeypatch.setattr(usage_route, "refresh_codex_account_usage", flaky)
    with TestClient(create_app()):
        deadline = time.monotonic() + 5
        while len(calls) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(calls) >= 3                             # 第一輪拋例外，之後照樣繼續
    time.sleep(0.2)
    assert _poll_threads() == []                            # 關閉後執行緒結束
    n = len(calls)
    time.sleep(0.2)
    assert len(calls) == n                                  # 也不再抓


def test_shutdown_does_not_wait_for_an_inflight_fetch(monkeypatch):
    """§6-8：背景查詢在跑的時候關閉，lifespan 不等它。"""
    monkeypatch.delenv("FLEDGE_TEST_NO_CODEX_POLL")
    monkeypatch.setattr(usage_route, "CODEX_ACCOUNT_FIRST_DELAY_SEC", 0)
    started, release = threading.Event(), threading.Event()

    def blocking():
        started.set()
        release.wait(10)
    monkeypatch.setattr(usage_route, "refresh_codex_account_usage", blocking)
    try:
        with TestClient(create_app()):
            assert started.wait(5)
            t0 = time.monotonic()
        assert time.monotonic() - t0 < 1.0, "lifespan 關閉時等了在途的查詢"
    finally:
        release.set()


_SIDECAR_CHILD = textwrap.dedent('''
    from fledge_sidecar.routes import usage
    usage.CODEX_ACCOUNT_FIRST_DELAY_SEC = 0                  # 不等 1 分鐘，啟動就抓
    from fledge_sidecar.__main__ import main
    main()
''')


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_sigterm_with_inflight_fetch_exits_fast_and_ends_app_server(tmp_path: Path, fake_codex):
    """§6-8、spec 5.4：背景查詢卡在 app-server 時收到 SIGTERM（Tauri 關 Fledge 的方式），sidecar 照樣很快結束
    （Tauri 等 3 秒就 SIGKILL，來不及跑 close_all_sessions），在途的 app-server 也跟著結束。真的 sidecar 入口＋假 codex。"""
    script, out, home = fake_codex
    marker = tmp_path / "usage-asked"
    env = {k: v for k, v in os.environ.items() if k != "FLEDGE_TEST_NO_CODEX_POLL"}
    env |= {"PYTHONPATH": str(_SIDECAR_ROOT), "PYTHONDONTWRITEBYTECODE": "1",
            "PATH": f"{script.parent}{os.pathsep}{env['PATH']}", "FLEDGE_CODEX_HOME": str(home),
            "FLEDGE_CONFIG_PATH": str(tmp_path / "config.json"),
            "FLEDGE_CODEX_ACCOUNT_USAGE": str(tmp_path / "h.json"),
            "FAKE_CODEX_MODE": "hang-usage", "FAKE_CODEX_MARKER": str(marker)}
    p = subprocess.Popen([sys.executable, "-c", _SIDECAR_CHILD], cwd=_SIDECAR_ROOT, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 15
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert marker.exists()                               # 背景查詢已經卡在 account/usage/read
        app_server = json.loads(out.read_text())["pid"]
        t0 = time.monotonic()
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            pass
        assert p.poll() is not None and time.monotonic() - t0 < 2.5
        deadline = time.monotonic() + 3
        while _alive(app_server) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _alive(app_server)
        assert not (tmp_path / "h.json").exists()            # 沒抓完就不寫
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()

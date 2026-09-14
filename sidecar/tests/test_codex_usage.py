"""api/codex_usage.py——Codex 實時額度改走 `codex app-server` JSON-RPC（design：docs/planning/codex-usage-app-server-design.md）。

三層：normalize_rate_limits（純函式）／fetch_codex_usage（注入假 session）／AppServerSession（假 codex 腳本，真子進程）。
替身講的是我們自己定義的協定——真 CLI 改版替身照樣綠，所以另有人工發行驗收（design §3）。"""
import json
import os
import stat
import sys
import time
from pathlib import Path

import pytest

from fledge_sidecar.api import codex_usage
from fledge_sidecar.api.codex_usage import RpcError


# ---- normalize_rate_limits（純函式：account/rateLimits/read 的 result → live payload）----

def _rl(plan="plus", p_pct=70, s_pct=42):
    return {
        "rateLimits": {
            "limitId": "codex", "planType": plan,
            "primary": {"usedPercent": p_pct, "windowDurationMins": 300, "resetsAt": 1789408745},
            "secondary": {"usedPercent": s_pct, "windowDurationMins": 10080, "resetsAt": 1789839716},
        },
        "rateLimitsByLimitId": {},
    }


def test_normalize_full_result_to_live():
    out = codex_usage.normalize_rate_limits(_rl(), now=1000.0)
    assert out["source"] == "live"
    assert out["observed_at"] == 1000.0
    assert out["plan_type"] == "plus"
    assert out["primary"] == {"used_percent": 70.0, "window_minutes": 300, "resets_at": 1789408745.0}
    assert out["secondary"]["window_minutes"] == 10080       # 前端靠 window_minutes 判 5h／週，不按位置


def test_normalize_missing_rate_limits_is_bad_response():
    out = codex_usage.normalize_rate_limits({"rateLimitsByLimitId": {}}, now=1.0)
    assert out["source"] == "unavailable" and out["failure_reason"] == "bad_response"


def test_normalize_missing_primary_is_bad_response():
    """協定標 experimental：欄位改名時要回 bad_response，不能給錯數字。"""
    out = codex_usage.normalize_rate_limits({"rateLimits": {"planType": "plus", "secondary": {"usedPercent": 1}}}, now=1.0)
    assert out["source"] == "unavailable" and out["failure_reason"] == "bad_response"


def test_normalize_secondary_optional():
    r = _rl(); r["rateLimits"]["secondary"] = None
    out = codex_usage.normalize_rate_limits(r, now=1.0)
    assert out["source"] == "live" and "secondary" not in out


# ---- fetch_codex_usage（閘門 ＋ 失敗碼對應；session 注入，不起子進程）----

class _FakeSession:
    """吃 {method: result 或 Exception}；記下呼叫順序與是否被關掉。"""
    def __init__(self, responses):
        self.responses, self.calls, self.closed = responses, [], False
    def call(self, method, params):
        self.calls.append(method)
        r = self.responses[method]
        if isinstance(r, Exception):
            raise r
        return r
    def close(self):
        self.closed = True


CHATGPT = {"account": {"type": "chatgpt", "email": "x@y", "planType": "plus"}, "requiresOpenaiAuth": True}


def _fetch(tmp_path, responses, *, which=lambda name: "/opt/homebrew/bin/codex", home_exists=True):
    home = tmp_path / ".codex"
    if home_exists:
        home.mkdir(parents=True)
    session = _FakeSession(responses)
    out = codex_usage.fetch_codex_usage(home, now=5.0, session_factory=lambda: session, which=which)
    return out, session


def test_fetch_success_is_live_and_closes_session(tmp_path: Path):
    out, s = _fetch(tmp_path, {"account/read": CHATGPT, "account/rateLimits/read": _rl(p_pct=7)})
    assert out["source"] == "live" and out["primary"]["used_percent"] == 7.0
    assert s.calls == ["account/read", "account/rateLimits/read"]  # 先驗登入再問額度
    assert s.closed


def test_fetch_home_dir_missing_is_no_auth_without_spawning(tmp_path: Path):
    """空目錄會讓 app-server 建一整套 sqlite；目錄不在＝從沒用過 codex，直接 no_auth。"""
    spawned = []
    home = tmp_path / ".codex"
    out = codex_usage.fetch_codex_usage(home, now=1.0, session_factory=lambda: spawned.append(1), which=lambda n: "/x/codex")
    assert out["failure_reason"] == "no_auth" and spawned == []


def test_fetch_codex_binary_missing_is_no_codex_without_spawning(tmp_path: Path):
    spawned = []
    (tmp_path / ".codex").mkdir()
    out = codex_usage.fetch_codex_usage(tmp_path / ".codex", now=1.0, session_factory=lambda: spawned.append(1), which=lambda n: None)
    assert out["failure_reason"] == "no_codex" and spawned == []


def test_fetch_not_logged_in_is_no_auth_and_skips_rate_limits(tmp_path: Path):
    """未登入時 rateLimits/read 會掛 20 秒（實測），閘門必須在 account/read 就擋下。"""
    out, s = _fetch(tmp_path, {"account/read": {"account": None, "requiresOpenaiAuth": True}, "account/rateLimits/read": _rl()})
    assert out["failure_reason"] == "no_auth"
    assert s.calls == ["account/read"] and s.closed


def test_fetch_api_key_auth_is_unsupported_auth(tmp_path: Path):
    out, s = _fetch(tmp_path, {"account/read": {"account": {"type": "apiKey"}}, "account/rateLimits/read": _rl()})
    assert out["failure_reason"] == "unsupported_auth" and s.calls == ["account/read"]


def test_fetch_rpc_error_with_401_is_unauthorized(tmp_path: Path):
    err = RpcError(-32603, "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body=...")
    out, s = _fetch(tmp_path, {"account/read": CHATGPT, "account/rateLimits/read": err})
    assert out["failure_reason"] == "unauthorized" and s.closed


def test_fetch_other_rpc_error_is_bad_response(tmp_path: Path):
    out, _ = _fetch(tmp_path, {"account/read": CHATGPT, "account/rateLimits/read": RpcError(-32601, "method not found")})
    assert out["failure_reason"] == "bad_response"


def test_fetch_timeout_or_eof_is_network(tmp_path: Path):
    out, s = _fetch(tmp_path, {"account/read": CHATGPT, "account/rateLimits/read": TimeoutError()})
    assert out["failure_reason"] == "network" and s.closed
    out, _ = _fetch(tmp_path / "second", {"account/read": OSError("stdout closed")})
    assert out["failure_reason"] == "network"


def test_fetch_session_factory_failure_is_network(tmp_path: Path):
    (tmp_path / ".codex").mkdir()
    def boom():
        raise OSError("spawn failed")
    out = codex_usage.fetch_codex_usage(tmp_path / ".codex", now=1.0, session_factory=boom, which=lambda n: "/x/codex")
    assert out["failure_reason"] == "network"


# ---- AppServerSession（真子進程 ＋ 假 codex 腳本）----

FAKE_CODEX = r'''#!%(py)s
import json, os, sys, time
mode = os.environ.get("FAKE_CODEX_MODE", "normal")
out = os.environ.get("FAKE_CODEX_OUT")
if out:
    with open(out, "w") as f:
        json.dump({"pid": os.getpid(), "CODEX_HOME": os.environ.get("CODEX_HOME"), "argv": sys.argv[1:]}, f)
if mode == "silent":
    time.sleep(60); sys.exit(0)
def emit(o): sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    try: m = json.loads(line)
    except json.JSONDecodeError: continue
    if "id" not in m: continue                          # 通知（initialized）不回
    if mode == "noise":
        sys.stdout.write("warning: something on stdout\n"); sys.stdout.flush()
        emit({"jsonrpc": "2.0", "method": "remoteControl/status/changed", "params": {"status": "disabled"}})
    if m["method"] == "initialize":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"userAgent": "fake", "codexHome": os.environ.get("CODEX_HOME")}})
        if mode == "exit-after-init": sys.exit(0)
    elif m["method"] == "account/read":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"account": {"type": "chatgpt", "planType": "plus"}, "requiresOpenaiAuth": True}})
    elif m["method"] == "account/rateLimits/read":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"rateLimits": {"planType": "plus",
              "primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1789408745}, "secondary": None}}})
    else:
        emit({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "method not found"}})
'''


@pytest.fixture
def fake_codex(tmp_path, monkeypatch):
    """PATH 上放一支講同一套協定的假 codex；回 (執行檔路徑, 它會寫 pid／env 的檔案)。"""
    script = tmp_path / "bin" / "codex"
    script.parent.mkdir()
    script.write_text(FAKE_CODEX % {"py": sys.executable}, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    out = tmp_path / "fake-codex-out.json"
    monkeypatch.setenv("FAKE_CODEX_OUT", str(out))
    home = tmp_path / ".codex"
    home.mkdir()
    return script, out, home


def _session_fetch(script, home, *, timeout=8.0):
    return codex_usage.fetch_codex_usage(
        home, now=9.0, which=lambda n: str(script),
        session_factory=lambda: codex_usage.AppServerSession(str(script), home, timeout=timeout),
    )


def test_app_server_round_trip_is_live_and_passes_codex_home(fake_codex, monkeypatch):
    script, out, home = fake_codex
    monkeypatch.setenv("CODEX_HOME", "/somewhere/else")        # 環境另有值也要被蓋掉：閘門與查詢同一個 home
    res = _session_fetch(script, home)
    assert res["source"] == "live" and res["primary"]["used_percent"] == 12.0
    info = json.loads(out.read_text())
    assert info["CODEX_HOME"] == str(home.resolve())
    assert info["argv"] == ["app-server"]
    time.sleep(0.2)
    with pytest.raises(ProcessLookupError):
        os.kill(info["pid"], 0)                                  # 子進程已回收，沒有殘留


def test_app_server_ignores_notifications_and_non_json_lines(fake_codex, monkeypatch):
    script, _, home = fake_codex
    monkeypatch.setenv("FAKE_CODEX_MODE", "noise")
    assert _session_fetch(script, home)["source"] == "live"


def test_app_server_silent_child_is_network_within_deadline_and_killed(fake_codex, monkeypatch):
    script, out, home = fake_codex
    monkeypatch.setenv("FAKE_CODEX_MODE", "silent")
    t0 = time.monotonic()
    res = _session_fetch(script, home, timeout=1.0)
    elapsed = time.monotonic() - t0
    assert res["failure_reason"] == "network"
    assert elapsed < 5.0, elapsed                                # 1s 查詢預算 ＋ 清理，不能等到子進程自己醒
    info = json.loads(out.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(info["pid"], 0)


def test_app_server_child_exit_after_initialize_is_network(fake_codex, monkeypatch):
    script, _, home = fake_codex
    monkeypatch.setenv("FAKE_CODEX_MODE", "exit-after-init")
    res = _session_fetch(script, home)
    assert res["failure_reason"] == "network"                   # stdout EOF 不炸、不誤報成別的碼

"""api/codex_usage.py——Codex 實時額度改走 `codex app-server` JSON-RPC（design：docs/planning/codex-usage-app-server-design.md）。

三層：normalize_rate_limits（純函式）／fetch_codex_usage（注入假 session）／AppServerSession（假 codex 腳本，真子進程）。
替身講的是我們自己定義的協定——真 CLI 改版替身照樣綠，所以另有人工發行驗收（design §3）。"""
import json
import os
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


class _RecordingSession:
    """記下 AppServerSession 收到的 timeout，然後當成 spawn 失敗——測預設 factory 用哪一個預算。"""
    seen: list = []
    def __init__(self, codex_bin, codex_home, *, timeout):
        _RecordingSession.seen.append(timeout)
        raise OSError("spawn failed")


@pytest.mark.parametrize("fetch, budget", [
    (lambda home: codex_usage.fetch_codex_usage(home, now=1.0, which=lambda n: "/x/codex"), "REQUEST_TIMEOUT"),
    (lambda home: codex_usage.fetch_codex_account_usage(home, which=lambda n: "/x/codex"), "ACCOUNT_USAGE_TIMEOUT"),
], ids=["rate-limits", "account-usage"])
def test_default_session_uses_its_own_budget(tmp_path: Path, monkeypatch, fetch, budget):
    """背景查詢不面對使用者，預算比互動查詢寬；兩個入口各用各的（spec 5.1）。"""
    (tmp_path / ".codex").mkdir()
    monkeypatch.setattr(codex_usage, "AppServerSession", _RecordingSession)
    _RecordingSession.seen = []
    assert fetch(tmp_path / ".codex")["failure_reason"] == "network"
    assert _RecordingSession.seen == [getattr(codex_usage, budget)]


# ---- normalize_account_usage（純函式：三個回應 → 帳號每日用量）----

def _usage(*buckets):
    return {"dailyUsageBuckets": list(buckets), "summary": {"lifetimeTokens": 0}}


def _acct(account_id="acc-1"):
    return {"accountId": account_id, "rateLimits": _rl()["rateLimits"]}


def _models(*items):
    return {"data": list(items), "nextCursor": None}


SOL = {"id": "gpt-6.1-sol", "model": "gpt-6.1-sol", "isDefault": True}
ASTRA = {"id": "gpt-6-astra", "model": "gpt-6-astra", "isDefault": False}


def test_normalize_account_usage_full():
    out = codex_usage.normalize_account_usage(
        _usage({"startDate": "2026-10-12", "tokens": 65830431}, {"startDate": "2026-10-13", "tokens": 0}),
        _acct("acc-1"), _models(ASTRA, SOL))
    assert out == {"source": "live", "account_key": "acc-1",
                   "daily": {"2026-10-12": 65830431, "2026-10-13": 0}, "default_model": "gpt-6.1-sol"}


def test_normalize_account_usage_empty_buckets_is_live():
    out = codex_usage.normalize_account_usage(_usage(), _acct(), _models(SOL))
    assert out["source"] == "live" and out["daily"] == {}


@pytest.mark.parametrize("usage", [
    {"summary": {}},
    {"dailyUsageBuckets": None, "summary": {}},
    _usage("2026-10-12"),
    _usage({"tokens": 5}),
    _usage({"startDate": "2026/10/12", "tokens": 5}),
    _usage({"startDate": "2026-10-12T00:00:00Z", "tokens": 5}),
    _usage({"startDate": "2026-13-01", "tokens": 5}),
    _usage({"startDate": "20261012", "tokens": 5}),
    _usage({"startDate": "2026-10-12", "tokens": "5"}),
    _usage({"startDate": "2026-10-12", "tokens": True}),
    _usage({"startDate": "2026-10-12", "tokens": 1.5}),
    _usage({"startDate": "2026-10-12", "tokens": -1}),
    _usage({"startDate": "2026-10-12", "tokens": 5}, {"startDate": "2026-10-12", "tokens": 6}),
    _usage({"startDate": "2026-10-12", "tokens": 5}, {"startDate": "2026-10-13"}),
], ids=["no-buckets", "null-buckets", "bucket-not-dict", "no-date", "slash-date", "datetime", "bad-month", "basic-format",
        "str-tokens", "bool-tokens", "float-tokens", "negative-tokens", "duplicate-date", "second-bad"])
def test_normalize_account_usage_bad_buckets_is_bad_response(usage):
    """協定標 experimental：任何一筆形狀不對就整筆不收，不寫入半套資料（spec 5.1）。"""
    out = codex_usage.normalize_account_usage(usage, _acct(), _models(SOL))
    assert out == {"source": "unavailable", "failure_reason": "bad_response", "observed_at": None}


@pytest.mark.parametrize("rate_limits", [
    _acct(None), _acct(""), {"rateLimits": _rl()["rateLimits"]}, _acct(42),
], ids=["null", "empty", "missing", "not-str"])
def test_normalize_account_usage_without_account_id_is_bad_response(rate_limits):
    """只用 accountId 當帳號識別，沒有就那一輪不寫入（spec 5.1、§6-6）。"""
    out = codex_usage.normalize_account_usage(
        _usage({"startDate": "2026-10-12", "tokens": 5}), rate_limits, _models(SOL))
    assert out == {"source": "unavailable", "failure_reason": "bad_response", "observed_at": None}


@pytest.mark.parametrize("models, expected", [
    (_models(ASTRA), None),
    (_models({"id": "x", "model": None, "isDefault": True}, SOL), "gpt-6.1-sol"),
    (_models({"id": "x", "model": "gpt-x", "isDefault": "true"}, SOL), "gpt-6.1-sol"),
    ({"data": None}, None),
    (None, None),
], ids=["no-default", "skip-null-model", "isdefault-must-be-true", "null-data", "null-result"])
def test_normalize_account_usage_default_model(models, expected):
    """預設模型只拿來估價：找不到給 None，不讓整筆失敗。"""
    out = codex_usage.normalize_account_usage(_usage(), _acct(), models)
    assert out["source"] == "live" and out["default_model"] == expected


# ---- fetch_codex_account_usage（閘門與 fetch_codex_usage 同一套）----

ACCOUNT_OK = {"account/read": CHATGPT,
              "account/usage/read": _usage({"startDate": "2026-10-21", "tokens": 2474188}),
              "account/rateLimits/read": _acct("acc-1"), "model/list": _models(SOL)}


def _fetch_account(tmp_path, responses, *, which=lambda name: "/opt/homebrew/bin/codex"):
    home = tmp_path / ".codex"
    home.mkdir(parents=True)
    session = _FakeSession(responses)
    return codex_usage.fetch_codex_account_usage(home, session_factory=lambda: session, which=which), session


def test_fetch_account_usage_success_order_and_close(tmp_path: Path):
    out, s = _fetch_account(tmp_path, ACCOUNT_OK)
    assert out == {"source": "live", "account_key": "acc-1",
                   "daily": {"2026-10-21": 2474188}, "default_model": "gpt-6.1-sol"}
    assert s.calls == ["account/read", "account/usage/read", "account/rateLimits/read", "model/list"]
    assert s.closed


def test_fetch_account_usage_not_logged_in_stops_at_gate(tmp_path: Path):
    out, s = _fetch_account(tmp_path, {**ACCOUNT_OK, "account/read": {"account": None}})
    assert out["failure_reason"] == "no_auth" and s.calls == ["account/read"] and s.closed


def test_fetch_account_usage_gates_without_spawning(tmp_path: Path):
    spawned = []
    out = codex_usage.fetch_codex_account_usage(
        tmp_path / ".codex", session_factory=lambda: spawned.append(1), which=lambda n: "/x/codex")
    assert out["failure_reason"] == "no_auth" and spawned == []
    (tmp_path / ".codex").mkdir()
    out = codex_usage.fetch_codex_account_usage(
        tmp_path / ".codex", session_factory=lambda: spawned.append(1), which=lambda n: None)
    assert out["failure_reason"] == "no_codex" and spawned == []


@pytest.mark.parametrize("method, err, reason", [
    ("account/usage/read", RpcError(-32601, "method not found"), "bad_response"),
    ("account/usage/read", RpcError(-32603, "GET https://chatgpt.com/backend-api/x failed: 401 Unauthorized"),
     "unauthorized"),
    ("account/rateLimits/read", TimeoutError(), "network"),
    ("model/list", OSError("stdout closed"), "network"),
], ids=["usage-method-missing", "usage-401", "rate-limits-timeout", "models-eof"])
def test_fetch_account_usage_errors_are_typed(tmp_path: Path, method, err, reason):
    out, s = _fetch_account(tmp_path, {**ACCOUNT_OK, method: err})
    assert out == {"source": "unavailable", "failure_reason": reason, "observed_at": None}
    assert s.closed


# ---- AppServerSession（真子進程 ＋ 假 codex 腳本）----

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


def test_app_server_account_usage_round_trip(fake_codex):
    script, out, home = fake_codex
    res = codex_usage.fetch_codex_account_usage(
        home, which=lambda n: str(script),
        session_factory=lambda: codex_usage.AppServerSession(str(script), home, timeout=8.0))
    assert res == {"source": "live", "account_key": "acc-fake", "daily": {"2026-10-21": 7}, "default_model": "gpt-fake"}
    info = json.loads(out.read_text())
    time.sleep(0.2)
    with pytest.raises(ProcessLookupError):
        os.kill(info["pid"], 0)                                  # 子進程已回收


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

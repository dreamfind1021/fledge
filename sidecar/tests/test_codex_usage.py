"""api/codex_usage.py——Codex 實時額度抓取的正規化與容錯（不打真網路：opener 注入）。"""
import json
import urllib.error
from pathlib import Path

from fledge_sidecar.api import codex_usage


# ---- normalize_usage（純函式：usage JSON → live payload）----

def _body(plan="plus", p_pct=1.0, s_pct=0.0):
    return {
        "plan_type": plan,
        "rate_limit": {
            "primary_window": {"used_percent": p_pct, "limit_window_seconds": 18000, "reset_at": 1782551997},
            "secondary_window": {"used_percent": s_pct, "limit_window_seconds": 604800, "reset_at": 1783138797},
        },
    }


def test_normalize_full_body_to_live():
    out = codex_usage.normalize_usage(_body(), now=1000.0)
    assert out["source"] == "live"
    assert out["observed_at"] == 1000.0
    assert out["plan_type"] == "plus"
    assert out["primary"] == {"used_percent": 1.0, "window_minutes": 300, "resets_at": 1782551997.0}
    assert out["secondary"]["window_minutes"] == 10080


def test_normalize_missing_rate_limit_is_bad_response():
    out = codex_usage.normalize_usage({"plan_type": "plus"}, now=1.0)
    assert out["source"] == "unavailable" and out["failure_reason"] == "bad_response"


def test_normalize_missing_primary_window_is_bad_response():
    out = codex_usage.normalize_usage({"rate_limit": {"secondary_window": {"used_percent": 1}}}, now=1.0)
    assert out["source"] == "unavailable" and out["failure_reason"] == "bad_response"


# ---- fetch_codex_usage（讀 auth.json + opener 注入）----

def _auth(tmp_path: Path) -> Path:
    home = tmp_path / ".codex"
    home.mkdir()
    (home / "auth.json").write_text(json.dumps({
        "tokens": {"access_token": "tok-secret", "account_id": "acct-123"}}), encoding="utf-8")
    return home


class _Resp:
    def __init__(self, raw: bytes):
        self._raw = raw
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def read(self):
        return self._raw


def test_fetch_no_auth_file_is_no_auth(tmp_path: Path):
    out = codex_usage.fetch_codex_usage(tmp_path / ".codex", now=1.0)
    assert out["source"] == "unavailable" and out["failure_reason"] == "no_auth"


def test_fetch_success_returns_live(tmp_path: Path):
    home = _auth(tmp_path)
    captured = {}
    def opener(req, timeout=None):
        captured["auth"] = req.headers.get("Authorization")
        captured["acct"] = req.headers.get("Chatgpt-account-id")
        return _Resp(json.dumps(_body(p_pct=7.0)).encode())
    out = codex_usage.fetch_codex_usage(home, now=5.0, opener=opener)
    assert out["source"] == "live" and out["primary"]["used_percent"] == 7.0
    assert captured["auth"] == "Bearer tok-secret"   # token 進 header
    assert captured["acct"] == "acct-123"


def test_fetch_http_401_is_unauthorized(tmp_path: Path):
    home = _auth(tmp_path)
    def opener(req, timeout=None):
        raise urllib.error.HTTPError(codex_usage.USAGE_URL, 401, "Unauthorized", {}, None)
    out = codex_usage.fetch_codex_usage(home, now=1.0, opener=opener)
    assert out["source"] == "unavailable" and out["failure_reason"] == "unauthorized"


def test_fetch_network_error_is_network(tmp_path: Path):
    home = _auth(tmp_path)
    def opener(req, timeout=None):
        raise urllib.error.URLError("boom")
    out = codex_usage.fetch_codex_usage(home, now=1.0, opener=opener)
    assert out["source"] == "unavailable" and out["failure_reason"] == "network"


def test_fetch_bad_json_is_bad_response(tmp_path: Path):
    home = _auth(tmp_path)
    def opener(req, timeout=None):
        return _Resp(b"not json")
    out = codex_usage.fetch_codex_usage(home, now=1.0, opener=opener)
    assert out["source"] == "unavailable" and out["failure_reason"] == "bad_response"

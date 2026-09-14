"""api/codex_usage.py——Codex 實時額度抓取的正規化與容錯（不打真網路：opener 注入）。"""
import json
import ssl
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
    def opener(req, timeout=None, context=None):
        captured["auth"] = req.headers.get("Authorization")
        captured["acct"] = req.headers.get("Chatgpt-account-id")
        return _Resp(json.dumps(_body(p_pct=7.0)).encode())
    out = codex_usage.fetch_codex_usage(home, now=5.0, opener=opener)
    assert out["source"] == "live" and out["primary"]["used_percent"] == 7.0
    assert captured["auth"] == "Bearer tok-secret"   # token 進 header
    assert captured["acct"] == "acct-123"


def test_fetch_uses_bundled_ca_not_system_paths(tmp_path: Path, monkeypatch):
    """打包版回 network 的根因（2026-09-14 實測）：CI 用 python.org 3.12 打包，帶進去的
    libcrypto 編死的 OPENSSLDIR 是 /Library/Frameworks/Python.framework/…/etc/openssl，
    使用者機器上不存在 → OpenSSL 一張根憑證都沒有 → TLS 驗證失敗 → except 歸成 network。
    dev 用 Homebrew Python，路徑剛好存在，所以 dev 正常。

    修法：urlopen 帶自己的 SSLContext，CA 來自打包進去的 certifi，不靠系統路徑。

    這裡用 SSL_CERT_FILE／SSL_CERT_DIR 指向不存在的路徑模擬「系統沒有任何憑證」——
    OpenSSL 的 set_default_verify_paths 會讀這兩個環境變數。先斷言模擬成立（預設
    context 載到 0 張），否則 dev 的 Homebrew 憑證會讓這條測試永遠綠、變成假防線。"""
    monkeypatch.setenv("SSL_CERT_FILE", str(tmp_path / "nope.pem"))
    monkeypatch.setenv("SSL_CERT_DIR", str(tmp_path / "nope"))
    assert len(ssl.create_default_context().get_ca_certs()) == 0      # 模擬成立的前提

    home = _auth(tmp_path)
    captured = {}
    def opener(req, timeout=None, context=None):
        captured["context"] = context
        return _Resp(json.dumps(_body()).encode())
    out = codex_usage.fetch_codex_usage(home, now=1.0, opener=opener)
    assert out["source"] == "live"
    ctx = captured.get("context")
    assert isinstance(ctx, ssl.SSLContext)                             # 沒帶 context ＝ 靠系統路徑 ＝ 打包版必壞
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname  # 不是關掉驗證換來的
    assert len(ctx.get_ca_certs()) > 100                               # 真的載進了一整包根憑證


def test_certifi_is_a_declared_dependency():
    """certifi 目前只是別的套件間接帶進 venv 的；修法一旦 import 它，就必須明列為直接依賴——
    否則哪天那個上游不再依賴 certifi，打包就少了 cacert.pem，症狀又回到 network。"""
    import tomllib
    with open(Path(__file__).resolve().parents[1] / "pyproject.toml", "rb") as f:
        deps = tomllib.load(f)["project"]["dependencies"]
    assert any(d.split(">")[0].split("=")[0].strip() == "certifi" for d in deps), deps


def test_fetch_http_401_is_unauthorized(tmp_path: Path):
    home = _auth(tmp_path)
    def opener(req, timeout=None, context=None):
        raise urllib.error.HTTPError(codex_usage.USAGE_URL, 401, "Unauthorized", {}, None)
    out = codex_usage.fetch_codex_usage(home, now=1.0, opener=opener)
    assert out["source"] == "unavailable" and out["failure_reason"] == "unauthorized"


def test_fetch_network_error_is_network(tmp_path: Path):
    home = _auth(tmp_path)
    def opener(req, timeout=None, context=None):
        raise urllib.error.URLError("boom")
    out = codex_usage.fetch_codex_usage(home, now=1.0, opener=opener)
    assert out["source"] == "unavailable" and out["failure_reason"] == "network"


def test_fetch_bad_json_is_bad_response(tmp_path: Path):
    home = _auth(tmp_path)
    def opener(req, timeout=None, context=None):
        return _Resp(b"not json")
    out = codex_usage.fetch_codex_usage(home, now=1.0, opener=opener)
    assert out["source"] == "unavailable" and out["failure_reason"] == "bad_response"

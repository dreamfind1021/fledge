"""Codex 實時額度抓取（api/ 層唯一對外出口）。

讀本地 `~/.codex/auth.json` 的 OAuth token，呼叫 ChatGPT backend 的 codex usage 端點，
回傳正規化的 rate limit 視窗。**所有 secret 集中於此處理**：token 只進 Authorization header，
絕不 log／回傳／放進錯誤訊息；任何例外一律捕捉後降級成 typed 失敗（不外洩 raw exception）。

回傳合約：
  成功      {"source": "live", "observed_at": ts, "plan_type": str|None,
             "primary": {...}, "secondary": {...}?}
  失敗      {"source": "unavailable", "failure_reason": <reason>, "observed_at": None}
  reason ∈ {"no_auth", "unauthorized", "network", "bad_response"}
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

# 已逆向驗證的端點（ChatGPT auth 模式，與 codex `/status` 同源）。未公開故全程容錯降級。
USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"
REQUEST_TIMEOUT = 8.0


def _read_auth(codex_home: Path) -> tuple[str, str] | None:
    """回 (access_token, account_id)；缺檔／壞 JSON／缺鍵 → None。不外洩內容。"""
    try:
        with open(codex_home / "auth.json", "rb") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    tokens = data.get("tokens") if isinstance(data.get("tokens"), dict) else {}
    tok, acct = tokens.get("access_token"), tokens.get("account_id")
    if isinstance(tok, str) and tok and isinstance(acct, str) and acct:
        return tok, acct
    return None


def _window(w: object) -> dict | None:
    """codex *_window → {used_percent, window_minutes, resets_at}；缺 used_percent → None。"""
    if not isinstance(w, dict) or not isinstance(w.get("used_percent"), (int, float)):
        return None
    secs = w.get("limit_window_seconds")
    reset = w.get("reset_at")
    return {
        "used_percent": float(w["used_percent"]),
        "window_minutes": int(secs // 60) if isinstance(secs, (int, float)) and secs else None,
        "resets_at": float(reset) if isinstance(reset, (int, float)) else None,
    }


def _fail(reason: str) -> dict:
    return {"source": "unavailable", "failure_reason": reason, "observed_at": None}


def normalize_usage(body: object, now: float) -> dict:
    """usage JSON → live payload；缺 rate_limit／primary_window → bad_response。"""
    rl = body.get("rate_limit") if isinstance(body, dict) else None
    if not isinstance(rl, dict):
        return _fail("bad_response")
    primary = _window(rl.get("primary_window"))
    if primary is None:
        return _fail("bad_response")
    plan = body.get("plan_type")
    out = {
        "source": "live", "observed_at": now,
        "plan_type": plan if isinstance(plan, str) else None,
        "primary": primary,
    }
    secondary = _window(rl.get("secondary_window"))
    if secondary is not None:
        out["secondary"] = secondary
    return out


def fetch_codex_usage(codex_home: Path, now: float, *, opener=None) -> dict:
    """抓實時 codex 額度。任何失敗回 typed unavailable，絕不外洩 token／raw exception。

    opener：注入點（測試用），預設 `urllib.request.urlopen`。
    """
    auth = _read_auth(Path(codex_home))
    if auth is None:
        return _fail("no_auth")
    token, account_id = auth
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "chatgpt-account-id": account_id,
        "Accept": "application/json",
        "User-Agent": "fledge",
    })
    _open = opener or urllib.request.urlopen
    try:
        with _open(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        return _fail("unauthorized" if exc.code in (401, 403) else "bad_response")
    except (urllib.error.URLError, OSError, TimeoutError):
        return _fail("network")
    except Exception:  # noqa: BLE001 —— 兜底：任何未預期例外都不得外洩，一律降級
        return _fail("network")
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        return _fail("bad_response")
    return normalize_usage(body, now)

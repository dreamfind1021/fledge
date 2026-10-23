"""Codex 實時額度——透過 `codex app-server` 的 JSON-RPC 問 `account/rateLimits/read`。

design：docs/planning/codex-usage-app-server-design.md（2026-09-14）。

為什麼不自己打 HTTPS（v1.7.0 之前的做法）：chatgpt.com 前面是 Cloudflare bot 驗證，依**連線指紋**
（TLS 握手＋ALPN）放行、與 User-Agent 無關、規則浮動——打包版的 python.org OpenSSL 被擋、dev 的
Homebrew OpenSSL 能過，下午能過晚上不能。任何自己打的客戶端都在它靶上；codex CLI 自己的 Rust
客戶端是 OpenAI 自家的，不會被擋，而且 CLI 自己也已經改打 `wham/usage`，我們逆向的舊端點隨時下線。

回傳（與舊實作完全相同的合約，前端不用動）：
  成功  {"source": "live", "observed_at": now, "plan_type", "primary": {...}, "secondary"?: {...}}
  失敗  {"source": "unavailable", "failure_reason": <reason>, "observed_at": None}
    reason：no_auth（未登入／從沒用過 codex）、unsupported_auth（API key 帳號，額度只屬 ChatGPT 帳號）、
            no_codex（找不到 codex 執行檔）、unauthorized（token 被拒）、bad_response（協定形狀不對）、
            network（逾時／子進程死了／spawn 失敗）。前端只認 no_auth／unauthorized（顯示「需重新登入」），
            其餘一律「暫時無法取得」。

另有 `fetch_codex_account_usage`：背景抓帳號每日用量（design：docs/planning/codex-unattributed-usage-design.md §5.1），
閘門與失敗碼跟上面同一套。
"""
from __future__ import annotations

import json
import math
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from datetime import date
from pathlib import Path
from typing import Any, Callable

from fledge_sidecar import __version__

# 整段查詢（spawn → initialize → account/read → rateLimits/read）共用的預算；清理另有 CLEANUP_TIMEOUT
REQUEST_TIMEOUT = 8.0
CLEANUP_TIMEOUT = 3.0
# 背景抓帳號每日用量不面對使用者，預算比互動查詢寬（實測三個查詢合計約 2 秒）
ACCOUNT_USAGE_TIMEOUT = 30.0
# 未歸屬用量估計用的額度窗口至少要一天：5 小時窗口沒有完整的日子可對應（spec 5.1）；
# 最多 32 天：更長的不可能是真的窗口，存進去之後算上一輪會逐日迴圈卡死（合併前審查）
MIN_ESTIMATE_WINDOW_MINUTES = 1440
MAX_ESTIMATE_WINDOW_MINUTES = 32 * 1440
_AUTH_REJECTED = re.compile(r"\b(?:401|403)\b|Unauthorized", re.IGNORECASE)


class RpcError(Exception):
    """app-server 回的 JSON-RPC error（code／message 皆來自 codex，不含我們的 token）。"""
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _fail(reason: str) -> dict:
    return {"source": "unavailable", "failure_reason": reason, "observed_at": None}


def _window(w: object) -> dict | None:
    """rateLimits.{primary,secondary} → {used_percent, window_minutes, resets_at}；缺 usedPercent → None。
    windowDurationMins 本來就是分鐘（舊 HTTP 端點是秒要除 60）。"""
    if not isinstance(w, dict) or not isinstance(w.get("usedPercent"), (int, float)):
        return None
    mins, reset = w.get("windowDurationMins"), w.get("resetsAt")
    return {
        "used_percent": float(w["usedPercent"]),
        "window_minutes": int(mins) if isinstance(mins, (int, float)) and mins else None,
        "resets_at": float(reset) if isinstance(reset, (int, float)) else None,
    }


def normalize_rate_limits(result: object, now: float) -> dict:
    """`account/rateLimits/read` 的 result → live payload；缺 rateLimits／primary → bad_response。
    協定標 experimental：欄位改名時要回 bad_response，不能給錯數字。"""
    rl = result.get("rateLimits") if isinstance(result, dict) else None
    if not isinstance(rl, dict):
        return _fail("bad_response")
    primary = _window(rl.get("primary"))
    if primary is None:
        return _fail("bad_response")
    plan = rl.get("planType")
    out = {
        "source": "live", "observed_at": now,
        "plan_type": plan if isinstance(plan, str) else None,
        "primary": primary,
    }
    secondary = _window(rl.get("secondary"))
    if secondary is not None:
        out["secondary"] = secondary
    return out


class AppServerSession:
    """一個 `codex app-server` 子進程的生命週期：spawn → initialize → 若干 call → close。

    整段共用一個 deadline（從 spawn 起算）。stdout 逐行讀、只認 JSON 且 id 對得上的回應，通知與
    非 JSON 行一律略過。stderr 丟掉——不讀它會塞滿管線讓子進程卡住。
    `CODEX_HOME` 一律明傳：閘門（account/read）與查詢（rateLimits/read）必須是同一個 home，
    不能讓使用者環境裡的 CODEX_HOME 把查詢導到別的帳號（Codex 設計審查 R1 high）。"""

    def __init__(self, codex_bin: str, codex_home: Path, *, timeout: float = REQUEST_TIMEOUT):
        self._deadline = time.monotonic() + timeout
        self._next_id = 1
        env = {**os.environ, "CODEX_HOME": str(Path(codex_home).resolve())}
        self._proc = subprocess.Popen(
            [codex_bin, "app-server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        # 讀取走獨立執行緒餵佇列，call() 只對佇列做帶 timeout 的 get。
        # **不能**用 select ＋ 帶緩衝的 readline：子進程一次吐多行時 readline 會把整塊吞進 Python 的
        # 緩衝區，下一輪 select 看管線是空的、一路等到逾時（假 codex「夾雜通知」測試抓到的）。
        self._lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        try:
            self.call("initialize", {"clientInfo": {"name": "fledge", "title": "Fledge", "version": __version__}})
            self._send({"jsonrpc": "2.0", "method": "initialized"})
        except BaseException:
            self.close()
            raise

    def _pump(self) -> None:
        """stdout → 佇列；EOF 放一個 "" 當哨兵。子進程被 kill 後 readline 會回 ""，執行緒自然結束。"""
        stream = self._proc.stdout
        assert stream is not None
        try:
            for line in stream:
                self._lines.put(line)
        except (OSError, ValueError):   # 管線在我們 close() 時被關掉
            pass
        self._lines.put("")

    def _send(self, obj: dict) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(obj) + "\n")
        self._proc.stdin.flush()

    def call(self, method: str, params: dict) -> Any:
        """送一個請求、等它的回應。逾時 → TimeoutError；子進程死了（EOF）→ OSError；error → RpcError。"""
        req_id = self._next_id
        self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        while True:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(method)
            try:
                line = self._lines.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(method) from None
            if line == "":
                raise OSError("app-server stdout closed")
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue                                    # 非 JSON 行（警告之類）略過
            if not isinstance(msg, dict) or msg.get("id") != req_id:
                continue                                    # 通知或別的 id 略過
            if "error" in msg:
                err = msg["error"] if isinstance(msg["error"], dict) else {}
                raise RpcError(int(err.get("code", 0) or 0), str(err.get("message", "")))
            return msg.get("result")

    def close(self) -> None:
        """關 stdin（app-server 收到 EOF 會自行退出，實測 0.02s）→ terminate → CLEANUP_TIMEOUT 內沒退就 kill → wait 回收。"""
        p = self._proc
        try:
            if p.stdin is not None:
                p.stdin.close()
        except OSError:
            pass
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(CLEANUP_TIMEOUT)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        # stdout 留給讀取執行緒收尾（子進程退了它會讀到 EOF 自己結束），這裡不主動關以免與它競爭


def _with_chatgpt_session(
    codex_home: Path, body: Callable[[Any], dict], *,
    session_factory: Callable[[], Any] | None, which: Callable[[str], str | None], timeout: float,
) -> dict:
    """兩個抓取共用的閘門與失敗碼對應。任何失敗回 typed unavailable，絕不外洩例外原文。

    閘門順序（design §2 流程）：目錄不在 → no_auth（不 spawn；空目錄會讓 app-server 建一整套 sqlite）
    → 找不到 codex → no_codex → spawn → account/read 判登入 → body(session)。
    body 拋的 RpcError／OSError／TimeoutError 照同一套對應轉碼。"""
    home = Path(codex_home)
    if not home.is_dir():
        return _fail("no_auth")
    codex_bin = which("codex")
    if not codex_bin:
        return _fail("no_codex")
    factory = session_factory or (lambda: AppServerSession(codex_bin, home, timeout=timeout))
    try:
        session = factory()
    except (OSError, TimeoutError, RpcError):
        return _fail("network")
    except Exception:  # noqa: BLE001 —— 兜底：任何未預期例外都不得外洩，一律降級
        return _fail("network")
    try:
        acct = session.call("account/read", {})
        account = acct.get("account") if isinstance(acct, dict) else None
        if account is None:
            return _fail("no_auth")
        if not isinstance(account, dict) or account.get("type") != "chatgpt":
            return _fail("unsupported_auth")
        return body(session)
    except RpcError as exc:
        return _fail("unauthorized" if _AUTH_REJECTED.search(exc.message) else "bad_response")
    except (OSError, TimeoutError):
        return _fail("network")
    except Exception:  # noqa: BLE001
        return _fail("network")
    finally:
        try:
            session.close()
        except Exception:  # noqa: BLE001 —— 清理失敗不能蓋掉已經拿到的結果
            pass


def fetch_codex_usage(
    codex_home: Path, now: float, *,
    session_factory: Callable[[], Any] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> dict:
    """抓實時 codex 額度：過閘門後問 account/rateLimits/read。
    `session_factory`／`which` 是測試注入點。"""
    return _with_chatgpt_session(
        codex_home, lambda s: normalize_rate_limits(s.call("account/rateLimits/read", {}), now),
        session_factory=session_factory, which=which, timeout=REQUEST_TIMEOUT)


def is_iso_date(value: object) -> bool:
    """`YYYY-MM-DD` 而且是真的日期。帳號用量的日期在 API 回應與歷史檔都是這個格式，兩邊都用這支驗。
    比對 isoformat() 往返：fromisoformat 也收 `20261012`、ISO 週日期，那些不是上游給的格式。"""
    if not isinstance(value, str):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _estimate_window(rate_limits: object) -> dict | None:
    """rateLimits/read → 長度至少一天的窗口裡最長的那個 {start, resets_at}；找不到給 None，不算失敗（spec 5.1）。
    週窗口曾被 API 放在 primary，不能看位置。起點＝重置時間往前推一個窗口長度（提早重置後 resetsAt 會變成
    重置當下＋窗口長度，是推論，spec §7）。重置時間不是有限數也當成沒有：歷史檔的讀取端不收 inf／NaN，
    寫進去會讓下一次讀檔判成壞檔、整份改名重來（Codex plan R1）。窗口長度換不成整數（inf／NaN）或超過 32 天
    也當成沒有，不讓整輪抓取失敗（合併前審查）。"""
    rl = rate_limits.get("rateLimits") if isinstance(rate_limits, dict) else None
    if not isinstance(rl, dict):
        return None

    def parsed(w: object) -> dict | None:
        try:
            return _window(w)
        except (OverflowError, ValueError):   # windowDurationMins 是 inf／NaN：int() 換不了
            return None
    wins = [w for w in (parsed(rl.get("primary")), parsed(rl.get("secondary")))
            if w and w["window_minutes"]
            and MIN_ESTIMATE_WINDOW_MINUTES <= w["window_minutes"] <= MAX_ESTIMATE_WINDOW_MINUTES
            and w["resets_at"] is not None and math.isfinite(w["resets_at"])]
    if not wins:
        return None
    w = max(wins, key=lambda x: x["window_minutes"])
    return {"start": w["resets_at"] - w["window_minutes"] * 60, "resets_at": w["resets_at"]}


def normalize_account_usage(usage: object, rate_limits: object, models: object) -> dict:
    """三個回應 → {"source": "live", "account_key", "daily": {date: tokens}, "default_model", "window"}。

    account/usage/read 是協定標 experimental、官方 README 沒寫的方法：每日 buckets 有任何一筆形狀不對
    就整筆 bad_response，不交出半套資料（spec 5.1）。帳號只認 rateLimits/read 的 accountId——null 也是
    bad_response，不退回 email 雜湊（同一個帳號時而拿到 accountId、時而退回雜湊，歷史會被拆成兩份）。
    預設模型只拿來估價、額度窗口只拿來決定「上一輪」是哪幾天，找不到都給 None、不算失敗。"""
    buckets = usage.get("dailyUsageBuckets") if isinstance(usage, dict) else None
    if not isinstance(buckets, list):
        return _fail("bad_response")
    daily: dict[str, int] = {}
    for b in buckets:
        day = b.get("startDate") if isinstance(b, dict) else None
        tokens = b.get("tokens") if isinstance(b, dict) else None
        if (not is_iso_date(day) or day in daily
                or not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 0):
            return _fail("bad_response")
        daily[day] = tokens
    account_key = rate_limits.get("accountId") if isinstance(rate_limits, dict) else None
    if not isinstance(account_key, str) or not account_key:
        return _fail("bad_response")
    data = models.get("data") if isinstance(models, dict) else None
    default_model = next(
        (m["model"] for m in (data if isinstance(data, list) else [])
         if isinstance(m, dict) and m.get("isDefault") is True and isinstance(m.get("model"), str) and m["model"]),
        None)
    return {"source": "live", "account_key": account_key, "daily": daily, "default_model": default_model,
            "window": _estimate_window(rate_limits)}


def fetch_codex_account_usage(
    codex_home: Path, *,
    session_factory: Callable[[], Any] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> dict:
    """背景抓帳號每日用量（spec 5.1）：過閘門後，同一個連線依序問每日用量 → 帳號 id 與額度窗口 → 預設模型。
    失敗回 typed unavailable，呼叫端據此不寫入任何東西。"""
    def body(session: Any) -> dict:
        usage = session.call("account/usage/read", {})
        rate_limits = session.call("account/rateLimits/read", {})
        models = session.call("model/list", {})
        return normalize_account_usage(usage, rate_limits, models)

    return _with_chatgpt_session(codex_home, body, session_factory=session_factory, which=which,
                                 timeout=ACCOUNT_USAGE_TIMEOUT)

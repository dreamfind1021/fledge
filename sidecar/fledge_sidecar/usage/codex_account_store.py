"""Codex 帳號每日用量的歷史檔（design：docs/planning/codex-unattributed-usage-design.md §5.2）。

OpenAI 的 `account/usage/read` 只給最近 10 天，超過的部分無法重建，所以放 `~/.fledge/`（跟
account-activity.jsonl 同層），不放可以整個刪掉重建的 `cache/`。內容：每個帳號一組 {date: tokens}、
哪些日期已經定稿、觀察到的額度窗口、Codex 預設模型、最近幾次抓取的觀察紀錄（上游何時發布前一天、零用量日
回不回傳都還沒確認，靠這份紀錄回頭查；打包版的 sidecar log 沒有落地，記在 log 裡等於沒記）。

背景更新整段是一個交易：跨程序檔案鎖 → 抓取 → 鎖內重新讀檔 → 合併 → 這次專屬的暫存檔 → fsync → os.replace
→ fsync 目錄。兩個 Fledge 同時開，也不會蓋掉對方已存、上游已經不給的日期，或拿舊快照蓋掉對方剛抓到的新數字。
讀取端（儀表板）不拿鎖：os.replace 是原子的。
"""
from __future__ import annotations

import fcntl
import json
import logging
import math
import os
import tempfile
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Callable

from fledge_sidecar.api.codex_usage import is_iso_date
from fledge_sidecar.app_config import default_config_path

logger = logging.getLogger(__name__)

VERSION = 2                # v2 多了 final／windows：只認 v1 的舊版寫入時會把它們丟掉，所以升版（spec 5.2）
RETENTION_DAYS = 400
MAX_FETCHES = 240          # 每 3 小時抓一次 ≈ 30 天
MAX_WINDOWS = 60           # 每個帳號留最近 60 輪 ≈ 一年
WINDOW_TOLERANCE_SEC = 600  # 同一個窗口的 resetsAt 容忍 10 分鐘漂移；不同的窗口至少差好幾個小時
_EPOCH_ORDINAL = date(1970, 1, 1).toordinal()


class NewerVersionError(Exception):
    """歷史檔是較新的 Fledge 寫的（version 比本版大）。不是壞檔：寫入端這一輪不碰它，讀取端當成空的。
    打包版與 dev 版常同時開，舊版若把新格式當壞檔改名，新版累積的歷史就從卡片上消失。"""


@dataclass
class AccountUsageHistory:
    accounts: dict[str, dict[str, int]] = field(default_factory=dict)
    default_model: str | None = None
    fetches: list[dict] = field(default_factory=list)
    windows: dict[str, list[dict]] = field(default_factory=dict)   # 每個帳號按 start 排序的 {start, resets_at}
    final: dict[str, list[str]] = field(default_factory=dict)      # 每個帳號已定稿的日期


def day_of(ts: float) -> int:
    """切日只在這裡定義（spec 5.3-1）：UTC 1970-01-01 起第幾天。上游用哪個時區切日還沒確認，要改只改這裡。"""
    return int(ts // 86400)


def day_noon(n: int) -> float:
    """第 n 天中午 12 點（epoch 秒）。跟 day_of 是同一個切日規則：改切日時兩個一起改。"""
    return n * 86400 + 43200


def day_number(day: str) -> int:
    """'YYYY-MM-DD' → 跟 day_of 同一把尺的天數。"""
    return date.fromisoformat(day).toordinal() - _EPOCH_ORDINAL


def day_label(n: int) -> str:
    return date.fromordinal(n + _EPOCH_ORDINAL).isoformat()


def _is_time(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def default_path() -> Path:
    override = os.environ.get("FLEDGE_CODEX_ACCOUNT_USAGE")
    if override:
        return Path(override)
    return default_config_path().parent / "codex-account-usage.json"


def _parse(raw: bytes) -> AccountUsageHistory:
    """檔案內容 → 歷史。任何一處形狀不對都拋 ValueError（JSON／UTF-8 解碼錯誤本來就是它的子類）；
    version 是比本版大的整數則拋 NewerVersionError（不是壞檔）。"""
    data = json.loads(raw.decode("utf-8"))
    version = data.get("version") if isinstance(data, dict) else None
    if type(version) is int and version > VERSION:
        raise NewerVersionError(f"歷史檔版本 {version} 比本版 {VERSION} 新")
    if type(version) is not int or version not in (1, VERSION):   # True == 1 在 Python 成立，所以比型別
        raise ValueError("version")
    accounts = data.get("accounts")
    if not isinstance(accounts, dict):
        raise ValueError("accounts")
    for key, days in accounts.items():
        if not key or not isinstance(days, dict):
            raise ValueError("account")
        for day, tokens in days.items():
            if not is_iso_date(day) or not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 0:
                raise ValueError("day")
    model = data.get("default_model")
    if model is not None and not isinstance(model, str):
        raise ValueError("default_model")
    fetches = data.get("fetches")
    if not isinstance(fetches, list):
        raise ValueError("fetches")
    if version == 1:   # 遷移：v1 沒有定稿與窗口紀錄，當成空的，下一次抓取補標、存成 v2（spec 5.2）
        return AccountUsageHistory(accounts=accounts, default_model=model, fetches=fetches)
    windows, final = data.get("windows"), data.get("final")
    if not isinstance(windows, dict) or not isinstance(final, dict):
        raise ValueError("windows/final")
    for key, ws in windows.items():
        if not key or not isinstance(ws, list) or not all(
                isinstance(w, dict) and _is_time(w.get("start")) and _is_time(w.get("resets_at")) for w in ws):
            raise ValueError("windows")
    for key, days in final.items():
        if not key or not isinstance(days, list) or not all(is_iso_date(d) for d in days):
            raise ValueError("final")
    return AccountUsageHistory(accounts=accounts, default_model=model, fetches=fetches, windows=windows, final=final)


def load(path: Path) -> AccountUsageHistory:
    """讀取端（儀表板每輪掃描）：不拿鎖、不改檔。沒有檔案或讀不懂 → 空的歷史；壞檔留給下一次寫入時改名保留。"""
    try:
        return _parse(path.read_bytes())
    except FileNotFoundError:
        return AccountUsageHistory()
    except Exception:  # noqa: BLE001 —— 儀表板不能因為這份檔案壞掉而整面失敗
        logger.debug("codex 帳號用量歷史檔讀不懂，先當作空的", exc_info=True)
        return AccountUsageHistory()


def _fsync_dir(directory: Path) -> None:
    """換名（os.replace）本身也要落地：只 fsync 檔案內容，斷電時換名可能沒留下。"""
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_locked(path: Path, now: float) -> AccountUsageHistory:
    """寫入交易內讀檔。沒有檔案 → 空的；讀不懂 → 原檔改名保留、從空的開始、記 warning（不可直接覆蓋）。
    其他 I/O 錯誤（例如沒有讀取權限）照常拋出：讀不到不等於壞掉，這一輪放棄寫入，已存的資料不動。"""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return AccountUsageHistory()
    try:
        return _parse(raw)
    except ValueError:
        kept = path.with_name(f"{path.name}.corrupt-{time.strftime('%Y%m%d-%H%M%S', time.localtime(now))}")
        os.replace(path, kept)
        _fsync_dir(path.parent)   # 改名保留也要落地
        logger.warning("codex 帳號用量歷史檔讀不懂，原檔改名保留為 %s，從空的重新開始", kept.name)
        return AccountUsageHistory()


def _write_atomic(path: Path, history: AccountUsageHistory) -> None:
    """這次專屬的暫存檔（mkstemp 建立時就是 0600）→ fsync → os.replace → fsync 目錄；失敗時清掉暫存檔、
    原檔不動，目錄同步失敗也往外拋（背景工作記 warning、下一輪重來）。

    目錄一定要同步（Codex plan R2）：上游每天往後滑一天，這次回應裡最舊的那天只在今天拿得到，這次寫入若因
    斷電沒留下，隔天就補不回來。保證等級（spec §7）：macOS 上一般 fsync 不保證寫進實體磁碟（沒用
    F_FULLFSYNC），極端斷電時最近一次寫入仍可能遺失。

    allow_nan=False：讀取端不收 inf／NaN，寫進去下一次讀檔就判成壞檔、整份改名重來（Codex plan R1）。
    這一輪改成往外拋，已存的檔不動。"""
    payload = json.dumps({"version": VERSION, "accounts": history.accounts, "final": history.final,
                          "windows": history.windows, "default_model": history.default_model,
                          "fetches": history.fetches},
                         ensure_ascii=False, sort_keys=True, allow_nan=False)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    _fsync_dir(path.parent)   # 換名本身也要落地


def _merge(path: Path, res: dict, now: float) -> None:
    """把一次成功的抓取併進歷史檔（呼叫端已持有鎖，spec 5.2）。

    這次回傳的日期覆蓋該帳號的舊值、沒回傳的保留、超過 RETENTION_DAYS 天的刪掉；除了最新那天都標成定稿
    （同一次回應裡已經有更晚的日期——最新那天出現後還會變）；額度窗口跟現有某一筆差不到 10 分鐘就更新那一筆，
    否則新增，一律按 start 排序；default_model 是 None 時沿用舊值；另記一筆抓取觀察 {at, first, last, count, tail}。"""
    # 鎖內重新讀：不可拿之前讀到的內容去合併，否則會蓋掉另一個 Fledge 剛存進去的日期（spec 5.2）
    history = _read_locked(path, now)
    key, daily = res["account_key"], res["daily"]
    history.accounts.setdefault(key, {}).update(daily)
    newest = max(daily, default=None)
    history.final[key] = sorted(set(history.final.get(key, [])) | {d for d in daily if d != newest})
    cutoff = day_label(day_of(now) - RETENTION_DAYS)
    for k, days in history.accounts.items():
        history.accounts[k] = {d: t for d, t in days.items() if d >= cutoff}
    for k, days in history.final.items():
        history.final[k] = [d for d in days if d >= cutoff]
    if res["default_model"] is not None:
        history.default_model = res["default_model"]
    window = res.get("window")
    if window is not None:
        # 同一個窗口就換成這次的值（小幅漂移不會累積成「新的一輪」）；按 start 排，延遲寫入的舊窗口落回原位
        ws = [w for w in history.windows.get(key, [])
              if abs(w["resets_at"] - window["resets_at"]) >= WINDOW_TOLERANCE_SEC]
        ws.append({"start": window["start"], "resets_at": window["resets_at"]})
        ws.sort(key=lambda w: w["start"])
        history.windows[key] = ws[-MAX_WINDOWS:]
    history.fetches.append({"at": now, "first": min(daily, default=None), "last": newest, "count": len(daily),
                            "tail": {d: daily[d] for d in sorted(daily)[-2:]}})
    del history.fetches[:-MAX_FETCHES]
    _write_atomic(path, history)


def refresh(path: Path, fetch: Callable[[], dict], now: float) -> dict:
    """背景更新的整段交易（spec 5.2）：跨程序鎖 → 抓取 → 成功才鎖內重讀、合併、寫入。回傳抓取結果。

    抓取也在鎖裡：兩個 Fledge 同時開時，後寫入的一定是後抓到的——否則先抓到舊數字的那個晚一步寫入，會把另一個
    剛寫進去、往上修過的數字蓋回去（spec §1：bucket 出現後還會變）。鎖最長被佔一次抓取的逾時；程序結束時
    flock 跟著檔案描述符釋放。抓取失敗不寫入任何東西（鎖檔照樣建立）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = os.open(path.with_name(path.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        res = fetch()
        if res.get("source") == "live":
            _merge(path, res, now)
        return res
    finally:
        os.close(lock_fd)   # 關掉 fd 就釋放 flock

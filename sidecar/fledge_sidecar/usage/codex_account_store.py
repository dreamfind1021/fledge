"""Codex 帳號每日用量的歷史檔（design：docs/planning/codex-unattributed-usage-design.md §5.2）。

OpenAI 的 `account/usage/read` 只給最近 10 天，超過的部分無法重建，所以放 `~/.fledge/`（跟
account-activity.jsonl 同層），不放可以整個刪掉重建的 `cache/`。內容：每個帳號一組 {date: tokens}、
Codex 預設模型、最近幾次抓取的觀察紀錄（上游何時發布前一天、零用量日回不回傳都還沒確認，靠這份紀錄
回頭查；打包版的 sidecar log 沒有落地，記在 log 裡等於沒記）。

寫入是一個交易：跨程序檔案鎖 → 鎖內重新讀檔 → 合併 → 這次專屬的暫存檔 → fsync → os.replace → fsync 目錄。
兩個 Fledge 同時開，也不會蓋掉對方已存、上游已經不給的日期。讀取端（儀表板）不拿鎖：os.replace 是原子的。
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fledge_sidecar.api.codex_usage import is_iso_date
from fledge_sidecar.app_config import default_config_path

logger = logging.getLogger(__name__)

VERSION = 1
RETENTION_DAYS = 400
MAX_FETCHES = 240          # 每 3 小時抓一次 ≈ 30 天


@dataclass
class AccountUsageHistory:
    accounts: dict[str, dict[str, int]] = field(default_factory=dict)
    default_model: str | None = None
    fetches: list[dict] = field(default_factory=list)


def default_path() -> Path:
    override = os.environ.get("FLEDGE_CODEX_ACCOUNT_USAGE")
    if override:
        return Path(override)
    return default_config_path().parent / "codex-account-usage.json"


def _parse(raw: bytes) -> AccountUsageHistory:
    """檔案內容 → 歷史。任何一處形狀不對都拋 ValueError（JSON／UTF-8 解碼錯誤本來就是它的子類）。"""
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict) or data.get("version") != VERSION:
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
    return AccountUsageHistory(accounts=accounts, default_model=model, fetches=fetches)


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
    F_FULLFSYNC），極端斷電時最近一次寫入仍可能遺失。"""
    payload = json.dumps({"version": VERSION, "accounts": history.accounts,
                          "default_model": history.default_model, "fetches": history.fetches},
                         ensure_ascii=False, sort_keys=True)
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


def merge(path: Path, account_key: str, daily: dict[str, int], default_model: str | None, now: float) -> None:
    """把一次抓取併進歷史檔（spec 5.2 的寫入交易）。

    這次回傳的日期覆蓋該帳號的舊值、沒回傳的保留、超過 RETENTION_DAYS 天的刪掉（以 UTC 日期算）；
    default_model 是 None 時沿用舊值；另記一筆抓取觀察 {at, first, last, count}，只留最近 MAX_FETCHES 筆。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = os.open(path.with_name(path.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        # 鎖內重新讀：不可拿之前讀到的內容去合併，否則會蓋掉另一個 Fledge 剛存進去的日期（spec 5.2）
        history = _read_locked(path, now)
        history.accounts.setdefault(account_key, {}).update(daily)
        cutoff = (datetime.fromtimestamp(now, timezone.utc).date() - timedelta(days=RETENTION_DAYS)).isoformat()
        for key, days in history.accounts.items():
            history.accounts[key] = {d: t for d, t in days.items() if d >= cutoff}
        if default_model is not None:
            history.default_model = default_model
        history.fetches.append({"at": now, "first": min(daily, default=None),
                                "last": max(daily, default=None), "count": len(daily)})
        del history.fetches[:-MAX_FETCHES]
        _write_atomic(path, history)
    finally:
        os.close(lock_fd)   # 關掉 fd 就釋放 flock

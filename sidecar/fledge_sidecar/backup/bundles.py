"""備份包清單（純函式）。

**只認 `claude-backup-YYYYMMDD-HHMM.tar.gz` 這個確切形狀。** 半成品被顯示成一次成功的
備份，是這張卡最危險的失敗模式——使用者會看到「0 天前」配正常色，而那次其實沒跑完。
掃描端因此嚴格比對；寫入端保證最終檔名只在驗證通過後才出現（見備份執行票）。

內容層 no-raise（與 usage parser 同契約）：畸形檔名與讀不到的項目一律跳過。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime

_BUNDLE_RE = re.compile(r"^claude-backup-(\d{8})-(\d{4})\.tar\.gz$")


@dataclass(frozen=True)
class Bundle:
    name: str
    created_ts: float
    size_bytes: int


def _parse_stamp(day: str, hhmm: str) -> datetime | None:
    """檔名時間戳 → 本地時間 datetime。腳本用 `date +%Y%m%d-%H%M` 產生，本來就是本地時間，
    所以這裡回 naive datetime、由 `.timestamp()` 以本地時區解讀，兩邊一致。"""
    try:
        return datetime.strptime(f"{day}{hhmm}", "%Y%m%d%H%M")
    except ValueError:
        return None


def list_bundles(directory: str) -> list[Bundle]:
    """倒序（新到舊）。目錄不存在或讀不到回空清單。"""
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return []

    out: list[Bundle] = []
    for entry in entries:
        m = _BUNDLE_RE.match(entry.name)
        if m is None:
            continue
        stamp = _parse_stamp(m.group(1), m.group(2))
        if stamp is None:
            continue  # 形狀對但時間戳無效（如 20261340）
        try:
            if not entry.is_file(follow_symlinks=False):
                continue  # 同名資料夾不算備份包
            size = entry.stat().st_size
        except OSError:
            continue
        out.append(Bundle(name=entry.name, created_ts=stamp.timestamp(), size_bytes=size))

    out.sort(key=lambda b: b.created_ts, reverse=True)
    return out


def days_since(last_ts: float | None, now: datetime) -> int | None:
    """本地時區的**日曆日差**（今天備份完＝0、昨天＝1），不是 24 小時整除。

    使用者說「幾天前」時想的是日曆：凌晨 00:30 看昨天 23:30 的備份，只差一小時，
    但那確實是「昨天」備份的。"""
    if last_ts is None:
        return None
    return (now.date() - datetime.fromtimestamp(last_ts).date()).days

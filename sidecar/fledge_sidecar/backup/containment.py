"""備份輸出目錄的 containment 防呆（純函式）。

輸出目錄從寫死改成使用者用系統選擇器挑之後，才第一次出現這個面：**選到來源樹裡面，
「來源全程唯讀」這條腳本的核心不變式就不成立**。腳本會在輸出目錄底下建暫存區，而
`projects` 之類的帳號目錄內容本身是備份來源——複製來源時會把正在寫入的暫存區一起收進去。

**這是防呆，不是安全邊界**：它防的是使用者誤選，不防惡意的本機行為者。檢查完到腳本
實際寫入之間存在 symlink TOCTOU（inode 比對只證明「檢查當下」的身分），這個殘餘 race
是刻意接受的——能利用那個窗口的角色，本來就已經能直接讀寫帳號目錄，TOCTOU 沒有增加
任何實際能力。**不要為它加防禦**：付出的複雜度買不到對應的安全性。

判定走 `paths.is_same_or_within()`＝(st_dev, st_ino) 比對而非字串：macOS 的 APFS 預設
不分大小寫，`~/.claude` 與 `~/.CLAUDE` 是同一個目錄但字串不等；symlink 別名同理。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.paths import is_same_or_within, same_dir

Containment = Literal["ok", "inside_source", "is_home", "is_root"]

# 與 bash 腳本共用的額外來源清單檔名。常數獨立匯出，供對帳測試斷言兩邊指向同一個檔案。
EXTRA_PATHS_FILENAME = "backup-extra-paths.txt"


def extra_paths_file(scripts_dir: str) -> str:
    return os.path.join(scripts_dir, EXTRA_PATHS_FILENAME)


def load_extra_paths(scripts_dir: str) -> list[str]:
    """讀共用來源清單檔：`#` 開頭為註解、空行忽略、`~` 展開。

    **讀不到一律回空清單而非報錯**——少一個 root 只會讓防呆變寬鬆，不會造成錯誤的阻擋；
    報錯反而會讓整張卡片壞掉。"""
    try:
        raw = Path(extra_paths_file(scripts_dir)).read_text(encoding="utf-8")
    except OSError:
        return []
    out: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append(str(Path(stripped).expanduser()))
    return out


def source_roots(config: AppConfig, scripts_dir: str) -> list[str]:
    """備份會讀的所有來源：每個帳號的 config_dir ∪ 共用清單檔裡的路徑。

    帳號元素可能缺 `config_dir`（`app_config` 刻意保留畸形項目而不丟棄），退回預設值處理
    ——這裡寧可多算一個 root，也不要因為一筆壞資料讓整個防呆失效。"""
    accounts = [
        str(Path(acc.get("config_dir") or "~/.claude").expanduser())
        for acc in config.accounts.values()
    ]
    return accounts + load_extra_paths(scripts_dir)


def check_backup_dir(abs_path: str, roots: list[str]) -> Containment:
    """`abs_path` 必須是 `paths.expand_and_validate()` 的輸出（絕對路徑）。"""
    if abs_path == os.sep:
        return "is_root"
    if same_dir(abs_path, str(Path.home())):
        return "is_home"
    if any(is_same_or_within(abs_path, root) for root in roots):
        return "inside_source"
    return "ok"

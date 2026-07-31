"""還原：備份包解析、展開位置防呆、argv 組裝。

**本模組沒有任何寫入現役目錄的能力**（票 09 驗收 #6 是結構性的，不是預設值）：它只做
「哪一份備份包」與「解到哪裡」這兩個決定，展開本身交給 `scripts/restore-claude.sh`
（來源全程唯讀、解到獨立位置、只產差異報告）。唯一會寫現役目錄的是 `common_config.repair`
——那是使用者明確按下去的另一條路，不從這裡進入。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.backup.bundles import list_bundles
from fledge_sidecar.backup.containment import check_backup_dir
from fledge_sidecar.backup.script import restore_script_path
from fledge_sidecar.paths import expand_and_validate, probe_dir

# 展開位置的判定結果。前四個與備份輸出目錄共用同一組規則（`check_backup_dir`），
# 後三個是「這個位置現在能不能解東西進去」。
DestVerdict = Literal[
    "ok", "is_root", "is_home", "inside_source", "not_empty", "not_dir", "denied",
]

_BUNDLE_PREFIX = "claude-backup-"
_BUNDLE_SUFFIX = ".tar.gz"
# 展開目錄的命名：帶備份包時間戳，所以同時還原兩份包不會互相覆蓋，使用者也從目錄名
# 就看得出這是哪一份。
_DEST_PREFIX = ".claude-restore-"


def resolve_backup_dir(config: AppConfig) -> str:
    """備份包的來源目錄。不可用一律 `ValueError(<判別碼>)`，由 route 轉 400。

    **刻意不驗 containment**：「輸出不能落在讀取來源裡面」是備份**寫入**的規則。備份目錄
    位置不理想，並不會讓裡面既有的備份包變得不能讀——拿那條規則擋還原只是製造一個死路，
    而且死在使用者最需要備份包的時候。"""
    raw = (config.backup_dir or "").strip()
    if not raw:
        raise ValueError("backup_dir_not_set")
    try:
        abs_dir = expand_and_validate(raw)
    except ValueError as exc:
        raise ValueError("backup_dir_invalid") from exc
    if probe_dir(abs_dir) != "dir":
        raise ValueError("backup_dir_unusable")
    return abs_dir


# 預設位置撞名時最多往後找幾號。找不到就回最後一個候選，讓 `check_dest` 照常回 not_empty
# ——**不無界迴圈**：真的堆了這麼多沒清的展開目錄時，該讓使用者看到訊息去處理，而不是讓
# 一支唯讀的預覽端點在那裡數目錄。
_MAX_DEST_SUFFIX = 50


def _dest_is_free(path: str) -> bool:
    """這個位置現在能不能直接用（不存在，或存在但是空目錄）。"""
    status = probe_dir(path)
    if status == "missing":
        return True
    if status != "dir":
        return False
    try:
        return not os.listdir(path)
    except OSError:
        return False


def resolve_dest(dest_raw: str | None, bundle_name: str) -> str:
    """展開位置 → 絕對路徑；沒給就用預設。不是合法絕對路徑 → `ValueError("dest_invalid")`。

    plan 與 spawn 前的閘共用同一支：兩邊各自解讀「沒給」或「相對路徑」必然漂移，而漂移的
    後果是預覽說可以、按下去卻被擋。

    **預設位置撞名時往後加序號**（比照 `common_config._backup`）：跑過一次之後回到卡片，
    預設位置正是上次的展開結果（非空），使用者會看到「預設值＋警告＋停用的按鈕」——
    app 不該建議一個自己隨後會拒絕的位置（真機驗收抓到）。

    **使用者自己指定的位置不套這個**：他選什麼就是什麼，非空由 `check_dest` 照樣擋。
    悄悄把他選的 X 換成 X-1，等於在他沒看到的地方改掉他的決定。"""
    raw = (dest_raw or "").strip()
    if raw:
        try:
            return expand_and_validate(raw)
        except ValueError as exc:
            raise ValueError("dest_invalid") from exc
    try:
        base = expand_and_validate(default_dest(bundle_name))
    except ValueError as exc:
        raise ValueError("dest_invalid") from exc
    candidate = base
    for n in range(1, _MAX_DEST_SUFFIX + 1):
        if _dest_is_free(candidate):
            break
        candidate = f"{base}-{n}"
    return candidate


def bundle_path(backup_dir_abs: str, name: str) -> str:
    """備份包名 → 絕對路徑。**這是 allowlist**：只接受 `list_bundles` 真的列出來的名字。

    前端送的是名字而不是路徑（沿用 `kind=install` 只送 `install_id` 的取向），所以路徑
    穿越、絕對路徑、以及「檔案確實存在但不是備份包形狀」都在這裡被擋掉——argv 裡的 tar
    輸入不能是一個任意路徑。不在清單內一律 `ValueError("unknown_bundle")`。"""
    if name not in {b.name for b in list_bundles(backup_dir_abs)}:
        raise ValueError("unknown_bundle")
    return os.path.join(backup_dir_abs, name)


def default_dest(bundle_name: str) -> str:
    """預設展開位置：`~/.claude-restore-<備份包時間戳>`。

    `bundle_name` 必須是過了 `bundle_path` 的名字，故形狀已知；仍用 removeprefix/suffix
    而非索引切片，畸形名字最壞只是目錄名醜，不會切出一個奇怪的路徑。"""
    stamp = bundle_name.removeprefix(_BUNDLE_PREFIX).removesuffix(_BUNDLE_SUFFIX)
    return str(Path.home() / f"{_DEST_PREFIX}{stamp}")


def check_dest(abs_path: str, roots: list[str]) -> DestVerdict:
    """展開位置能不能用。`abs_path` 必須是 `paths.expand_and_validate()` 的輸出。

    **containment 排在空不空之前**：位置結構上就選錯時先講那件事——把那個目錄清空也不會
    讓它變成一個合理的位置。與備份輸出目錄共用 `check_backup_dir`：兩者要防的是同一件事
    （輸出落在讀取來源裡面），規則分兩份寫必然漂移。"""
    verdict = check_backup_dir(abs_path, roots)
    if verdict != "ok":
        return verdict
    status = probe_dir(abs_path)
    if status == "missing":
        return "ok"          # 腳本會建（連父目錄一起）
    if status == "not_dir":
        return "not_dir"
    if status == "denied":
        return "denied"
    try:
        entries = os.listdir(abs_path)
    except OSError:
        # probe_dir 用 os.stat，stat 得到不代表列得出內容（ACL、掛載選項）。
        # 讀不到就說讀不到——防呆不得 fail-open。
        return "denied"
    return "ok" if not entries else "not_empty"


def build_restore_argv(bundle_abs: str, dest_abs: str) -> list[str]:
    """組還原的 argv。兩個選擇比照 `script.build_argv`：

    1. **不經 `-lc`**：備份包路徑與展開位置都可能含空白或引號，組 shell 字串等於自己開一個
       quoting 漏洞，argv 直傳沒有這個面。
    2. **顯式帶 `/bin/bash`**：PyInstaller 的 `datas` 不保證保留執行位元，靠 shebang 會在
       打包版變成 EACCES。
    """
    return ["/bin/bash", restore_script_path(), bundle_abs, "-o", dest_abs]

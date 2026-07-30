"""備份腳本與其周邊資源的位置。

路徑解析沿用 `setup/templates.py` 的 `templates_root()` 三段式：env 覆蓋（測試用）
＞ 凍結資料目錄（PyInstaller onedir）＞ repo 內的實體目錄。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_FILENAME = "backup-claude.sh"

# python3 探測的執行上限（秒）。比照 setup/env_detect.py 的 _VERSION_TIMEOUT：
# status route 每次都會探，不能讓它卡住整張卡片。
_PYTHON_PROBE_TIMEOUT = 2


def scripts_root() -> str:
    """備份腳本與共用來源清單檔所在的目錄。

    兩者必須同目錄——`containment.load_extra_paths()` 由此取檔，打包後
    （`_MEIPASS/scripts/`）也維持同樣的相鄰關係，「單一權威」在打包版才仍然成立。"""
    override = os.environ.get("FLEDGE_BACKUP_SCRIPTS_DIR")
    if override:
        return override
    if getattr(sys, "frozen", False):
        return str(Path(getattr(sys, "_MEIPASS")) / "scripts")
    # dev：repo 的 scripts/（本檔在 sidecar/fledge_sidecar/backup/ 之下）
    return str(Path(__file__).resolve().parents[3] / "scripts")


def backup_script_path() -> str:
    return os.path.join(scripts_root(), SCRIPT_FILENAME)


def script_available() -> bool:
    return os.path.isfile(backup_script_path())


def build_argv(backup_dir_abs: str, mode: str) -> list[str]:
    """組備份／預覽的 argv。`backup_dir_abs` 必須已過 `paths.expand_and_validate()`。

    兩個刻意的選擇：

    1. **不經 `-lc`**。`kind=install` 走 `-lc` 是因為安裝命令本來就是 shell 字串；
       這裡的 `backup_dir` 是使用者用系統選擇器挑的路徑（可能含空白、引號），
       組 shell 字串等於自己開一個 quoting 漏洞，argv 直傳沒有這個面。
    2. **顯式帶 `/bin/bash`** 而非依賴腳本的 shebang——PyInstaller 的 `datas`
       不保證保留執行位元，靠 shebang 會在打包版變成 EACCES。
    """
    argv = ["/bin/bash", backup_script_path(), "-o", backup_dir_abs]
    if mode == "list":
        argv.append("--list")
    return argv


def python3_available(which=shutil.which, run=subprocess.run) -> bool:
    """腳本兩處呼叫系統 `python3`（讀 accounts、產 manifest），而 sidecar 自帶的
    PyInstaller runtime **不會**在 PATH 上留下可供 shell 呼叫的 `python3`。

    **which 命中只是必要條件，還要實際執行一次**：macOS 未裝 Command Line Tools 時
    `/usr/bin/python3` 是個 stub，which 會命中但執行會失敗或彈安裝對話框，只看 which
    會給出錯誤的綠燈。which/run 以參數注入，比照 `setup/env_detect.py` 便於測試。
    """
    if which("python3") is None:
        return False
    try:
        proc = run(["python3", "-c", ""], capture_output=True, timeout=_PYTHON_PROBE_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0

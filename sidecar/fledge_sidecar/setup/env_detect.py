"""開發工具偵測（純函式）：shutil.which + 版本探測，以及 git 身分（票 32）。

which/run 以參數注入，便於測試（不真的呼叫系統）。內容層不拋例外：
版本探測失敗（OSError/SubprocessError/timeout）→ version=None，不中斷。
"""
from __future__ import annotations

import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

from fledge_sidecar.setup.install_specs import TOOL_SPECS, ToolSpec

# 版本探測上限（秒）。status route 會對所有已安裝工具探版本；用短 timeout + 平行化，
# 把最壞延遲壓在 ~_VERSION_TIMEOUT（而非 N×timeout），避免 onboarding「重新檢查」卡頓（plan review #2）。
_VERSION_TIMEOUT = 2
_MAX_PROBE_WORKERS = 8


@dataclass(frozen=True)
class ToolStatus:
    id: str
    label: str
    tier: str
    installed: bool
    path: str | None
    version: str | None
    # 以下三欄純供 UI 顯示：未安裝時沒有 version 可列，改列 binary 名；有 install_command
    # 才給一鍵安裝按鈕，只有 manual_command（如 Homebrew）則給「複製指令」。
    # 露出命令字串不鬆動 allowlist：PTY 執行仍只吃 install_id 查表，前端永不傳 raw command；
    # 反過來說，畫面顯示的命令與實際執行的命令因此同源（spec §5 要求安裝前顯示完整命令）。
    binary: str
    install_command: str | None
    manual_command: str | None


def _probe_version(argv: list[str], run) -> str | None:
    try:
        proc = run(argv, capture_output=True, text=True, timeout=_VERSION_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None
    out = (proc.stdout or proc.stderr or "").strip()
    return out.splitlines()[0] if out else None


def _merge_spec_fields(spec: ToolSpec, path: str | None, version: str | None) -> ToolStatus:
    """把 spec 的顯示欄位併進偵測結果（note 為空字串時視同沒有手動指令）。

    一律具名傳參：相鄰四個 `str | None` 欄位錯位型別擋不下來。"""
    return ToolStatus(
        id=spec.id, label=spec.label, tier=spec.tier,
        installed=path is not None, path=path, version=version,
        binary=spec.binary, install_command=spec.install_command,
        manual_command=spec.note or None,
    )


def detect_tool(spec: ToolSpec, which=shutil.which, run=subprocess.run) -> ToolStatus:
    """偵測單一工具：which 命中才探版本；未裝跳過探測（省時）。"""
    path = which(spec.binary)
    if path is None:
        return _merge_spec_fields(spec,None, None)
    # 探測用 which 解析出的絕對路徑：裸名重查 PATH 可能命中另一個執行檔（path 與 version 不同源）
    version = _probe_version([path, *spec.version_argv[1:]], run)
    return _merge_spec_fields(spec,path, version)


def detect_all(specs=TOOL_SPECS, which=shutil.which, run=subprocess.run) -> list[ToolStatus]:
    """平行偵測全表工具，保序回傳（UI 分組依賴順序穩定）。"""
    # 平行探測：version probe 是 I/O bound，逐一跑最壞達 N×timeout（UI 會卡）。
    # ThreadPoolExecutor.map 保留輸入順序（UI 分組依賴順序穩定）。
    with ThreadPoolExecutor(max_workers=_MAX_PROBE_WORKERS) as ex:
        return list(ex.map(lambda s: detect_tool(s, which=which, run=run), specs))


# 三態而不是 bool：「查不到」（git 出錯、逾時、設定檔壞掉）不能壓成「沒設」——
# 環境頁只對 missing 顯示「去設定」的提醒，誤判會叫已經設好的人覆寫自己的身分。
IdentityState = Literal["set", "missing", "unknown"]


@dataclass(frozen=True)
class GitIdentity:
    name: IdentityState
    email: IdentityState


def _probe_git_config(git_path: str, key: str, run) -> IdentityState:
    try:
        # 不加 text=True：只需要知道「有沒有輸出」，不需要值本身。解碼成文字的話，舊編碼存的
        # 名字（如 Latin-1 的 José）會拋 UnicodeDecodeError，拖垮整個環境偵測（Codex 審查 F1）
        proc = run([git_path, "config", "--global", "--includes", "--get", key],
                   capture_output=True, timeout=_VERSION_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    stdout = (proc.stdout or b"").strip()
    stderr = (proc.stderr or b"").strip()
    if proc.returncode == 0:
        # 設成空字串也是 exit 0（只印換行）；commit 一樣拿不到值，對使用者等於沒設
        return "set" if stdout else "missing"
    # git config 找不到 key 的 exit 1 完全沒有輸出；帶錯誤訊息的 exit 1 或其他結束碼
    # （設定檔壞掉是 128）都是別的狀況
    if proc.returncode == 1 and not stdout and not stderr:
        return "missing"
    return "unknown"


def detect_git_identity(git_path: str | None, run=subprocess.run) -> GitIdentity:
    """讀 git 的全域身分（唯讀，Fledge 不寫 ~/.gitconfig）；只回狀態，不回名字與 email 本身。

    `git_path` 用 detect_all 偵測到的那支 git（與版本探測同源）；None＝沒裝，不查。
    --global 涵蓋 ~/.gitconfig 與 ~/.config/git/config，且不受 cwd 所在 repo 的本地設定影響。
    --includes 必加：指定 --global 時 git 預設不跟 [include]，身分放在 include 檔（dotfiles 常見）
    的人會被誤判成沒設。已知限制：只在特定資料夾生效的 [includeIf] 身分查不到，會被提醒。"""
    if git_path is None:
        return GitIdentity(name="unknown", email="unknown")
    return GitIdentity(
        name=_probe_git_config(git_path, "user.name", run),
        email=_probe_git_config(git_path, "user.email", run),
    )

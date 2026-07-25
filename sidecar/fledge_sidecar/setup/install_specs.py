"""開發工具資料表 + allowlist 安裝命令解析。

安全不變式（spec §5）：安裝命令只能來自本檔的 `install_command` 常數；
route 以 install_id 查表，前端不得傳任意 command string。
install_command 為內建固定字串，會以 [shell, "-lc", install_command] 在 PTY 執行。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ToolSpec:
    id: str                 # 穩定識別碼；前端只傳這個（allowlist key）
    label: str              # 顯示名
    tier: str               # "core" | "recommended"
    binary: str             # shutil.which 偵測用
    version_argv: list[str]  # 版本探測命令（含 binary）
    install_command: str | None  # 內建固定 shell 命令；None=僅手動（如 Homebrew 本體）
    docs_url: str
    note: str = ""


# 平台：macOS（Homebrew 生態）。install_command 為常數，2026-07-25 已對照官方文件確認。
TOOL_SPECS: list[ToolSpec] = [
    ToolSpec(
        "homebrew", "Homebrew", "core", "brew", ["brew", "--version"],
        None,  # 官方安裝為互動式 curl 腳本、需 sudo；列「複製指令」而非一鍵
        "https://brew.sh",
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    ),
    ToolSpec(
        "node", "Node.js", "core", "node", ["node", "--version"],
        "brew install node", "https://nodejs.org",
    ),
    ToolSpec(
        "git", "Git", "core", "git", ["git", "--version"],
        "brew install git", "https://git-scm.com",
    ),
    ToolSpec(
        "claude", "Claude Code CLI", "core", "claude", ["claude", "--version"],
        "curl -fsSL https://claude.ai/install.sh | bash",
        "https://docs.anthropic.com/en/docs/claude-code",
    ),
    ToolSpec(
        "codex", "Codex CLI", "core", "codex", ["codex", "--version"],
        "npm install -g @openai/codex", "https://github.com/openai/codex",
    ),
    ToolSpec(
        "python", "Python 3", "recommended", "python3", ["python3", "--version"],
        "brew install python", "https://www.python.org",
    ),
    ToolSpec(
        "uv", "uv", "recommended", "uv", ["uv", "--version"],
        "brew install uv", "https://docs.astral.sh/uv/",
    ),
    ToolSpec(
        "gh", "GitHub CLI", "recommended", "gh", ["gh", "--version"],
        "brew install gh", "https://cli.github.com",
    ),
]

_BY_ID: dict[str, ToolSpec] = {s.id: s for s in TOOL_SPECS}


def get_spec(tool_id: str | None) -> ToolSpec | None:
    """以 id 查工具規格；未知 id 或 None 回 None。"""
    if tool_id is None:
        return None
    return _BY_ID.get(tool_id)


def get_install_command(tool_id: str | None) -> str | None:
    """回該 id 的固定安裝命令；未知 id 或僅手動（install_command is None）皆回 None。"""
    spec = get_spec(tool_id)
    if spec is None:
        return None
    return spec.install_command

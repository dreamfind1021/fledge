# Fledge — AI Workflow Studio

> **Where your AI projects take off.**
> Run AI on your projects — without the terminal or the IDE.
>
> <sub>Built for Claude Code.</sub>

Fledge 是一個 **AI 工作流工作室（AI Workflow Studio）**——以「專案 + AI session」為組織單位，讓你不碰終端機的繁瑣（cd、找路徑、記帳號）、也不碰 VS Code 的複雜，就能對每個專案啟動 AI、推進工作。底層跑真實的 Claude Code CLI，繼承你所有的 skills / CLAUDE.md / MCP / 帳號設定。

## 為什麼

- 讓自己的 AI 工作流更順暢
- 讓這套工作方式能教給同仁、更快上手

## 定位

| 對照 | Fledge 贏在哪 |
|---|---|
| 裸終端機 | 補上「專案管理層」——點一下用對的帳號 / 目錄開好 AI session，不必每次 cd |
| VS Code | 極簡、AI 為中心——砍掉所有用不到的工程功能，輕到不害怕 |

技術路線：套殼不重做（路線 B）——不重做 Claude Code，只在外層加一層友善介面。

## 技術棧

- Tauri 2.x（Rust 殼，管 .app 安裝與 sidecar 生命週期）
- Python sidecar（FastAPI + ptyprocess，專案掃描 / PTY 橋接 / 設定）
- React + TypeScript（Vite）
- xterm.js 嵌入終端機

## 安裝（macOS Apple Silicon）

### 終端機（推薦）

```bash
curl -fsSL https://raw.githubusercontent.com/dreamfind1021/fledge/main/scripts/install.sh | bash
```

裝進 `/Applications`，從 Spotlight / Launchpad 開即可。（用 `bash` 不是 `sh`——腳本依賴 bash + `pipefail`。）

### .dmg（GUI）

到 [Releases](https://github.com/dreamfind1021/fledge/releases) 下載 `Fledge_*_aarch64.dmg`，拖進 Applications。

> ⚠ 目前未經 Apple 簽章。首次開啟若被 Gatekeeper 擋（「App 已損毀」），到
> **系統設定 › 隱私與安全性 › 仍要打開**，或執行：
> `xattr -dr com.apple.quarantine /Applications/Fledge.app`

## 開發

```bash
# Python sidecar 環境
cd sidecar && python3 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
pytest

# 前端 + Tauri（先確保 cargo 在 PATH）
. "$HOME/.cargo/env"
npm install
npm run tauri dev
```

## 狀態

核心功能就緒並經真機驗證：專案/帳號管理、在 GUI 視窗內啟動真實 Claude Code session、品牌主題與分頁活動指示、桌面打包（macOS Apple Silicon，onedir sidecar + curl/dmg 安裝）。

## License

[MIT](LICENSE)

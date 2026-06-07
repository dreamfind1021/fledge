# Fledge — AI Workflow Studio

> **Where your AI projects take off.**
> Run AI on your projects — without the terminal or the IDE.
>
> <sub>Built for Claude Code.</sub>

![platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-111827)
![license](https://img.shields.io/badge/license-MIT-blue)
![built for](https://img.shields.io/badge/built%20for-Claude%20Code-F59E42)

**English** · [繁體中文](README.md)

Fledge is an **AI Workflow Studio** — it organizes your work around "**project + AI session**", so you can launch AI on any project and get going without the chores of the terminal (digging through folders, right-click → open terminal, typing commands, remembering which account) and without the complexity of an IDE.

Under the hood it drives **the real Claude Code CLI on your machine** — no reimplementation, no proxy. Because it runs your actual `claude`, it inherits everything you already have: skills, `CLAUDE.md`, MCP, signed-in accounts. Fledge just adds a friendly layer of "project management + multiple accounts + tabs" on top.

<p align="center">
  <img src="assets/screenshot-app.png" alt="Fledge — a real Claude Code session running inside the GUI" width="820">
</p>

## Why I built this

I'm not from a software-engineering background — I'm a vibe coder who builds with AI. One or two projects was fine, but as they piled up, starting work became the same ritual every time: dig through Finder for the right project folder, right-click to open a terminal there, type a command to fire up `claude` — and remember which account this project should use along the way. Just getting set up drained a lot of the motivation to actually start.

Fledge is the comfortable workspace I built for myself: it collapses "which project, which account, start an AI session" into a single click, leaving the energy for the work that actually matters.

## Where it fits

| vs. | What Fledge gives you |
|---|---|
| A bare terminal | A "project management layer" — one click opens an AI session with the right account/folder, no more digging through folders, opening a terminal, and typing commands every time |
| An IDE | Minimal and AI-first — none of the engineering features you never use; light enough that you're never afraid to open it, and when you do, it's to work with AI |

The approach is **a shell, not a rewrite**: Fledge doesn't reimplement Claude Code, it just wraps it — so when `claude` updates, Fledge doesn't have to follow.

## Install (macOS Apple Silicon)

**Requirements:** macOS on Apple Silicon (arm64), with the **Claude Code CLI (`claude`) already installed and signed in**. Fledge launches the real `claude` on your machine, so it has to work in your terminal first — see the [Claude Code docs](https://docs.claude.com/en/docs/claude-code) to install it.

### Terminal (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/dreamfind1021/fledge/main/scripts/install.sh | bash
```

Installs to `/Applications`; open it from Spotlight/Launchpad. (Use `bash`, not `sh` — the script relies on bash and `pipefail`.)

### .dmg (GUI)

Download `Fledge_*_aarch64.dmg` from [Releases](https://github.com/dreamfind1021/fledge/releases) and drag it into Applications.

> ⚠ **Not yet Apple-signed.** A `.dmg` downloaded via a browser may be blocked by Gatekeeper on first launch ("app is damaged"). Fix: go to **System Settings › Privacy & Security › Open Anyway**, or run:
> ```bash
> xattr -dr com.apple.quarantine /Applications/Fledge.app
> ```
> (The `curl` install script doesn't trigger this, since it doesn't set the quarantine flag.)

## Quick start

The first launch walks you through three steps:

1. **Set up an account** — point it at your Claude config directory (e.g. `~/.claude`); add more accounts if you like, each pointing at a different config directory.
2. **Pick a project folder** — Fledge scans the projects under it and lists them in the sidebar.
3. **Click any project** — a real `claude` session opens in a new tab, ready to talk.

After that it's everyday use: click a project on the left, switch tabs at the top, and watch the pulsing dot on each tab to see which session is busy.

## Features

Fledge folds the day-to-day chores of working with AI into the interface:

- **Project-centric** — automatically scans the projects under the folders you choose and organizes them in the sidebar; you can also "open another folder" anytime.
- **Work and personal, cleanly separated** — split work projects from personal ones by account; the sidebar groups by account, each with its own color marker, so it's clear at a glance and nothing bleeds across.
- **Multiple accounts, switch freely** — create several accounts, each with its own Claude config directory and quota; every project remembers its default account, and you can also temporarily "open this one with a different account" without touching any settings.
- **Runs the real Claude Code in a GUI** — the embedded terminal (xterm.js + a PTY bridge) runs the actual `claude`, not a simulation; conversations, skills, MCP, and permission prompts are exactly what you'd see in a terminal.
- **Session tabs + activity indicator** — each "project × account" opens as a tab so you can run several sessions at once; a pulsing dot on each tab shows in real time whether the AI is working or idle.
- **Minimal dark interface** — the Nightfall theme: restrained and AI-first.
- **Native and fast to launch** — packaged as a macOS `.app`; the backend uses an onedir layout (no re-extraction on every launch) for a fast cold start; install via a terminal command or `.dmg`.

## How it works

Fledge is a three-layer architecture, each with one job:

| Layer | Tech | Responsible for |
|---|---|---|
| **Shell** | Tauri 2.x (Rust) | `.app` install, the window, and the backend's lifecycle (start/stop) |
| **Backend** | Python sidecar (FastAPI + ptyprocess) | scanning projects, bridging the PTY (which actually runs `claude`), reading/writing settings (`~/.fledge/config.json`) |
| **Frontend** | React + TypeScript (Vite) | the sidebar/tabs/settings UI; xterm.js for the embedded terminal |

The data flow is: **frontend ↔ backend (HTTP / WebSocket) ↔ PTY ↔ `claude` CLI**. The Rust shell only brings the backend up and tears it down cleanly — including a graceful shutdown so you don't leave orphaned `claude` processes behind after closing the window. For the full module map and impact chain, see [`PROJECT_MAP.md`](PROJECT_MAP.md).

## Development

```bash
# Python sidecar environment
cd sidecar && python3 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
pytest                       # sidecar tests

# Frontend + Tauri (make sure cargo is on PATH first)
. "$HOME/.cargo/env"
npm install
npm test                     # frontend unit tests (vitest)
npm run tauri dev            # launch the app in dev mode
```

For packaging into `.app`/`.dmg`, see [`scripts/`](scripts/) (`build_binary.sh` packages the backend, `bump-version.sh` syncs the version), and [`.github/workflows/release.yml`](.github/workflows/release.yml) for CI.

## Status & roadmap

**Available now (macOS Apple Silicon, verified on real hardware):** project scanning and management, multi-account separation, launching and operating real Claude Code sessions inside the GUI, multiple tabs with activity indicators, the Nightfall dark theme and brand icon, and both `curl` and `.dmg` desktop installs.

**Planned / future directions:**

- Codex support (Claude Code first for now; other AI CLIs to follow)
- Light/dark dual mode (the token layer is ready; the light palette is pending)
- Apple signing + notarization (currently unsigned)
- Other platforms (Windows/Linux)
- In-app auto-update

## License

[MIT](LICENSE)

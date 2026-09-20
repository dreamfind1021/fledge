# Fledge — AI Workflow Studio

> **Where your AI projects take off.**
>
> <sub>Built for Claude Code.</sub>

![platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-111827)
![license](https://img.shields.io/badge/license-MIT-blue)
![built for](https://img.shields.io/badge/built%20for-Claude%20Code-F59E42)

[English](README.en.md) · **繁體中文**

Fledge 是給 vibe coder 的開發與專案管理工具。開發的那一半，是在同一個視窗裡對每個專案跑真實的 Claude Code；專案管理的那一半，不是替團隊分派工作的那種——是給**人和 AI 之間接力**用的。

它以「專案 × AI session」為單位：點一下，就用對的帳號、在對的資料夾，開一個真實的 Claude Code。開工前先看到上次停在哪、還有哪些事沒做；做完的決策有地方放；專案之間的關聯有地方看。不用碰終端機的儀式，也不用面對 IDE 的複雜——但不會因為介面簡單就失憶。

底層跑的是**本機真實的 Claude Code**：不重寫、不中轉。原有的 skills、`CLAUDE.md`、MCP、登入帳號全部原封不動繼承。Fledge 只在外面加一層介面，再加三層記憶。

<p align="center">
  <img src="assets/screenshot-splash.png" alt="Fledge 啟動畫面" width="49%">
  <img src="assets/screenshot-workspace.png" alt="Fledge 工作檯——側欄、分頁、嵌入的 Claude Code session" width="49%">
  <br><sub>左：啟動畫面 · 右：工作檯——側欄選專案、分頁切 session、終端機裡是真實的 Claude Code</sub>
</p>

## 安裝（macOS Apple Silicon）

**前置需求：** macOS、Apple Silicon（arm64），並且**已安裝、登入好 Claude Code CLI（`claude`）**。Fledge 啟動的是本機真實的 Claude Code，所以 `claude` 必須先能在終端機跑起來；安裝見 [Claude Code 官方文件](https://docs.claude.com/en/docs/claude-code)。（還沒裝也行——引導精靈的「開發環境」那一步可以一鍵裝。）

### 終端機（推薦）

```bash
curl -fsSL https://raw.githubusercontent.com/dreamfind1021/fledge/main/scripts/install.sh | bash
```

裝進 `/Applications`，從 Spotlight／Launchpad 開即可。（請用 `bash` 而非 `sh`——腳本依賴 bash 與 `pipefail`。）

### .dmg（GUI）

到 [Releases](https://github.com/dreamfind1021/fledge/releases) 下載 `Fledge_*_aarch64.dmg`，拖進 Applications。

> ⚠ **目前未經 Apple 簽章。** 從瀏覽器下載的 `.dmg` 首次開啟可能被 Gatekeeper 擋（「App 已損毀」）。解法：**系統設定 › 隱私與安全性 › 仍要打開**，或執行：
> ```bash
> xattr -dr com.apple.quarantine /Applications/Fledge.app
> ```
> （`curl` 安裝腳本不會觸發此問題，因為它不打 quarantine 標記。）

> ⚠ **看到「已阻擋 Fledge 取用聯絡人／行事曆」的通知，不用緊張。** Fledge 沒有、也不需要這些權限。這是因為 Claude Code 是 Fledge 的子程序，它叫起來的任何程式（例如 Chrome）順手去查聯絡人時，macOS 把帳記在 Fledge 頭上、直接擋掉。被擋的只是那個順手的查詢，主要工作照樣完成。
>
> **唯一需要手動給的權限是「完整磁碟取用」**，而且只有在 Fledge 裡的 Claude Code 要讀 `~/Library/…` 這類路徑時才需要。授權時選 **Fledge.app**（不是 `claude`）；目前每次更新版本後要關掉再打開一次。完整原因與驗證方式見 [`guides/macos-permissions.md`](guides/macos-permissions.md)。

<!-- 票 22 做完後：把「每次更新版本後要關掉再打開一次」改成「授一次即可」，並刪掉這行註解 -->

## 快速上手

首次啟動的引導精靈會帶你走完：

1. **選工作根目錄**——Fledge 掃描底下第一層子資料夾當專案，列進側欄。可以加多個根。
2. **檢查開發環境**——Homebrew、Node、Git、Claude Code、Codex 各自裝了沒；缺的直接一鍵裝（Homebrew 除外，它要 sudo，精靈會給指令，自己貼到終端機執行）。
3. **登入帳號**——每個帳號各自登入。多帳號的話多一步「共通設置」：把 skills、settings、plugins 用 symlink 串起來，之後裝任何 skill 只要裝一次。
4. **部署範本**——選一個資料夾，放進專案起始骨架或第二大腦的骨架。永不覆蓋已存在的檔案。

之後的日常操作就是：左邊點專案、上面切分頁，看分頁上的呼吸燈就知道哪個 session 正在忙。設定頁隨時可以回去改帳號、加根目錄、做備份。

有備份包的話，歡迎頁選「我有備份」走另一條路：從備份包把帳號設定、skills、專案路徑對應全部搬回來。換機器就是這樣搬的。

## 為什麼做這個

Fledge 一開始只是一個啟動器。專案多到一定程度，每次開工的儀式——翻資料夾、開終端機、敲指令、想帳號——本身就成了阻力，於是有了「點一下就開好 session」這件事。

它後來長出來的每一樣，都對應一種失憶。切換專案時忘了上次做到哪，長出離場筆記；「之後要處理」的事在一個手寫的 `.md` 裡越積越亂，長出待辦面板；研究和發想的筆記散在資料夾裡接不起來，長出第二大腦的結構和記憶面板。啟動器解的是開工的摩擦，後面三樣解的是接續的摩擦——用起來的感覺，離場筆記是短期記憶、待辦是中期、第二大腦是長期。這不是一開始的設計，是用著用著長出來的。

作者是一個靠 AI 寫程式、不是資訊工程出身的 vibe coder。問過工程師怎麼管專案，答案是工程團隊用的那套系統——那是為人和人之間的分工設計的，而這裡要管的是人和 AI 之間的接力。Fledge 是為後者做的。

## 和其他工具的差別

| 對照 | Fledge 的差別 |
|---|---|
| 裸終端機 | 補上「專案管理層」——點一下就用對的帳號／目錄開好 AI session，不必每次翻資料夾、開終端機、敲指令、想帳號 |
| IDE | 極簡、AI 為中心——砍掉一般 IDE 那些用不到的工程功能，輕量到隨手就開，開了就是要跟 AI 工作 |
| 傳統專案管理工具 | 那些管的是團隊裡人和人的分工；Fledge 管的是人和 AI 之間的接力——停在哪、下一步、決策放哪 |

技術路線是**套殼不重做**：不重新實作 Claude Code，只在外層加介面。Claude Code 自己升級時，Fledge 不必跟著改。

## 三層記憶

描述中用「短期、中期、長期」來講，因為那是用起來的感覺。設計上三層的差別不在時間，在**誰決定寫什麼、範圍多寬**：

| 層 | 記什麼 | 誰寫 | 住在哪 | 範圍 |
|---|---|---|---|---|
| **AI 自己記的** | AI 覺得該記的：偏好、踩過的坑、專案事實 | AI 自己決定 | Claude Code 的 per-project memory、`CLAUDE.md` | 一個專案 |
| **你叫 AI 記的** | 停在哪、之後要做什麼 | 你開口、AI 動手 | `.fledge/state.md`、`.fledge/tasks/` | 一個專案；面板跨專案看 |
| **你的第二大腦** | 決策、來源、主題之間的關聯 | 你策展、Fledge 建連結 | 一個 Obsidian vault、`~/.fledge/memory-links.json` | 跨專案、跨帳號 |

很多人對 AI 的抱怨是「它不記得我們在做什麼」。這三層包起來之後，這個抱怨大致消失——不是模型變了，是每一種該記的東西都有了固定的位置，而且 AI 開工時拿得到：`CLAUDE.md` 和它自己的 memory 是它每次啟動就載入的；離場筆記和待辦住在專案裡，開工第一句「先讀 `.fledge/state.md`」就接上；第二大腦在進到那個 vault 時由 hook 餵給它。記憶不在模型裡，在檔案裡。

### AI 自己記的

這一層 Fledge 完全不碰。Claude Code、Codex 這些 CLI 本來就有自己的記憶方式：`CLAUDE.md` 是給它的規矩，per-project memory 是它自己寫的筆記。這一層已經在了，而且做得不錯，不必重做。Fledge 做的是把**所有專案、所有帳號**的這些筆記攤在同一個畫面上（見下面的記憶面板），因為 CLI 自己看不到全貌。

### 你叫 AI 記的

兩樣東西，都住在專案的 `.fledge/` 底下、都不進 git：

- **離場筆記** `.fledge/state.md`——收工時說一聲「寫離場筆記」，AI 把「卡在哪、下一步、踩到的坑」寫進去。下次回來，待辦面板裡那個專案的票清單最上面就是「下一步」那一行；點它，整份筆記在右欄顯示，可以直接改、直接存。筆記末尾若有「貼進新對話的指令」，清單上會多一格，一鍵複製。
- **待辦票** `.fledge/tasks/NN-標題.md`——一件事一個檔案。在面板上建、在對話裡建，同一疊檔案。

這一層要裝兩支 skill 才接得上 AI（`resume-note` 與 `fledge-tasks`，都附在 [`skills/`](skills/)）。沒裝的話面板照常可用，只是 AI 不知道格式，開不了票也寫不了筆記。

### 你的第二大腦

一個放決策、來源、主題之間關聯的 Obsidian vault。結構很簡單：`topics/` 放思考脈絡（一個主題一個資料夾，`CONTEXT.md` 記走到哪、session 卡片記每次談了什麼），`library/` 放外部來源的知識綜合（逐主張引用）。主題之間用 `[[wikilink]]` 互連，frontmatter 的 `tags` 對齊專案名。這個 vault 本身就是側欄裡的一個專案——在裡面開 session 做研究、做發想，AI 讀得到全部脈絡。

Fledge 的**記憶面板**把這個 vault 和「AI 自己記的」那些筆記放在同一個畫面：全文搜尋、依專案分組、看專案和主題之間的連結。開某個專案時，終端機右下角浮出「跟這個專案相關的主題」——那些關聯有一半本來就寫在 vault 的資料夾名和 tags 裡，Fledge 只是把它讀出來。

vault 的骨架附在 Fledge 裡當範本，引導精靈可以直接部署。細節見 [`guides/memory-and-second-brain.md`](guides/memory-and-second-brain.md)。

### 先把界線講清楚

Fledge **不替 AI 記東西，也不把記憶塞進 session**。真的在「記」的是三樣東西：CLI 自己的 memory、你叫它寫的 `.fledge/`、你的第二大腦。Fledge 負責讓它們各有固定的位置、有一個畫面看得到、彼此接得起來。裝了 Fledge，AI 不會自動變聰明——但會少很多失憶。

## 功能一覽

每個功能各一段。要照著做的細節在 [`guides/`](guides/)。

**專案與 session**

- **專案側欄**——自動掃描根目錄底下的專案，依帳號分組、各自上色，工作和私人一眼分開。側欄可以展開專案的檔案樹，把檔案拖進終端機就貼上路徑。
- **多帳號**——每個帳號對應自己的 Claude 設定目錄與額度。專案記住預設帳號，也能臨時「這次改用別的帳號開」。
- **真實的 Claude Code**——嵌入式終端機（xterm.js ＋ PTY 橋接）跑的是真正的 Claude Code。對話、skills、MCP、權限提示，跟終端機裡一模一樣。中文輸入法、複製貼上、右鍵選單這些在 xterm 裡容易壞的地方都修過。
- **多分頁 ＋ 活動指示**——每個「專案 × 帳號」一個分頁，可同時跑多個。分頁上的呼吸燈即時顯示 AI 在忙還是閒著。

**記憶**

- **待辦面板**——左欄專案樹、中欄票清單、右欄票內容，一個畫面看完；「所有專案」頁把各專案進行中與最近新增的票放在一起。可以建票、切狀態、擱置（之後再說、不算未完成）、刪票；票的內文和離場筆記都在右欄直接編輯（票有草稿，切頁不丟字）。→ [`guides/tasks-and-resume-note.md`](guides/tasks-and-resume-note.md)
- **記憶面板**——聚合所有帳號、所有專案的 Claude Code memory 與第二大腦，全文搜尋、分組瀏覽；Fledge 會建議跨專案的連結，由你確認或忽略。開專案時終端機右下角浮出相關主題。對來源永遠唯讀。→ [`guides/memory-and-second-brain.md`](guides/memory-and-second-brain.md)

<p align="center">
  <img src="assets/screenshot-tasks-list.png" alt="待辦面板——專案樹、票清單、票內容三欄" width="49%">
  <img src="assets/screenshot-memory.png" alt="記憶面板——所有帳號與專案的記憶、第二大腦、跨專案連結" width="49%">
  <br><sub>左：待辦面板 · 右：記憶面板</sub>
</p>

**觀測**

- **數據面板**——從 Claude Code 與 Codex 的本機紀錄估出每日花費、模型分布、各專案用量、快取命中率，對照訂閱費看淨值。Codex 的實時額度直接向官方 API 拿。定價表可以自己更新（`admin/sync_pricing.py`）。

<p align="center">
  <img src="assets/screenshot-dashboard.png" alt="數據面板——每日花費、模型分布、各專案用量、Codex 實時額度" width="49%">
  <img src="assets/screenshot-onboarding.png" alt="引導精靈——開發環境偵測與一鍵安裝" width="49%">
  <br><sub>左：數據面板 · 右：引導精靈</sub>
</p>

**環境與搬家**

- **引導精靈**——環境偵測、一鍵安裝、帳號登入、多帳號共通設置、範本部署。沒做完的項目都能在設定頁繼續。
- **備份／還原／移機**——備份的是 **Claude 生態**（所有帳號的設定目錄、`~/.agents`），不是 Fledge 自己。不收登入憑證檔（Claude 的登入在 Keychain、本來就拿不到；daemon 金鑰明確排除），但 settings、`.claude.json`、對話歷史是**原樣複製**——你自己貼進設定或對話裡的 key 會跟著進包。帶時間戳、不自動刪。還原解到新目錄、附差異報告，不動正在用的。換新機器走精靈的「我有備份」，整個流程都走得完。

**介面**

- **中英雙語**——介面語言可切，繁體中文與英文都是完整翻譯。
- **Nightfall 深色主題**——視覺克制、以 AI 為中心。對比度全部過 WCAG AA，顏色不當唯一訊號，鍵盤可操作。
- **桌面原生、啟動快**——macOS `.app`，後端 onedir 免每次解壓；`curl` 或 `.dmg` 任選。

## 隨附的 skills 與範本

Fledge **不會自動安裝**這些東西——不碰 `~/.claude/settings.json`、不碰 `CLAUDE.md`、不碰 `~/.claude/skills/`。要不要裝、裝哪個，由使用者決定。

### skills（[`skills/`](skills/)）

| skill | 做什麼 | 沒裝會怎樣 |
|---|---|---|
| `fledge-tasks` | 讓 Claude Code 讀寫 `.fledge/tasks/`——「開一張票」「待辦有哪些」 | 面板照用，只是 AI 開不了票 |
| `resume-note` | 收工時寫 `.fledge/state.md`——「寫離場筆記」 | 面板的「下一步」欄永遠空的 |
| `handoff` | 上下文快滿、要換新對話繼續時，寫完整版離場筆記並產一段貼進新對話的指令 | 不影響 |

三支一起裝：

```bash
cp -R skills/fledge-tasks skills/resume-note skills/handoff ~/.claude/skills/
```

或各裝各的：

```bash
cp -R skills/fledge-tasks ~/.claude/skills/    # 待辦
cp -R skills/resume-note  ~/.claude/skills/    # 離場筆記
cp -R skills/handoff      ~/.claude/skills/    # 換對話交接
```

`handoff` 綁作者自己的開發流程（superpowers 的 spec → plan → 逐 task 執行），照抄不一定合用，當參考。

### 範本（引導精靈的「部署範本」，或設定頁）

| 範本 | 內容 |
|---|---|
| 專案起始骨架 | 一份通用的 `CLAUDE.md` 加 `docs/` 目錄，內容簡單，本來就是要改的 |
| 第二大腦 | 完整的研究／發想 vault：`CLAUDE.md` 行為準則、`topics/` 與 `library/` 兩區的範本、三個自動衍生的索引檔 |

**第二大腦範本帶 hooks**：它的 `.claude/settings.json` 會在那個資料夾開 Claude Code 時執行兩支 Python 腳本（`vault_dirty.py` 追蹤收尾狀態、`prompt_router.py` 在提到 library 操作時提示讀附錄）。兩支都只寫 vault 自己的 `.vault-dirty.json` 和 `/tmp` 底下的標記檔，不碰其他地方。不想要就刪掉 `.claude/` 目錄，vault 照用。

## Fledge 不會碰的東西

裝別人的工具，最怕它偷偷改了什麼。這一節把 Fledge 的邊界寫清楚：

- **不寫 Claude Code 的設定。** `~/.claude/settings.json`、`CLAUDE.md`、`skills/`——一個都不碰。skill 要自己複製。引導精靈的「共通設置」是唯一例外：它會在確認後建 symlink，而且每一步都先列出要建什麼。
- **記憶面板對來源唯讀。** Claude Code 的 memory 目錄、第二大腦的 vault，只讀不寫。唯一寫的是自己的 `~/.fledge/memory-links.json`。
- **待辦與離場筆記只寫專案的 `.fledge/`。** 不改 `.gitignore`——要不要讓 `.fledge/` 進版控，自己加一行。
- **備份不收登入憑證檔，還原永不覆蓋正在用的設定。** 排除的是 Keychain 與 daemon 金鑰那一類；設定與對話歷史原樣複製，裡面若有你貼過的 key 就會在包裡。還原解到新目錄、給差異報告，要不要動正在用的由使用者決定。
- **範本永不覆蓋。** 目的地已經有同名檔案就跳過。
- **子程序拿不到 Fledge 的 token。** sidecar 的認證 token 不會灌進 Claude Code 的環境變數。

## 運作方式

三層架構，各司其職：

| 層 | 技術 | 負責 |
|---|---|---|
| **殼** | Tauri 2.x（Rust） | `.app` 安裝、視窗、啟動／關閉後端的生命週期 |
| **後端** | Python sidecar（FastAPI ＋ ptyprocess） | 掃描專案、橋接 PTY（實際跑 Claude Code）、讀寫設定、掃記憶與用量 |
| **前端** | React ＋ TypeScript（Vite） | 側欄／分頁／各面板；xterm.js 嵌入終端機 |

資料流：**前端 ↔ 後端（HTTP / WebSocket）↔ PTY ↔ Claude Code CLI**。Rust 殼只負責把後端拉起來、收好——包含優雅關閉，不留孤兒 Claude Code 進程。完整模組地圖與影響鏈見 [`PROJECT_MAP.md`](PROJECT_MAP.md)。

## 開發

```bash
# Python sidecar 環境
cd sidecar && python3 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
pytest                       # sidecar 測試

# 前端 + Tauri（先確保 cargo 在 PATH）
. "$HOME/.cargo/env"
npm install
npm test                     # 前端單元測試（vitest）
npm run tauri dev            # 開發模式啟動 App
```

打包成 `.app`／`.dmg` 的流程見 [`scripts/`](scripts/)，CI 設定見 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

## 狀態與藍圖

**目前可用（macOS Apple Silicon，已真機驗證）：** 上面功能一覽的每一項。

**規劃中：**

- **固定簽章身分**——讓完整磁碟取用權限不會每次更新就失效。
- **Apple 簽章 ＋ notarization**——目前未簽章。
- **淺色主題**——token 層已預留，淺色的色階還沒過視覺審查。
- **數據面板的定價缺口**——長 context 分層計價、fast mode 兩倍價目前沒算進去，會低估。
- **核對備份清單**——確認 `~/.claude` 底下每一項該收的都收了。
- **in-app 安裝 skill**——設計已有，等寫入的安全機制做完。
- 其他平台（Windows／Linux）、in-app 自動更新。

**已知問題（開著的票，還沒修）：**

- 關閉 session 失敗時，介面會當作已經關掉，殘留的 Claude Code 進程從此失聯。
- 設定檔載入失敗時，歡迎頁會誤顯示「設定檔已建立」。
- 重跑引導精靈時，專案數載入失敗會顯示 0，分不出是真的沒有專案還是沒讀到。
- 「在 Finder 中顯示」這個能力的路徑範圍沒有限制，比實際需要寬。

## 授權

[MIT](LICENSE)

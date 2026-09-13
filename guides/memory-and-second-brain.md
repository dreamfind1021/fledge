# 記憶面板，與自己建一個第二大腦

[English](memory-and-second-brain.en.md) · **繁體中文**

> 這一篇講「你的第二大腦」那一層：記憶面板讀什麼、怎麼用，以及怎麼用範本起一個自己的 vault。

<img src="../assets/screenshot-memory.png" alt="記憶面板" width="820">

## 記憶面板讀什麼

兩個來源，都**唯讀**：

| 來源 | 位置 | Fledge 怎麼認 |
|---|---|---|
| Claude Code 自己的記憶 | 每個帳號的 `<設定目錄>/projects/<專案編碼>/memory/*.md` | 掃所有帳號、所有專案；用 frontmatter 的 `type` 分類（`user`／`feedback`／`project`／`reference`） |
| 第二大腦（KMS） | 設定頁指定的 `kms_root` 底下的 `topics/` 與 `library/` | 只認這兩個資料夾底下的 `.md`；`_` 開頭、`.` 開頭、`CLAUDE.md` 一律跳過 |

兩邊都只需要「markdown ＋ frontmatter」。parser 極簡：第一段 `---` 之間當 YAML-lite，讀 `type`、`tags`、`summary`；壞檔跳過不報錯。

Fledge 自己唯一寫的檔案是 `~/.fledge/memory-links.json`——確認過的建議、忽略掉的建議，全在這一個檔。

## 面板怎麼用

- **搜尋**：全文，記憶體內，沒有 RAG。
- **篩選**：來源（Claude memory／KMS）、類型（`user`／`feedback`／`project`／`reference`／`library`／`topics`）。
- **分組**：按帳號、專案、主題。
- **連結**：選一個專案，在右邊看它相關的主題。
- **建議**：Fledge 用字串比對——vault 主題的資料夾名或 `tags` 包含某個專案名——就提議建連結。按 ✓ 才算數，按 ✕ 的不再出現。目前面板只有「確認建議」這一種建連結的方式；手動指定「A 跟 B 有關」的 API 後端有，介面還沒接。
- **浮現**：在終端機開某個專案時，右下角浮出跟它相關的主題。沒有相關的就不出現（不是空框）。

## 為什麼這樣設計

- **不做 RAG。** 這套設計面對的語料是一百多個 markdown 檔、零點幾 MB，而且都是策展過的——全文搜尋一下就翻完了。為這個規模架向量資料庫，是在解一個不存在的問題。哪天檔案爆量再說。
- **不重做 per-project 記憶。** Claude Code 自己的 memory 已經做得不錯，而且是它自己寫的、自動累積的。Fledge 只補它做不到的：看全貌、跨專案。
- **不注入 session。** 面板是給人看的。要讓 AI 開專案時也拿到相關主題，牽涉往 context 塞東西，得單獨設計。藍圖上有。
- **唯讀。** Claude 自動寫 memory、人手寫 vault、Fledge 再寫進去——三方寫同一批檔案一定出事。所以 Fledge 只寫自己那一個 json。

## 自己建一個第二大腦

### 從範本開始

引導精靈的「部署範本」選「第二大腦」，指定一個資料夾。或者之後從設定頁的「開發環境」區做。範本永不覆蓋已存在的檔案。

部署完把那個資料夾設成 `kms_root`（設定頁 › 記憶），並且把它加進工作根目錄——它本身就是一個專案，要在裡面開 session。

### 目錄結構

```
<vault>/
├── CLAUDE.md              ← 行為準則：研究／創意兩種模式、收尾規則、檔案更新時機
├── .claude/               ← hooks 與附錄（見下）
├── _INDEX.md              ← 主題清單【自動衍生，勿手改】
├── _CONNECTIONS.md        ← 跨主題連結總覽【自動衍生】
├── _TAGS.md               ← tag 索引【自動衍生】
├── topics/                ← 思考脈絡：一個主題一個資料夾
│   └── <主題>/
│       ├── CONTEXT.md     ← 走到哪（頂部 frontmatter 是索引的真相源）
│       ├── INSIGHTS.md    ← 提煉過的精華，不是對話紀錄
│       ├── spec.md        ← 進到設計階段才建
│       └── sessions/      ← 每次對話一張卡片：摘要、發現、岔路、連結、下次
└── library/               ← 知識綜合：外部來源、逐主張引用
    └── <主題>/
        ├── sources/       ← 證據層，不可變
        ├── overview.md    ← 帶引用的綜合頁
        └── queries.md     ← 問答回填
```

三個 `_` 開頭的索引檔是**衍生產物**：真相源住在各主題 `CONTEXT.md` 的 frontmatter（`tags`、`summary`）和內文的 `[[wikilink]]` 裡，索引由 AI 在每次 session 結束前重建。改的永遠是主題檔，不是索引。

### 兩個慣例，讓 Fledge 認得出關聯

1. **資料夾名用 slug**，例如 `meeting-agent-asr-tuning`。
2. **frontmatter 的 `tags` 對齊專案名**，例如 `tags: [Meeting-Agent, ASR]`。

Fledge 的自動建議就是拿專案名去比對這兩樣。這不是為 Fledge 特別做的——為了 Obsidian 導覽本來就會這樣寫，Fledge 只是把已經在資料裡的關聯讀出來。

### hooks

範本的 `.claude/settings.json` 掛了四個 hook，在 vault 資料夾開 Claude Code 時執行：

| 時機 | 做什麼 |
|---|---|
| `SessionStart` | 把 `_INDEX.md` 注入對話，提醒 AI 照上下文恢復規則開始；報告上次沒收尾的項目 |
| `UserPromptSubmit` | 提到 library 操作（餵來源、lint…）時，提示 AI 先讀附錄 |
| `PostToolUse` | AI 改了主題檔就標記「待收尾」（要建卡片、要重建索引） |
| `Stop` | 有未收尾的項目就擋下來提醒；提醒兩次後放行，留給下次 |

兩支腳本（`vault_dirty.py`、`prompt_router.py`）只寫 vault 自己的 `.vault-dirty.json` 和 `/tmp` 底下的標記檔。不想要 hook，刪掉 `.claude/` 目錄即可，vault 的其他部分照用。

### 實際怎麼用

在 Fledge 側欄點 vault 這個專案，開 session。第一句話直接講想研究或想發想的事——`CLAUDE.md` 會讓 AI 判斷是研究模式（查資料、要來源、找矛盾）還是創意模式（發散、不急著收斂），自動建主題資料夾，收工前寫 session 卡片、更新 `CONTEXT.md`、重建索引。

下次回來，`SessionStart` hook 會把主題清單餵給 AI，它會說「上次討論到 X，建議從 Y 繼續」。

這就是描述中的「長期記憶」：它不在 Fledge 裡，在 vault 裡；Fledge 做的是讓人在別的專案工作時也看得到它。

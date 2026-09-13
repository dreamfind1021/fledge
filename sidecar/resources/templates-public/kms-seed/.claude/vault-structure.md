# vault-structure — 檔案結構與各檔職責（按需查閱附錄）

> 由 CLAUDE.md「附錄索引」指向。要查 vault 檔案結構／各檔職責時載入。

## 檔案結構

```
<your-vault>/                         ← vault root（部署時即此資料夾名）
├── CLAUDE.md                        ← 常駐行為準則（精簡核心＋附錄索引）
├── .claude/                         ← hook 與按需附錄
│   ├── settings.json                ← hook 配置（PostToolUse／Stop／SessionStart）
│   ├── vault_dirty.py               ← 型2 收尾 dirty-state 管理（SSoT）
│   ├── vault-structure.md           ← 本檔（檔案結構／各檔職責）
│   └── library-workflow.md          ← library 知識綜合細則
├── .vault-dirty.json                ← 【runtime，gitignored】型2 dirty 狀態
├── _INDEX.md                        ← 兩區主題清單【衍生，勿手改】
├── _CONNECTIONS.md                  ← 跨主題／跨區連結總覽【衍生，勿手改】
├── _TAGS.md                         ← tag 索引（跨兩區共用）【衍生，勿手改】
├── _LINT.md                         ← Lint 報告【on-demand 產生；衍生、勿手改】
├── topics/                          ← 一階：思考／發想（authoring 不變）
│   └── [topic-name]/
│       ├── CONTEXT.md               ← 主題脈絡（頂部含 YAML frontmatter）
│       ├── INSIGHTS.md              ← 累積的重要發現
│       ├── spec.md                  ← 設計規格（有設計/實作工作時才建立）
│       └── sessions/
│           ├── 2026-04-25-01.md     ← session 卡片（流水號）
│           └── 2026-04-25-02.md     ← 同天第二個 session
└── library/                         ← 二階：知識綜合（Ingest/Query/Lint）
    ├── concepts/                    ← 全域概念頁（跨多 subject 晉升才建，lazy）
    │   └── X.md
    └── [subject]/
        ├── CONTEXT.md               ← 領域狀態（zone: library）
        ├── sources/                 ← 證據層（不可變）
        │   ├── _manifest.md         ← 【衍生】各 source frontmatter 聚合
        │   └── <source-id>.md       ← 原檔/快照 + 抽取文字 + frontmatter
        ├── overview.md              ← 領域帶引用綜合（主綜合頁）
        ├── concepts/                ← subject 內概念頁（首次晉升才建，lazy）
        ├── source-notes/            ← 單一來源 1:1 整理頁（選配）
        └── queries.md               ← Q&A 回填紀錄（複利）
```

## 各檔案說明

- **`_INDEX.md`**【衍生，勿手改】：**兩區**主題清單（分 `## topics / ## library` 段落）。由兩區各 `CONTEXT.md` frontmatter 衍生
- **`_CONNECTIONS.md`**【衍生，勿手改】：**跨兩區**連結總覽。由 topics `CONTEXT.md` 內文 + library（`CONTEXT.md`/overview/concepts/source-notes/queries）inline `[[]]` 衍生
- **`_TAGS.md`**【衍生，勿手改】：tag → 主題索引（**跨兩區共用**）。由兩區 `CONTEXT.md` frontmatter 的 `tags` 聚合
- **`_LINT.md`**【衍生，勿手改】：Lint 稽核報告（on-demand 觸發、整份覆寫；分級 + type + confidence）
- **`CONTEXT.md`**：該主題「現在走到哪裡」。**頂部 YAML frontmatter** 是 `_INDEX`/`_TAGS` 的真相源；內文記核心問題、已確立方向、岔路，並在「## 連結」段用 inline `[[topic]]` 標跨主題連結
- **`INSIGHTS.md`**：從對話中提煉的重要發現、好想法、反直覺的觀點——這是跨 session 累積的精華
- **`spec.md`**：設計規格文件，有明確設計/實作工作時才建立。**路徑固定在主題資料夾內**（`topics/[topic-name]/spec.md`），不要存到其他位置（如 `docs/`）
- **session 卡片**：每次對話的快照，讓下次能快速恢復脈絡
- **`.claude/vault_dirty.py` 與 `.vault-dirty.json`**：型2 收尾的 hook 機制與 runtime 狀態（見 CLAUDE.md「附錄索引」的型2 說明）

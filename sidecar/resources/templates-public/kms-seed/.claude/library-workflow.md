# library-workflow — 知識綜合工作流（按需附錄）

> 由 CLAUDE.md「附錄索引」指向；做 library 操作（Ingest／Query／Lint／餵來源）時載入。
> **Zone placement（該放哪區）的判斷留在常駐 CLAUDE.md**；本檔是「進了 library 之後怎麼做」。本檔**自含**（Lint 清單已內嵌、不外引），可隨公版部署到新 vault。

> library 是「二階知識綜合」區——吃外部來源、做帶引用整合，輸出可驗證的知識節點。與 topics 不同，它的內容以外部資料為主，須逐主張引用。

## 真相源三層模型

| 層 | 內容 | 性質 |
|---|---|---|
| **證據層** | `sources/`（原始資料 + 抽取文字 + 每檔 frontmatter） | **不可變**，不覆寫；更新 = 新版本（新 source-id 或 `-v2` 後綴） |
| **綜合層** | `overview.md` / `concepts/` / `source-notes/` / `queries.md` | **人/Claude 維護的詮釋**，可演化，**非**衍生；須帶引用 |
| **索引層** | `_INDEX` / `_CONNECTIONS` / `_TAGS` / `sources/_manifest.md` / `_LINT.md` | **純衍生**，自動重建，勿手改 |

## library CONTEXT.md frontmatter

```yaml
---
zone: library          # 固定填 library；topics 預設 zone: topic，可不填
status: active
created: YYYY-MM-DD
mode: 研究
tags: []
summary: 一行簡述
---
```

不放 `sources` 計數（衍生值，由衍生 pass 算）。

## source-id 與來源儲存

- 每個 source 一個**全域唯一的 slug 型 `source-id`**（如 `deloitte-media-2026`），跨 subject 不衝突。
- 每個 source 檔頂部 frontmatter：

  ```yaml
  ---
  source-id: deloitte-media-2026
  title: Deloitte 媒體訂閱報告 2026
  type: paper            # paper | web | own | data
  date: 2026-03-01       # 來源自身日期
  ingested: 2026-05-27   # 餵入日
  status: integrated     # raw | extracted | integrated | deferred | ignored
  origin: <url 或路徑>
  ---
  ```

- per-type 儲存：論文/PDF → 原檔 + 抽取文字；網頁 → 快照 `.md` + 原 URL + 抓取日；自有素材 → 原樣；CSV → 檔案 + 資料註記。
- `deferred`/`ignored` 狀態的 source，Lint 不報「未引用」。
- source-id 全域唯一檢查（應無輸出）：
  ```bash
  find library -type f -path '*/sources/*.md' ! -name '_manifest.md' ! -name '_SOURCE-TEMPLATE.md' -print0 \
    | xargs -0 grep -h '^source-id:' 2>/dev/null | sed 's/source-id: *//' | sort | uniq -d
  ```

## 引用紀律

- 用**標準 Markdown footnote**：可驗證主張行內標 `[^source-id]`，頁底「來源」區定義 `[^source-id]: 標題 — 連結`。
- **粒度 = 逐主張**（事實/數據/有爭議論點必標；純過渡句不強求）。引用掛在**該主張所在句**，避免整段多主張只掛段末一個。
- **無引用的綜合不算數**。

## Ingest（餵新來源）五步

1. source 落 `sources/` + 配全域 source-id + 抽取文字 + 寫 frontmatter（`status: raw → extracted`）。
2. 整合進 `overview.md`（**更新**既有段落，非只 append），可驗證主張標引用；整合完將 source 的 `status` 改為 `integrated`。
3. 與既有綜合比對 → **標記矛盾**（flag，不靜默改）。
4. 偵測跨來源反覆概念 → **提議**抽 concept 頁（人裁決，自動偵測＋提議、人工裁決為原則）。
5. 觸發衍生 pass 更新索引。

## Query（問 library）

1. 搜相關綜合頁（overview/concepts/source-notes）。
2. 綜合出**帶引用**答案。
3. **回填判準**：答案包含既有頁沒有的新連結/結論時，append 到 `queries.md`（保留原問答 + 引用）；當同類問答反覆出現或結論穩定，提議併入 `overview.md`/`concepts/X.md`（人裁決）；併入後 `queries.md` 留指標連結、不重複正文。

## Lint（on-demand 稽核）

觸發：使用者說「跑 lint」。輸出整份覆寫 `_LINT.md`，**嚴格 flag-only**（一律只標不改，所有修正都走「建議 → 你確認」）。分級 🔴 必修 / 🟡 建議 / 🔵 提示，每條標 type（deterministic/semantic/workflow）與 confidence。

檢查清單（三類，每條標 type＋confidence；`_LINT.md` 整份覆寫、勿手改、不進衍生 pass）：

**deterministic（可確定，高 confidence）**
1. 斷鏈：`[[X]]` 指向不存在的目標
2. 缺／格式錯 frontmatter
3. 引用懸空：`[^id]` 無對應 source（manifest 查無）
4. source `status: integrated` 卻從未被任何綜合頁引用（`deferred/ignored/raw` 不報）
5. 衍生過期：重跑衍生 pass 做 dry-run diff，與現存索引不一致則報（不用 mtime）

**semantic（需 LLM 判斷，標 confidence、預設只建議）**
6. 跨來源／跨頁矛盾（標兩處＋source-id）
7. 過時主張（來源出新版、綜合沒跟上）
8. 可驗證主張缺引用（heuristic，灰區不算硬錯）
9. 引用覆蓋不清：一段多獨立主張只掛單一引用（選配）
10. tag 疑似同義／拼寫變體（**不是**「不在 `_TAGS.md` 就錯」——`_TAGS` 是衍生索引非白名單；新概念 tag 允許，只揪疑似重複請使用者裁決）
11. 概念頁重複該合併
12. 幻覺／過度延伸：綜合主張在其引用來源找不到依據（選配，成本高）

**workflow（提醒，低 confidence）**
13. active 但逾月未動 → 建議轉 dormant
14. INSIGHTS 互斥
15. 該連未連（語意相關卻無 `[[]]`）
16. 岔路堆積

## wikilink 文法與消歧

- `[[slug]]`：slug **全域唯一**（topic、subject、concept 同一命名空間）時直接用。
- 不唯一時用**最短可消歧路徑**：`[[subject/concept]]`、`[[library/subject]]`。
- Lint 抓**重複 slug**，提示改名或加路徑（flag-only，不自動改）。手動檢查（應無輸出）：
  ```bash
  { find topics library -mindepth 1 -maxdepth 1 -type d | xargs -n1 basename;
    find library -type f -path '*/concepts/*.md' | xargs -n1 basename | sed 's/\.md$//'; } \
    | grep -vE '^_TEMPLATE$|^concepts$' | sort | uniq -d
  ```

## 晉升觸發

- **subject 內概念頁**：偵測某概念跨多來源/內容變大 → 提議抽 `[subject]/concepts/X.md`（人裁決）。
- **全域概念頁**：概念跨多個 subject → 提議晉升到 `library/concepts/X.md`。
- **research topic → library subject**：topics 某主題累積夠多外部來源/穩定知識時，提議抽出對應 `library/[subject]/`；原 topic 保留決策脈絡，用 `[[]]` 連到新 subject。
- **人為指令最優先**：使用者說「給它一頁」立即抽。

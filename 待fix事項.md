# 待 fix 事項

> 本檔只放**待處理**事項，完成即移除。**人工編寫**是原始需求清單；**AI 補記**是 Claude Code
> 從實作過程整理的待辦，每條都標了來源票號或 commit，方便回查。兩區請勿混寫。

---

## 人工編寫

> 編號沿用原始清單，跳號代表該項已完成並移除。

**執行順序：B → A → C（已定案）** — 這三項在規劃時編為 A／B／C，與下方編號的對應是
**A＝一（啟動畫面）、B＝二（首次引導精靈，已完成移除）、C＝三（備份還原）**。
B 排最前是因為它的 `common_config.py` 定了 `build_account_graph／plan／apply／repair` 這組
B 與 C 共用的 contract，而 C 的還原要靠 `repair()`；A 不依賴另外兩項，故排中間。
**B 已完成（票 01–31 全結），所以下一個是「一、啟動畫面」，C 剩下的部分排最後。**

一、設計啟動畫面，用來避免使用者有等待感 ← **下一個**

三、設計系統備份檔功能，目標是要移機時，可以直接載入備份檔就能夠還原目前完整狀態。

**未完成的部分**（AI 補記）：腳本層已交付（`scripts/backup-claude.sh`／`restore-claude.sh`，
commit `238e1ab`，決策見 `docs/adr/0004-backup-scope-by-regenerability.md`），標的是 Claude
生態（所有帳號的 `config_dir` ＋ `~/.agents`）而非 Fledge 自身。**還缺 GUI 介面、還原精靈、
以及 `common_config.repair()`**（B spec §6.5 只有文字 contract，沒有實作）。目前的還原只解到
新目錄並產出差異報告、不寫現役目錄，與「載入備份檔直接還原完整狀態」還有距離。

---

## AI 補記（Claude Code，2026-07-28）

- **PTY session 的 orphan reaper**（票 30 Codex R1 High-2，覆核後記為已知限制）：
  `closeSession` 對 DELETE 失敗只 log 不 throw，前端隨即丟棄 session id。實務上可達路徑很窄
  （端點對未知 id 也回 200，非 2xx 幾乎只在 sidecar 不通時發生，而那時 PTY 也活不了），且
  `closeTab` 走同一條路、非引導精靈引入。完整的重試佇列與 sidecar 端 orphan reconciliation
  留在 Plan 04。另有一條更精確的殘留路徑值得一併處理：`PtyBridge.close_session` 在 `close()`
  失敗但進程仍活著時會把 handle 放回 registry，此時 route 仍回 200、前端照樣丟棄 session id。

- **sidecar 錯誤合約改造**（`docs/planning/i18n-design.md` 範圍）：onboarding namespace 的七條
  `{{reason}}` 已在票 30 拔掉，但這是**逐個 namespace 修**的做法。Codex 建議補一條「掃原始碼
  確認所有靜態引用的 `errors.*` key 都存在」的檢查（防兩語同時刪 key 後 react-i18next 直接
  顯示 key 原文），那是全 namespace 的基建，當時判定超出收尾票範圍未做。

- **票 29 Codex R4 的兩項 Low**（票 30 經裁示只修第三項的測試斷言，這兩項未修）：
  ① `config === null` 時 `Onboarding` 的 `configCreated` 初值會判成「已落檔」，於是根目錄頁
  顯示「設定檔已建立」配一張空清單；正常流程都先 `loadConfig` 過，只有 startup 載入失敗才
  露出。要修得加 loading 態，或在 `config == null` 時停用歡迎頁 CTA。
  ② 重跑引導時根目錄每列的專案數取自 store 的 `projects`，`loadProjects` 失敗會顯示 `0`，
  無法與「真的沒有專案」區分。要分辨需要 store 有「載入過沒有」的旗標。

- **未處理的定價維度**（`feat/pricing-sync` 分支，決策見 `docs/adr/0005-build-time-pricing-vendoring.md`）：
  現行計價只有單一價位，以下三層都會造成**靜默低估**（不進「尚未收錄定價」警示）。
  ① **OpenAI 272K 以上長 context 分層**：`gpt-5.6-sol` 超過 272K 後 input 由 $5 變 $10、
  output 由 $30 變 $45。實測本機 codex 單次請求 input 最大 229,256 tokens、0 筆越線，
  故目前是理論性的（已到門檻的 84%）。上游 JSON 有 `*_above_272k_tokens` 欄位可直接取。
  ② **Anthropic fast mode**：Opus 5／4.8 開 `/fast` 是 $10/$50，2 倍基價。尚未查證 jsonl
  是否記得下 speed 欄位——若沒記，這層永遠無法從本機資料還原。
  ③ **batch／flex／priority 折扣**：上游有欄位，Fledge 一律當標準價。Claude Code／Codex CLI
  走的是互動式，實際上碰不到，優先度最低。

- **上游 cache 價的合理性閘值是啟發式**（同上分支）：偏離標準倍率超過 2 倍即視同上游沒給、
  改用推導值並報告（擋掉了 `claude-3-haiku` 的 24× 與 `claude-3-opus` 的 0.4×）。容忍範圍是
  拍板的，不是推導出來的：真有一天官方把某層倍率調動超過 2 倍，會被誤判成損壞而改用舊倍率。
  屆時報告會出聲，但需要人工判斷並改 `_CACHE_RATIO_TOLERANCE` 或走 `PINNED`。

- **repo 尚未 push**：main 目前 268 個 commit 只在本機，沒有 remote。完整開發史留在
  `backup/full-history-pre-public` 分支（208 個 main 沒有的 commit），依既有決策 push 只能
  push main。

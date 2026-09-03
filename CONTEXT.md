# Fledge

Claude Code 多帳號桌面工作台（Tauri + React 前端、FastAPI sidecar 後端）：管理一或多個 Claude 帳號的終端機 session、用量觀測、記憶層與開發環境引導。**預設是單一帳號**（`~/.claude`）；多帳號是使用者自己在設定頁加出來的進階用法。

## Accessibility scope

**寫在這裡是給審查者看的**：以下不是疏漏，是記錄在案的產品決定。往後審查請不要重複提。

**不在規劃對象內**（因此不是驗收條件）：

- **螢幕報讀軟體的使用者**。報讀專用的 `aria-expanded` / `aria-pressed` / `aria-selected` / `aria-current` / `aria-label`、以及 heading 與 grouping 語意，一律不要求（2026-09-02 決定）。
- **色覺障礙**。顏色可以是唯一的狀態訊號。待辦總覽的刻度就是這樣做的——「進行中」只用橘色與其餘刻度區分，兩者對比 2.68、低於 WCAG 1.4.11 的 3:1，是看過灰階模擬後的知情選擇（2026-09-03 決定）。

**仍然是驗收條件**（受益者包含使用者本人，與上面兩項性質不同）：

- **對比度**。文字 4.5:1、非文字 3:1。防線是 `src/index.contrast.test.ts`（token 本身）與 `src/components/Tasks.contrast.test.ts`（個別規則用的 token）。**淡化不得用 `opacity`**——它把顏色往底色拉，從 token 值算不出來，白名單機制見前者。
- **鍵盤操作**。`<button>` 而非可點擊 `div`、Enter/Space、Tab 可達、焦點不被收合吞掉。
- **`--focus` ring 可見性**、**重要狀態文字化**。

**已經寫進程式的不必拆。** 例如 `TasksList.tsx` 的三態記號（空心方／實心方／打勾）當初是照「顏色不得為唯一訊號」做的，留著沒有壞處；改的是「往後還要不要照這條驗收」，不是「把做好的拆掉」。

## Language

### 帳號與共通設置

**Account（帳號）**:
Fledge 登記的一個 Claude 帳號身分，由 key、config_dir（該帳號的 Claude 設定目錄）與顯示 label 組成。
_Avoid_: user、profile

**Source account（主帳號）**:
共通設置中實體檔案的持有者；其他帳號的共通項以 symlink 指向它。由呼叫端顯式指定，非持久狀態。
_Avoid_: canonical account、primary account、主帳戶

**Target account**:
共通設置中在自己 config_dir 內建 symlink 指向 source account 的帳號。
_Avoid_: secondary account、次帳號

**Common config entry（共通設置項）**:
帳號間共用的單一設定項（如 commands、plugins、skills、settings.json、CLAUDE.md），各有共享方式（symlink 或 copy）。
_Avoid_: shared file、sync item

**Canonical（路徑語意）**:
僅指路徑正規化（expand→absolute→resolve symlink）。不用於描述帳號角色——帳號角色用 source/target。

### 啟動

**Splash（啟動畫面）**:
每次啟動時蓋在主視窗內的品牌畫面（webview 內 overlay，非獨立視窗）。蓋住整段啟動序列，到「序列跑完且滿足最短顯示時間」才淡出——淡出瞬間底下已是可用的 UI。**只在 app 啟動出現一次**：淡出後即使後端斷線重啟也不再現（那走頂部 banner）。啟動失敗時就地轉為錯誤態並提供重試，不交還給底下的空殼 UI。
_Avoid_: loading 畫面（它是品牌展示，不只是等待指示）、開機畫面

**Startup sequence（啟動序列）**:
從取得 sidecar port 到 app 可用的整串步驟（port → token → health → 設定 → 專案清單／首次引導）。是**可重跑的單一單元**，不是散在元件生命週期裡的一次性副作用——重試就是重跑它。
_Avoid_: 初始化、boot（後者在本專案指 Tauri 進程啟動）

### 引導與設置

**First run（首次啟動）**:
Fledge 尚未落地任何使用者設定的狀態。**第一次寫入設定即永久離開此狀態**，即使引導尚未走完——引導的完成度不屬於這個狀態。
_Avoid_: 未初始化、首次安裝（後者指的是應用程式本身）

**Onboarding wizard（引導精靈）**:
首次啟動時的線性容器，只負責把使用者帶到「最低可用」。不持久化「走到第幾步」；離開後由設定頁接手。
_Avoid_: setup wizard（與設定頁混淆）

**Setup card（設置卡）**:
引導精靈與設定頁共用的自包含設置單元（環境偵測、登入、共通設置、範本部署…）。現況一律**即時偵測**、不落存；「使用者主動略過」只存在於當次畫面。
_Avoid_: step（步是精靈的分頁，卡是內容單元）、區塊

### 備份與還原

**Claude ecosystem（Claude 生態）**:
所有登記帳號的 `config_dir` 內容總和——使用者真正的資產所在。與 Fledge 自身相對：Fledge 重裝後導入設定檔即可復原，生態一旦丟失無法再生。
_Avoid_: Claude 設定（低估了它的份量）、使用者資料（範圍過寬）

**Asset（資產）**:
隨使用累積、丟了就再也回不來的東西：使用者寫的 skill 與腳本、指令歷史、session 歷史、對話中貼入的圖片。備份的唯一目標。
_Avoid_: 重要檔案（沒有判準）、設定（只涵蓋其中一小部分）

**Runtime state（執行期狀態）**:
只在程序執行期間有意義的東西：鎖、pid 註冊、session 環境變數腳本、shell 快照。重啟即重生，備份它反而會在還原時製造衝突。
_Avoid_: 暫存檔（與 cache 混淆）

**Cache（快取）**:
可從上游重新取得或重新計算的副本：變更日誌、遙測佇列、統計快取。與 runtime state 的差別在於「重生的來源在外部」。
_Avoid_: 暫存檔

**Backup bundle（備份包）**:
一次備份的產物，涵蓋當下所有帳號的資產，帶時間戳。**永不含憑證**——憑證要嘛在 Keychain（拿不到），要嘛是明確排除的檔案。備份包因此可以自由存放，但仍含使用者識別資訊，不可公開。
_Avoid_: 快照（snapshot 在本專案指 UI 的偵測結果，見共通設置卡）、封存

**Restore（還原）**:
把備份包展開成可檢視的形式，**不寫現役目錄**——展開到獨立位置並產出差異報告，由使用者決定搬什麼回去。
_Avoid_: 匯入、覆蓋（後者正是本專案刻意不做的事）

**Migration（移機）**:
把備份包的資產實際寫進**新機器的現役目錄**，是 restore 的下一步而非同義詞。與 restore 的分界很硬：
restore 沒有寫入現役目錄的能力（`backup/restore.py` 檔頭的不變式），migration 有，且只有它有。
_Avoid_: 還原（會混淆「展開來看」與「裝回去」這兩件性質完全不同的事）

**Staging（展開目錄）**:
備份包解開後的獨立位置（`~/.claude-restore-<時間戳>`）。**全程唯讀**——migration 從這裡讀、往現役
目錄寫，不回頭改它。備份包本身因此永遠是原狀退路。
_Avoid_: 暫存目錄（與 runtime state 混淆）、解壓目錄

**Landing spot（授權落點）**:
使用者**逐項確認過**的寫入目標：每個帳號的 `config_dir`、每個帳號外資產的落點。備份包的 manifest
只能產生建議值，**不能授權目的地**——確認過的才算數。
_Avoid_: 目標路徑（沒表達出「經過授權」這層）

**Node（節點）**:
staging 內的一個待安裝物件——目錄、一般檔或 symlink。`install` 的結果、symlink 的依賴判定、
provenance journal 的記錄單位都是 node。
_Avoid_: 檔案（漏掉目錄與 symlink）、項目

**Provenance journal（發布簿記）**:
記錄「哪些 node 確實由本次 migration 發布」的檔案，放 `~/.fledge/`（不放 staging，那是唯讀；也不放
現役目錄，那是使用者的）。兩個用途：symlink 依賴判定（只認自己裝過的目標），以及「這次移機還沒
收尾」的訊號。**install 完整成功後才刪除。**
_Avoid_: log（它是判定依據不是紀錄）、manifest（那是備份包裡的東西）

**四個 outcome**:
`installed`＝本次確實寫進去了；`skipped`＝現役已有同名物件，**我們沒動它**（好事，不需要行動）；
`excluded`＝我們刻意不處理或判定不安全（`.claude.json`、指向未授權目標的 symlink、未對應的專案）；
`failed`＝該裝但沒裝成（可重跑）。**只有 `excluded` 與 `failed` 需要使用者行動**，報告的分層依此而定。
_Avoid_: 把 `skipped` 與 `excluded` 混用（前者是「你的東西受保護」，後者是「有東西沒帶過來」）

### 用量與計價

**等價 API 價值（equivalent API value）**:
把用量按第一方 API 定價換算出的金額。使用者跑的是訂閱制、不實際付這筆錢——它衡量的是「這些用量若走 API 要值多少」，也是 Net ROI 的分子（等價 API 價值 − 訂閱月費）。因此價基取**標準價**而非限時促銷價：跨月可比比貼近當下帳單重要。
_Avoid_: 成本、花費（兩者都暗示真的付了錢）

**價格帶（price band）**:
一組共用同一份定價的模型。同系列的不同尺寸／tier 是**各自獨立的價格帶**，不是彼此的近似值——`gpt-5.4-pro` 與 `gpt-5.4` 差 12 倍、`-nano` 與全尺寸差 25 倍。因此模型名查不到定價時不得往同系列靠，寧可標示為未收錄。
_Avoid_: 模型等級、系列（後者指命名家族，與定價無關）

**釘住價（pinned price）**:
刻意不跟隨上游、由我們自行決定的定價項，附理由記在 `pricing.py` 的 `PINNED`。與「上游還沒收錄」不同：釘住是主動選擇，不是落後。
_Avoid_: 覆寫、硬編碼（後者暗示沒有理由）

**未收錄定價（missing pricing）**:
模型名不在定價表內的狀態，該筆用量計 0 並在面板標示。這是刻意的：寧可標示不完整，也不用近似價默默算錯。
_Avoid_: 查無定價（讀起來像故障）、低估（那些 token 是算 0，不是算少）

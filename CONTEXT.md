# Fledge

Claude Code 多帳號桌面工作台（Tauri + React 前端、FastAPI sidecar 後端）：管理雙 Claude 帳號的終端機 session、用量觀測、記憶層與開發環境引導。

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

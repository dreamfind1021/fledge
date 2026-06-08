# PROJECT_MAP.md — 專案模組地圖

> Claude Code 每次任務開始前必須讀取本文件，了解專案全貌與模組關係。
> 結構變更時必須同步更新本文件。

---

## 專案資訊

- **專案名稱：** Fledge — AI Workflow Studio（短名 `fledge`）
- **技術棧：** Tauri 2.x（Rust 殼）+ Python sidecar（FastAPI）+ React + TypeScript（Vite）
- **最後更新：** 2026-06-08

> 一句話定位：給 Claude Code 套圖形化 OS 殼，底層跑真實 `claude` CLI（繼承所有 skills/CLAUDE.md/MCP/帳號），上層 GUI 管理專案選擇、帳號分隔、多 sessions。

---

## 三層架構

```
Layer 1 · Tauri 殼（Rust）        → src-tauri/   啟動並管理 Python sidecar、IPC
Layer 2 · Python sidecar（FastAPI）→ sidecar/     專案掃描、PTY 橋接、設定讀寫
Layer 3 · Claude Code CLI          → 外部 subprocess（不修改，繼承一切）
React UI                           → src/         Zustand store + Sidebar/TabBar/多 Terminal 渲染
```

## 模組清單

### src-tauri/ — Tauri 殼（Rust）
| 檔案 | 職責 | 匯出 |
|------|------|------|
| `src/lib.rs` | entry：註冊 plugin、manage state、setup（先 orphan reap、生 per-launch token 存 state、再啟 sidecar）、註冊 command（sidecar_port/restart_sidecar/sidecar_token）、exit 收 sidecar | `run()` |
| `src/sidecar.rs` | sidecar 生命週期：spawn（dev/prod 統一 `std::process::Command`，dev=venv python、prod=`bundle.resources`/`resource_dir` 的 onedir exe，`.env(FLEDGE_TOKEN)`）、抓 `FLEDGE_PORT`、**統一持有當前 `std::process::Child`**、per-launch token（uuid v4、跨 restart 不變）、原子 pidfile、startup orphan reaper（pid-only 先禮後兵 `terminate_pid_gracefully`）、restart command（RestartGuard 互斥、kill 用 `try_wait` 收 zombie）、`sidecar_token` 查詢 | `SidecarState`, `generate_token()`, `spawn_sidecar()`, `sidecar_port()`, `sidecar_token()`, `restart_sidecar()`, `reap_orphan_sidecar()`, `kill_sidecar()` |
| `tauri.conf.json` | Tauri 設定，`bundle.resources` map 打包 onedir sidecar 資料夾（prod 走 `std::process::Command` + `resource_dir`） | — |
| `capabilities/default.json` | 權限：執行 sidecar、opener reveal、dialog open（directory picker） | — |

### sidecar/fledge_sidecar/ — Python sidecar
| 檔案 | 職責 | 匯出 |
|------|------|------|
| `__main__.py` | entry：拿空 port、啟 uvicorn、印 `FLEDGE_PORT=` | `main()` |
| `app.py` | FastAPI app 組裝、掛路由 + `TokenAuthMiddleware`（驗 `X-Fledge-Token`、真 preflight 放行）+ CORS 收緊到 Tauri origin + 啟動認證狀態 log | `create_app()` |
| `auth.py` | sidecar 認證純函式（fail-closed 預設 + `FLEDGE_TEST_UNAUTH=1` opt-out；call-time 讀 env）：`token_ok`（constant-time）、`require_ws_token`（WS 共用） | `auth_disabled()`, `configured_token()`, `token_ok()`, `require_ws_token()` |
| `paths.py` | 路徑正規化純函式：`expand_and_validate`（拒空/相對）、`probe_dir`（os.stat 四態 dir/missing/not_dir/denied，不用 is_dir 以分 missing/denied）、`resolve_best_effort`（跟隨 symlink、永不 raise）、`canonicalize` | `expand_and_validate()`, `probe_dir()`, `resolve_best_effort()`, `canonicalize()`, `DirStatus` |
| `app_config.py` | `~/.fledge/config.json` 讀寫（原子寫）+ root/manual/override/account 寫入 helpers（含 account_references + remove_account 級聯 reassign）；load 時自我遷移既有路徑成 canonical（resolve）+ 依 canonical 去重 | `AppConfig`, `default_config_path()` |
| `project_scanner.py` | 根目錄 depth=1 掃描（標所屬 root、套 project_overrides）+ CC 用過記錄合併；逐 root best-effort 容權限（`scan_all` 回 `(projects, permission_error)`） | `scan_all()`, `scan_root()`, `encode_cc_project_dir()` |
| `pty_bridge.py` | PTY 橋接、Session 管理（threading.Lock）、env 切帳號、resize；child env 剔除 `FLEDGE_TOKEN`/`FLEDGE_TEST_UNAUTH`（不灌 secret 進 claude） | `PtyBridge`, `Session` |
| `routes/health.py` | `GET /api/health`（附 `claude_found`：shutil.which 判 claude 是否安裝） | `router` |
| `routes/projects.py` | `GET /api/projects`（回 `permission_error`）+ `POST .../scan-preview`（onboarding 試掃計數、不落檔；回 `status` 判別碼 ok/denied/missing/not_dir/invalid，讓 wizard 預先擋無效 draft） | `router` |
| `routes/sessions.py` | `POST/DELETE /api/sessions` + `POST .../resize` + WS `/ws/{id}`（accept 前 `require_ws_token` 驗 `?token=`；模式 A：WS 斷不關 session；PTY EOF→close 4001+清 session、tie-break 以 is_alive 為準） | `router` |
| `routes/config.py` | `GET /api/config`（附 is_first_run）+ 細粒度寫入（roots/manual/overrides/accounts；add 類 canonicalize+驗存在、移除/改帳號類只 canonicalize）+ `POST .../onboard` + `POST .../check-dir`（回 `status` 判別碼）；account CRUD（級聯 reassign、key grammar、至少留1），鎖 + 驗證 | `router` |

### src/ — React 前端
| 檔案 | 職責 | 匯出 |
|------|------|------|
| `App.tsx` | 根元件：組裝 Sidebar+TabBar+多 Terminal、啟動連線（port→token→setAuthToken→health→setPort，token 先於受保護請求）、5s health poll→backendStatus、後端斷線 banner+重啟原子轉移、claude/權限 notice、快捷鍵（Cmd+W/1-9/,/T/R）、掛 Settings/Picker/Onboarding、關閉執行中分頁確認框（CloseConfirm） | `App` |
| `store/useAppStore.ts` | Zustand 單一真相源：tabs/activeTab/projects/config + session 生命週期（模式 A）+ config actions + 韌性（Tab.status offline/ended、backendStatus 狀態機、setTabStatus/restartTab/markAllTabsEnded/recordHealth）+ `Tab.activity`（working/idle 活動態）+ setTabActivity + 關閉守門（requestCloseTab：ready+sessionId 一律跳確認框〔含 idle〕、offline/ended 直接關、pendingCloseTabId）；openTab 以 (path,account) 識別 | `useAppStore`, `Tab` |
| `lib/sidecar.ts` | 拿 port/token、HTTP client wrapper（所有 fetch 帶 `X-Fledge-Token`）；`scanPreview` 回 `{path,count,status}`、`checkDir` 回 `DirStatus`；`wsUrl` 附 `?token=` | `waitForSidecarPort()`, `waitForSidecarToken()`, `setAuthToken()`, `authHeaders()`, `wsUrl()`, `fetchHealth()`, `rawHealth()`, `restartSidecar()`, `fetchProjects()`, `scanPreview()`, `onboard()`, account/config 寫入 wrappers, `checkDir()`, `DirStatus`, `PreviewStatus`, `Project`, `AppConfigData`, `Health` |
| `lib/dialog.ts` | Tauri plugin-dialog 封裝：開系統資料夾選擇器 | `pickDirectory()` |
| `lib/sidebarGroups.ts` | 純函式：依帳號分組 + 三 band 分類/排序（Sidebar 呈現邏輯，可單元測試） | `groupProjectsByAccount()`, `tabKey()`, `AccountGroup` |
| `lib/wsReconnect.ts` | 純函式：WS 重連策略（4001/1008 不重連、其他 backoff 5 次） | `shouldReconnect()`, `nextDelay()`, `MAX_RECONNECT_ATTEMPTS` |
| `lib/backendStatus.ts` | 純函式：backend health 狀態機（up/suspect/down/restarting + up-hysteresis） | `nextBackendState()`, `BackendStatus`, `BackendState` |
| `lib/activityTracker.ts` | PTY 活動偵測：per-tab 閒置計時器 + 轉換節流（IDLE_MS=800）+ **size-gate（MIN_OUTPUT_BYTES=16，忽略 idle 游標心跳等小 chunk；打字整行重繪 >16 無法濾，屬接受限制）**，由 Terminal.onmessage 餵（含 chunk size）、標記 `Tab.activity`（best-effort working/idle） | `recordActivity(tabId,size)`, `clearActivity()`, `IDLE_MS`, `MIN_OUTPUT_BYTES` |
| `lib/tabDotState.ts` | 純函式：`Tab` 的 status × activity → 單一 `DotState`（status 優先；給 TabBar 狀態點用） | `tabDotState()`, `DotState` |
| `components/Sidebar.tsx` | 依帳號（＝專案類型）分組列專案 + 三 band（開啟中/已接觸/自動發現收合）+ 帳號色塊標題 + 底部開資料夾 + 右鍵選單（改帳號/Finder/移除） | `Sidebar` |
| `components/TabBar.tsx` | tab 列：切換 + 帳號 chip + 關 tab + 統一狀態點（`tabDotState`：working 呼吸/waiting 穩定/連線態，取代 ●/⚠ 前綴） | `TabBar` |
| `components/Terminal.tsx` | xterm.js 渲染：連 WS（用 `wsUrl()` 帶 `?token=`）雙向 I/O + ResizeObserver 回報 PTY 尺寸 + onclose 重連狀態機（4001 ended/其他 backoff，gate on backendStatus 用 getState 不放 effect 依賴）；onmessage→recordActivity、teardown→clearActivity（活動偵測旁路，§7 僅 3 處） | `Terminal` |
| `components/Settings.tsx` | 設定頁 modal（Cmd+,）：roots/manual 編輯（打字或「瀏覽…」picker）+ 帳號編輯（接 AccountsEditor） | `Settings` |
| `components/ContextMenu.tsx` | 通用右鍵選單（邊緣 clamp、任意鍵關） | `ContextMenu`, `MenuItem` |
| `components/ProjectPicker.tsx` | 選專案 dialog（Cmd+T，fuzzy filter） | `ProjectPicker` |
| `components/Onboarding.tsx` | 首次設定全屏 3 步 wizard（is_first_run 觸發：歡迎→設根+即時試掃→總結，完成才寫檔）；依 scan-preview status 擋無效 draft、denied 用 amber notice | `Onboarding` |
| `components/AccountsEditor.tsx` | 設定頁帳號編輯區：加/改 config_dir/改 label/刪（級聯轉移面板）+ config_dir 警告依 DirStatus（不存在/不可讀/非資料夾） | `AccountsEditor` |
| `components/Logo.tsx` | 品牌三色填色羽毛標（去背 PNG，與桌面 app icon 同源）共用元件；`<img>` 引用 `assets/fledge-feather.png`，接受 `size` prop（＝高度 px） | `FeatherMark` |
| `components/Workspace.tsx` | TabBar+Terminal 合成一體面板（保留全 tab mount + display 切換）；tab 狀態矩陣與 ended/offline 子狀態 | `Workspace` |
| `styles/term-theme.ts` | 從 CSS 變數讀終端機色組，回傳 xterm `ITheme`；讀取時機：xterm 初始化 + 主題切換 | `readTermTheme` |
| `index.css` | CSS 變數 token 層（`:root` 品牌色 + `[data-theme]` 語義/表面/終端機 token）；各 UI 元件 CSS 均從此繼承，末尾含 `prefers-reduced-motion` 全局重置 | — |

> 各 UI 元件均有同名 `*.css` 兄弟檔（如 `Sidebar.tsx` ↔ `Sidebar.css`），品牌 token 均從 `index.css` 繼承，不重複定義色彩值。

### sidecar/tests/ — sidecar 測試（鏡像對應）
| 檔案 | 測什麼 |
|------|------|
| `test_health.py` | health endpoint |
| `test_app_config.py` | 設定讀寫 round-trip + 寫入 helpers + 原子寫 |
| `test_project_scanner.py` | depth=1 掃描、排除隱藏、root 欄位、套 override |
| `test_projects.py` | /api/projects |
| `test_config_routes.py` | config 寫入 endpoints（鎖/驗證/防呆/持久化） |
| `test_pty_bridge.py` | PTY round-trip、env override、並發 |
| `test_sessions.py` | session 建立 + WS echo + resize + 模式 A |

### build / 環境
| 檔案 | 用途 |
|------|------|
| `sidecar/build_binary.sh` | PyInstaller 打包 sidecar 成 onedir 資料夾 + nested ad-hoc 簽章，rsync 到 `binaries/` |
| `sidecar/pyproject.toml` | Python 依賴與測試設定 |
| `vitest.config.ts` | 前端 vitest 設定（store lifecycle 測試） |

---

## 影響鏈

> 修改左側檔案時，Claude 必須提醒使用者檢查右側關聯檔案。

| 修改了... | 需要檢查... |
|-----------|------------|
| `sidecar/.../routes/*.py`（endpoint / 參數變更） | `src/lib/sidecar.ts`、對應前端元件、`sidecar/tests/test_*.py` |
| `sidecar/.../pty_bridge.py`（Session 介面變更） | `routes/sessions.py`、`src/components/Terminal.tsx`、`test_pty_bridge.py` |
| `src/components/Terminal.tsx`（onmessage / teardown 變更） | §7 終端機不變式、`src/lib/activityTracker.ts` |
| `sidecar/.../app_config.py`（config schema 變更） | `~/.fledge/config.json` 結構、onboarding/設定頁、`test_app_config.py` |
| `sidecar/.../paths.py`（正規化/驗證行為變更） | `routes/config.py`、`routes/projects.py`、`app_config.py`（load 遷移）、`test_paths.py` 及上述各 test |
| `sidecar/.../__main__.py`（port 協定變更） | `src-tauri/src/sidecar.rs`（抓 port 的 prefix 比對） |
| `src-tauri/tauri.conf.json`（`bundle.resources` 名/路徑變更） | `sidecar/build_binary.sh`（onedir 資料夾命名）、`src/sidecar.rs`（`resource_dir().join("fledge-sidecar")` 路徑） |
| `sidecar/pyproject.toml`（新增套件） | `build_binary.sh`（PyInstaller hidden imports） |
| `src/components/Sidebar.tsx`（分組邏輯變更） | `src/lib/sidebarGroups.ts`、`src/lib/sidebarGroups.test.ts` |

---

## 環境變數清單

| 變數名 | 用途 | 預設值 | 必填 |
|--------|------|--------|------|
| `CLAUDE_CONFIG_DIR` | 傳給 `claude` subprocess 切換帳號（工作/私人） | `~/.claude` | 由 sidecar 動態設 |
| `FLEDGE_CONFIG_PATH` | 覆蓋設定檔路徑（測試用） | `~/.fledge/config.json` | ❌ |
| `FLEDGE_TEST_COMMAND` | 測試模式替代 `claude` 的命令（如 `cat`） | 無（正常跑 claude） | ❌（僅測試） |
| `FLEDGE_TOKEN` | sidecar 認證 token（HTTP `X-Fledge-Token` / WS `?token=`） | 無 | 由 Tauri 殼 per-launch 生成注入（prod 必有；不灌進 claude 子進程） |
| `FLEDGE_TEST_UNAUTH` | 設 `1` 關閉認證（測試/手動執行 opt-out；conftest autouse 預設設此） | 無 | ❌（僅測試/手動） |

---

## 備註

- 本文件由開發者維護，Claude Code 在結構變更時應提醒更新
- 影響鏈僅為提醒，不代表一定要修改右側檔案
- 韌性、path 正規化、sidecar 認證 token + CORS 收緊、桌面打包（onedir sidecar + curl/dmg 安裝，macOS arm64）均已完成。

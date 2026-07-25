# PROJECT_MAP.md — 專案模組地圖

> Claude Code 每次任務開始前必須讀取本文件，了解專案全貌與模組關係。
> 結構變更時必須同步更新本文件。

---

## 專案資訊

- **專案名稱：** Fledge — AI Workflow Studio（短名 `fledge`）
- **技術棧：** Tauri 2.x（Rust 殼）+ Python sidecar（FastAPI）+ React + TypeScript（Vite）
- **最後更新：** 2026-07-25

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
| `capabilities/default.json` | 權限：執行 sidecar、opener reveal、opener open-path（檔案樹雙擊開檔，scope `$HOME/**`）、dialog open（directory picker）、clipboard-manager read-text（終端機右鍵貼上走原生讀，繞 macOS Paste 膠囊） | — |

### sidecar/fledge_sidecar/ — Python sidecar
| 檔案 | 職責 | 匯出 |
|------|------|------|
| `__main__.py` | entry：拿空 port、啟 uvicorn、印 `FLEDGE_PORT=` | `main()` |
| `app.py` | FastAPI app 組裝、掛路由 + `TokenAuthMiddleware`（驗 `X-Fledge-Token`、真 preflight 放行）+ CORS 收緊到 Tauri origin + 啟動認證狀態 log；lifespan startup 呼 `account_activity.mark_process_start`（活動 log 孤兒回收基準）、shutdown 關所有 PTY session | `create_app()` |
| `auth.py` | sidecar 認證純函式（fail-closed 預設 + `FLEDGE_TEST_UNAUTH=1` opt-out；call-time 讀 env）：`token_ok`（constant-time）、`require_ws_token`（WS 共用） | `auth_disabled()`, `configured_token()`, `token_ok()`, `require_ws_token()` |
| `paths.py` | 路徑正規化純函式：`expand_and_validate`（拒空/相對）、`probe_dir`（os.stat 四態 dir/missing/not_dir/denied，不用 is_dir 以分 missing/denied）、`resolve_best_effort`（跟隨 symlink、永不 raise）、`canonicalize`；containment helper：`is_within_root`/`is_within_any_root`（以 root+os.sep 比對避免 prefix 偽命中） | `expand_and_validate()`, `probe_dir()`, `resolve_best_effort()`, `canonicalize()`, `DirStatus`, `is_within_root()`, `is_within_any_root()` |
| `app_config.py` | `~/.fledge/config.json` 讀寫（原子寫）+ root/manual/override/account 寫入 helpers（含 account_references + remove_account 級聯 reassign）+ `kms_root`（KMS 根目錄，raw 含 ~、runtime 才 expanduser、不過 _migrate_path）+ `set_kms_root`；load 時自我遷移既有路徑成 canonical（resolve）+ 依 canonical 去重 | `AppConfig`, `default_config_path()` |
| `project_scanner.py` | 根目錄 depth=1 掃描（標所屬 root、套 project_overrides）+ CC 用過記錄合併；逐 root best-effort 容權限（`scan_all` 回 `(projects, permission_error)`）；`encode_cc_project_dir` 編碼對齊 Claude Code（非英數→`-`）；`scan_all` recent 跨帳號 union | `scan_all()`, `scan_root()`, `encode_cc_project_dir()` |
| `dir_tree.py` | 列一層目錄純函式：`list_dir_entries`（排除 dotfiles、資料夾在前+名稱 casefold 升冪、內容層 no-raise，I/O 例外由呼叫端 wrap） | `list_dir_entries()` |
| `pty_bridge.py` | PTY 橋接、Session 管理（threading.Lock）、env 切帳號、resize；`create_session` 接受選填 `session_id`（route 先生成以記活動 log）、`on_close` callback（關閉通知→記 close 事件）、`live_ids()`（當前存活集合，給歸屬判 liveness）、`env_remove`（呼叫端指定額外剔除的 env key，install session 用）；child env 剔除 `FLEDGE_TOKEN`/`FLEDGE_TEST_UNAUTH`/`FLEDGE_PORT`（不灌 secret 進 claude，也不灌 sidecar 內部 port 進子進程） | `PtyBridge`, `Session` |
| `routes/health.py` | `GET /api/health`（附 `claude_found`：shutil.which 判 claude 是否安裝） | `router` |
| `routes/projects.py` | `GET /api/projects`（回 `permission_error`）+ `POST .../scan-preview`（onboarding 試掃計數、不落檔；回 `status` 判別碼 ok/denied/missing/not_dir/invalid，讓 wizard 預先擋無效 draft）+ `POST /api/projects/tree`（lazy 檔案樹；containment 順序：expand→realpath→先 explicit deny kms_root subtree〔含 child metadata 過濾〕→再限 allowed roots〔roots∪manual〕；error contract ok/invalid 400/forbidden 403/denied|missing|not_dir 200） | `router` |
| `routes/sessions.py` | `POST/DELETE /api/sessions` + `POST .../resize` + WS `/ws/{id}`（accept 前 `require_ws_token` 驗 `?token=`；模式 A：WS 斷不關 session；PTY EOF→close 4001+清 session、tie-break 以 is_alive 為準）+ flow control gate（connection-scoped `asyncio.Event`：WS text frame `{"type":"pause"/"resume"}` 經 `_apply_flow_control` 閘住 PTY→WS 方向；binary=PTY bytes、text 永不入 PTY；pump 1s timeout 仍可察覺 paused 中 EOF）；`CreateSessionRequest.kind`（claude/terminal/install/login，`extra="forbid"` 擋未知欄位注入）→`_resolve_command`：terminal 跑 `$SHELL -l`、login 跑 `claude`（OAuth）或 `codex login`（`login_target`）；install 走獨立分支：`get_install_command(install_id)` allowlist 查表（未知→400）、空 env_overrides + `env_remove=["CLAUDE_CONFIG_DIR"]`（最小 env、不歸屬帳號）；其餘 kind 建立時驗 `req.account` 合法（未知→400）、login 注入帳號 env、claude session **spawn 前** `account_activity.record_open`（spawn 失敗補 close）、`on_close` wiring 記 close（僅有 record_open 的 claude session，`_opened_session_ids` gating）、暴露 `live_session_ids()` 給歸屬判 liveness | `router`, `live_session_ids()` |
| `routes/config.py` | `GET /api/config`（附 is_first_run）+ 細粒度寫入（roots/manual/overrides/accounts；add 類 canonicalize+驗存在、移除/改帳號類只 canonicalize）+ `POST .../onboard` + `POST .../check-dir`（回 `status` 判別碼）+ `PUT .../subscriptions`（訂閱費清單，name 非空/cost 有限非負）+ `PUT .../kms-root`（KmsRootBody Pydantic、`_config_lock`、回 `{ok,kms_root}`、不驗目錄存在）；account CRUD（級聯 reassign、key grammar、至少留1），鎖 + 驗證 | `router` |
| `routes/usage.py` | `GET /usage/dashboard?days=`（數據儀表板成本面板）：single-flight 掃描（25s stale gate、error 立即 retry、days 變更視為 stale）＋`asyncio.to_thread` 不卡 event loop＋last-good 語義（掃描中回舊資料標 scanning、冷掃 202+Retry-After、冷掃失敗 error-only 200）；模組級 `_state`（snapshot/cache/scanning）。另 `GET /usage/codex`：Codex 實時額度（呼 `api/codex_usage`）＋ `CODEX_USAGE_MIN_INTERVAL_SEC`(60s) 合併 floor（`_codex_state`），失敗回 typed unavailable 不 fallback 舊快照 | `router`, `reset_state_for_tests()` |
| `api/codex_usage.py` | Codex 實時額度抓取（api/ 層唯一對外出口）：讀 `~/.codex/auth.json` 的 `access_token`+`account_id`→GET `chatgpt.com/backend-api/codex/usage`（Bearer+`chatgpt-account-id`，8s timeout）→正規化 `primary/secondary_window`→`{used_percent,window_minutes,resets_at}`；**token 只進 header 絕不 log/回傳**，任何例外 redaction 成 typed 失敗（no_auth/unauthorized/network/bad_response），不外洩 raw exception | `fetch_codex_usage()`, `normalize_usage()`, `USAGE_URL` |
| `usage/pricing.py` | 定價表（Claude＋gpt-5 系列含 mini/nano 尺寸帶與 gpt-5.6 sol/terra/luna tier 帶）＋模型名正規化（別名/日期後綴/`<synthetic>`→None/價格帶不跨價）＋兩源計價（USD per MTok ÷1e6、cache 三層倍率、cached⊆input）；`PRICING_VERSION` 供 L2 重算 | `PRICING_VERSION`, `CLAUDE_PRICING`, `CODEX_PRICING`, `normalize_*_model()`, `claude_cost()`, `codex_cost()` |
| `usage/parser.py` | 兩格式逐行解析→瘦條目 `UsageEntry`（內容層不拋例外：壞行/壞值跳過計數；I/O 例外由呼叫端 wrap）：claude（快篩純最佳化、cache precedence nested 優先、dedup_key、sidechain）＋codex rollout（last/累計差分 clamp、turn_context model、session_meta cwd、rate_limits 末筆） | `UsageEntry`, `CodexFileResult`, `parse_claude_file()`, `parse_codex_file()` |
| `usage/scanner.py` | 兩源檔案發現（回傳一律 realpath）：claude＝各帳號 config_dir/projects 遞迴＋realpath 去重，另回 realpath→account_key 對應表（tie-break 按 account_key 排序取第一、不依 dict 序）；codex＝sessions/archived 的 per-session canonical selection（active>mtime_ns>size>路徑全序；首行窺視 session_id、_PEEK_LIMIT 1MiB） | `claude_files()`, `claude_account_map()`, `_scan_claude()`, `codex_files()` |
| `usage/cache.py` | L1 記憶體＋L2 磁碟瘦條目快取：(size, mtime_ns) 失效、bounded ThreadPool 平行 parse、`threading.Lock` 序列化、L2 損壞寬 catch 重建、pricing_version 變更只重算 cost 不重 parse、generation 防舊蓋新（同 schema 代才比較）、變動才落盤、atomic write；`RefreshResult` 另暴露 `claude_by_file`（realpath→entries shallow snapshot、只含 claude，防 route/測試 mutate 污染 L1） | `UsageCache`, `FileCacheEntry`, `RefreshResult`, `SCHEMA_VERSION` |
| `usage/aggregator.py` | dashboard payload 組裝：claude dedup 替換規則（parent>sidechain>token 多者）、synthetic 濾除、KPI（本地時區視窗/Net ROI/分源 cache 命中率）、daily/models/projects（memoized realpath）/hourly（7×24 週一起）聚合（900s bucket memo 消 datetime 成本）；payload 無 blocks（Codex 額度改走 `/usage/codex` 實時、Claude 5hr 卡片移除） | `build_dashboard()` |
| `usage/account_activity.py` | 帳號活動 log（補 jsonl 缺的帳號身分）：sidecar 自有 append-only JSONL（0600、module lock、**fail-open** 絕不阻斷 session 建立）；`record_open`/`record_close`（open/close 事件）、`mark_process_start`、`load_sessions`（pair open/close、liveness 以 bridge live 集合為權威 + read-time 孤兒回收：前一進程關於 process_start、本進程已不在 bridge 關於 now）、`attribute`（cwd containment + 最深匹配 + open_ts tie-break） | `record_open()`, `record_close()`, `mark_process_start()`, `load_sessions()`, `attribute()`, `SessionSpan` |
| `routes/memory.py` | 記憶層路由（唯讀聚合 + 唯一寫 memory-links.json）：`GET /memory/overview?q=`/`/related`/`/item`（單筆全文，realpath containment + allowlist 擋 root 外/`..`/逃逸 symlink）+ links CRUD（`POST`/`DELETE /links`、`POST /links/confirm`/`/dismiss`）；v1 scan-on-demand（`_scan` 各帳號 account-local known projects、KMS topic 以 folder 識別）；links.json 路徑可 `FLEDGE_MEMORY_LINKS` 覆蓋 | `router`, `reset_state_for_tests()` |
| `memory/parser.py` | markdown + frontmatter（YAML-lite）→ `ParsedDoc`；wikilink `[[..]]`（取 `\|` 前的 target、去重保序）；no-raise（OSError/解析錯→None，與 usage parser 同契約） | `ParsedDoc`, `parse_doc()` |
| `memory/scanner.py` | 找檔（對來源永遠唯讀）：`native_memory_files` 三態歸屬（encoded 反查：1 命中 matched／≥2 ambiguous／0 orphan，跳 MEMORY.md）+ `kms_files` 只掃 `library/`+`topics/`、`is_kms_file_allowed` realpath containment（擋 hidden/`_*`/CLAUDE.md/逃逸 symlink，與 route 共用） | `NativeRef`, `KmsRef`, `native_memory_files()`, `kms_files()`, `is_kms_file_allowed()` |
| `memory/links.py` | Fledge-owned `memory-links.json`（唯讀源外唯一寫入）：`LinksStore` 無向 (min,max) 去重 + dismissed 綁 pair + module-level lock 序列化並寫（read-modify-write 重讀）+ atomic write（tmp→rename）0600；`suggest_links` topic 名/tags 正規化⊇專案名（長度<4 只手動） | `LinksStore`, `suggest_links()`, `_norm()` |
| `memory/aggregator.py` | 組面板 payload：scope 分層（native user/feedback→global、project/reference→project、其餘→unknown；kms→kb）、專案中心分組（已連 topic 掛 project、unattributed/unknown 皆可見不靜默丟）、in-memory 搜尋（含 body、回 snippet）；**overview 只回摘要不含 body** | `MemoryItem`, `to_item()`, `build_overview()`, `build_related()` |
| `routes/setup.py` | `GET /api/setup/status`（開發環境偵測：回 `{tools:[ToolStatus…]}`；安裝／登入不在此——走 `POST /api/sessions` kind=install/login）＋共通設置兩端點 `POST /api/setup/common-config/plan`（唯讀預覽）／`/apply`（實際套用）：Pydantic body `extra="forbid"`、apply 由 server 以相同輸入**重算 plan**（ADR-0002，不吃 client plan）、`_setup_lock` 序列化並發 apply；錯誤分流 `_PlanError`——`config_unreadable` 500（`json.JSONDecodeError` 是 `ValueError` 子類，不可當判別碼外洩）／模組判別碼 400／`probe_failed` 500（探測期 `OSError`） | `router` |
| `setup/install_specs.py` | 開發工具資料表＋allowlist 安裝命令：`ToolSpec`（id/label/tier/binary/version_argv/install_command/docs_url）常數表（macOS/Homebrew 生態，core＋recommended 兩級）；**安全不變式：安裝命令只能來自本檔常數、route 以 install_id 查表**，Homebrew 本體 install_command=None（僅手動複製指令） | `ToolSpec`, `TOOL_SPECS`, `get_spec()`, `get_install_command()` |
| `setup/env_detect.py` | 開發工具偵測純函式：which 命中才探版本（`_VERSION_TIMEOUT` 2s＋ThreadPool 平行、保序）；which/run 參數注入便於測試；版本探測失敗→version=None 不中斷 | `ToolStatus`, `detect_tool()`, `detect_all()` |
| `setup/common_config.py` | 雙帳號共通設置（B/C 共用）：`build_account_graph`（模組自為安全權威，expand→absolute→resolve＋拒 home／祖先／根＋拒 target 解析到 source、與 source 祖先—子孫重疊、target 彼此重複或彼此巢狀）、`probe_entry`（lstat no-follow 十一態，含 source 型別前置驗證；`ok` 判定要求 realpath 落在 source dir 內）、`plan`（純函式）、`apply`（逐項盡力＋mutation 前重探測與 target dir realpath 重驗擋 TOCTOU＋動作與授權需求由驗過的 state 重算＋`(account, entry)` 授權閘＋就地改名備份不覆蓋＋relink 走隔離改名不誤刪＋`_copy_file` 以 `O_EXCL` 不跟隨不覆蓋、寫滿短寫）；source entry 是 symlink 時連字面路徑不追鏈 | `ENTRY_SPECS`, `build_account_graph()`, `probe_entry()`, `plan()`, `apply()` |

### src/ — React 前端
| 檔案 | 職責 | 匯出 |
|------|------|------|
| `App.tsx` | 根元件：組裝 Sidebar+TabBar+多 Terminal、啟動連線（port→token→setAuthToken→health→setPort，token 先於受保護請求）、5s health poll→backendStatus、後端斷線 banner+重啟原子轉移、claude/權限 notice、快捷鍵（Cmd+W/1-9/,/T/R）、掛 Settings/Picker/Onboarding、關閉執行中分頁確認框（CloseConfirm）、useLayoutEffect 同步 `modalOpen`（任一 modal 開啟＝唯一寫入者，供拖檔 drop gate）；pendingTitle 用 `isLiveClaudeTab`（共用判定）；加掛 `<DndContext>`（PointerSensor distance:5、pointerWithin、onDragStart/End 依 data.type 分流 tab 排序/path 貼路徑、DragOverlay）+ module 層 `dropPathsToActiveTerminal`（drop gate：modal/kind/status/IME/paths/格式化） | `App` |
| `store/useAppStore.ts` | Zustand 單一真相源：tabs/activeTab/projects/config + session 生命週期（模式 A）+ config actions + 韌性（Tab.status offline/ended、backendStatus 狀態機、setTabStatus/restartTab/markAllTabsEnded/recordHealth）+ `Tab.activity`（working/idle 活動態）+ setTabActivity + 關閉守門（requestCloseTab：ready+sessionId 一律跳確認框〔含 idle〕、offline/ended 直接關、pendingCloseTabId）+ `modalOpen` 旗標（拖檔 drop gate 單一判定來源）；`Tab.kind`（claude/terminal/dashboard/memory）；openTab 以 (path,account) 識別（terminal 不去重）；openTab 加選填 forceNew（claude 跳過去重、強制開新視窗；右鍵「開新 Claude 視窗」與 restartTab 使用）；`openMemory` 單例分頁（比照 openDashboard，純前端無 session；closeTab/restartTab/markAllTabsEnded 與 dashboard 同組免特判 session）；requestCloseTab 改用 `isLiveClaudeTab`；restartTab 沿用 `tab.kind`；加 `reorderTabs` action；`openTab` 的 terminal 分頁用 `insertTabAdjacent` 相鄰插入 | `useAppStore`, `Tab` |
| `lib/sidecar.ts` | 拿 port/token、HTTP client wrapper（所有 fetch 帶 `X-Fledge-Token`，`sidecar.test.ts` 列舉鎖定）；`scanPreview` 回 `{path,count,status}`、`checkDir` 回 `DirStatus`；`wsUrl` 附 `?token=`；`createSession` 第 4 參數 `kind`；記憶層 fetchers（`fetchMemoryOverview` 含 `Array.isArray(projects)` 守衛/`fetchMemoryRelated`/`fetchMemoryItem`〔!ok throw〕+ links 寫入 wrappers `memoryJson`〔!ok throw，支援右欄錯誤 UX〕）+ `putKmsRoot`；`AppConfigData.kms_root?`；加 `fetchDirTree`（HTTP !ok throw、200 帶 status 不 throw）+ 型別 `DirEntry`/`DirTreeResult` | `…既有…`, `fetchMemoryOverview()`, `fetchMemoryRelated()`, `fetchMemoryItem()`, `confirmSuggestion()`, `dismissSuggestion()`, `addMemoryLink()`, `removeMemoryLink()`, `putKmsRoot()`, `MemoryOverview`, `MemoryItem`, `MemoryRelated`, `MemorySuggestion`, `fetchDirTree()`, `DirEntry`, `DirTreeResult`, `fetchCodexUsage()`, `CodexUsage` |
| `lib/dialog.ts` | Tauri plugin-dialog 封裝：開系統資料夾選擇器 | `pickDirectory()` |
| `lib/liveTab.ts` | 純函式：live Claude session 判定（kind=claude + ready + sessionId），store/App 共用；terminal tab 永遠回 false | `isLiveClaudeTab()` |
| `lib/tabOrder.ts` | 純函式：`reorderTabs`（拖曳排序 arrayMove）+ `insertTabAdjacent`（需求 2 相鄰插入：同 projectPath 群尾） | `reorderTabs()`, `insertTabAdjacent()` |
| `lib/tabTitle.ts` | 純函式：分頁顯示標題（claude 同 (path,account) 多視窗加序號 #2/#3，render 時算、關閉重編號；非 claude 回 raw title） | `displayTabTitle()` |
| `lib/terminalRegistry.ts` | 終端機 imperative handle 旁路登錄（比照 activityTracker）：`Map<tabId, {paste, isComposing}>`，供 dnd drop 找 active 終端機貼路徑 | `registerTerminal()`, `unregisterTerminal()`, `getTerminal()`, `TerminalHandle` |
| `lib/memoryView.ts` | 純函式：記憶面板 overview→視圖（`buildGroups` 分組／`defaultExpanded` 專案展開／`matchesFacet`+`applyFacet` 前端過濾／`selectionValid` path-anywhere 含 fan-out）+ 型別 `MemoryGroupVM`/`Facet`/`Selection` | `buildGroups()`, `defaultExpanded()`, `matchesFacet()`, `applyFacet()`, `selectionValid()` |
| `lib/sidebarGroups.ts` | 純函式：依帳號分組 + 三 band 分類/排序（開啟中/已接觸/自動發現）；每群組 recent band 最多 `RECENT_BAND_LIMIT`(=3) 筆（manual 豁免）、溢出存 `AccountGroup.surfacedMore`（Sidebar 呈現邏輯，可單元測試） | `groupProjectsByAccount()`, `tabKey()`, `AccountGroup`, `RECENT_BAND_LIMIT` |
| `lib/wsReconnect.ts` | 純函式：WS 重連策略（4001/1008 不重連、其他 backoff 5 次） | `shouldReconnect()`, `nextDelay()`, `MAX_RECONNECT_ATTEMPTS` |
| `lib/backendStatus.ts` | 純函式：backend health 狀態機（up/suspect/down/restarting + up-hysteresis） | `nextBackendState()`, `BackendStatus`, `BackendState` |
| `lib/activityTracker.ts` | PTY 活動偵測：per-tab 閒置計時器 + 轉換節流（IDLE_MS=2000，離開 working 的確認窗，容忍思考暫停、防 working↔waiting 閃爍）+ **size-gate（MIN_OUTPUT_BYTES=16，忽略 idle 游標心跳等小 chunk；打字整行重繪 >16 無法濾，屬接受限制）**，由 Terminal.onmessage 餵（含 chunk size）、標記 `Tab.activity`（best-effort working/idle） | `recordActivity(tabId,size)`, `clearActivity()`, `IDLE_MS`, `MIN_OUTPUT_BYTES` |
| `lib/tabDotState.ts` | 純函式：`Tab` 的 status × activity → 單一 `DotState`（status 優先；給 TabBar 狀態點用） | `tabDotState()`, `DotState` |
| `lib/imeReplayGuard.ts` | 純狀態機：IME 切視窗重放攔截保險網（組字中文字 onData＝候選 → compositionend 空＋blur 確認武裝 → 攔相同 trusted insertText 恰一次）＋組字中 Meta keydown 該吞判定（真懸置核心——防 xterm 提前 finalize） | `ImeReplayGuard` |
| `lib/imeDraftTracker.ts` | 純狀態機：IME 懸置幽靈草稿該不該顯示（compositionupdate 記草稿 → end 空＋blur 確認顯示 → compositionstart/dismiss 退場），渲染在 Terminal 接線 | `ImeDraftTracker` |
| `lib/flowControl.ts` | 純狀態機：PTY 輸出 watermark flow control（`record` 計入/`ack` 扣除 → 越 HIGH=100K 回 pause、回落 LOW=10K 回 resume，遲滯+冪等；`pendingBytes` 供驗收量測），由 Terminal.onmessage 計帳、觸發送 WS 控制訊息 | `FlowController`, `FlowSignal`, `HIGH_WATERMARK`, `LOW_WATERMARK` |
| `lib/dropPath.ts` | 純函式：拖檔路徑智慧引號格式化（safe charset `[\p{L}\p{N}/._-]` 原樣、其餘 POSIX 單引號跳脫 `'`→`'\''`、含控制字元整項跳過、多檔空白 join+尾隨空白、全跳過回空字串），供 Terminal 拖檔接線 | `formatPathsForPaste()` |
| `lib/terminalLinks.ts` | 純函式：終端機行內連結偵測（Cmd+click 開連結用）。`linksInLine` 掃 URL（只放行 http/https/mailto/tel、剝尾隨標點）+ 檔案路徑（相對路徑對 projectPath 解析、`~/` 展開、剝 `:line:col`、containment 落在 home 內才放行、`..` 逃逸/home 外拒絕；無 home 只回 URL）；`strIndexToColumn` 把字串索引→xterm 欄位（全形字 spacer 校正） | `linksInLine()`, `strIndexToColumn()`, `TerminalLink`, `LinkOpts` |
| `i18n.ts` | i18n 最小基建（react-i18next）：語言權威序 localStorage `fledge-lang` > OS zh 偵測 > en；defaultNS dashboard；註冊 namespace `dashboard` + `memory` + `sidebar` | default `i18n` |
| `locales/{zh-TW,en}/dashboard.json` | 數據儀表板 locale catalog（兩檔 key 對齊，`i18nCatalog.test.ts` parity 鎖定）；既有元件字串遷移留後續 | — |
| `locales/{zh-TW,en}/memory.json` | 記憶層 locale catalog（tabTitle/entry/search/section/related/attribution/settings/detail/a11y…；`memory-parity.test.ts` 鎖兩語 key 一致；type enum 值刻意顯示原值不翻譯〔§4.6.13 記錄例外〕）| — |
| `locales/{zh-TW,en}/sidebar.json` | 側邊欄/分頁/檔案樹 locale catalog（search/menu/empty/tree/tabBar；`sidebar-parity.test.ts` 鎖兩語 key 一致） | — |
| `lib/usageFormat.ts` | 純函式：儀表板數字格式化（fmtUSD 含負數/<$0.01、fmtPct、fmtTokens K/M、fmtClock HH:mm、fmtDayClock 今天/昨天/M/D）＋Codex 額度窗口標籤角色判定（`codexWindowLabel`：依 window_minutes 非位置，invalid 退 fallback） | `fmtUSD()`, `fmtPct()`, `fmtTokens()`, `fmtClock()`, `fmtDayClock()`, `codexWindowLabel()`, `WindowLabel` |
| `lib/usagePoll.ts` | 純函式：儀表板輪詢 gating（作用分頁＋頁面可見才打 API）＋30s 成本面板間隔／15min Codex 額度間隔常數 | `shouldPoll()`, `POLL_INTERVAL_MS`, `CODEX_USAGE_INTERVAL_MS` |
| `lib/dashboardLogic.ts` | 純函式：面板邏輯（donutParts top4+rest 角度） | `donutParts()` |
| `lib/subscriptionsForm.ts` | 純函式：訂閱費表單驗證（與 sidecar PUT 400 規則一致：name 非空、cost 有限非負） | `validateSubscriptions()` |
| `components/FileTree.tsx` | 檔案樹容器：lazy 載入快取（`Map<path,{entries,status}>`）+ 展開 Set + 錯誤節點 retry；遞迴渲染子層 | `FileTree` |
| `components/FileTreeNode.tsx` | 單節點（資料夾/檔案）：caret、icon、`useDraggable`（id `tree:`、data type=path）、雙擊 `openPath` 開檔 | `FileTreeNode` |
| `components/Dashboard.tsx` | 數據儀表板分頁（單頁長滾動）：成本面板 30s 輕輪詢（首掃 2s、visibility/isActive gating、error 保留舊資料標 stale）＋ KPI 5 卡/每日成本堆疊長條/模型 donut/時段 heatmap 週一起/專案表 top30；Codex 額度卡 `CodexPanel` 走**獨立 effect**（`/usage/codex` 實時：開啟即抓、開著每 15 分鐘、isActive→true 重開強制重抓、沒看不抓；失敗顯 unavailable/reauth 不端舊數字）；全手刻 SVG/CSS 零圖表依賴、字串全走 t() | `Dashboard` |
| `components/Sidebar.tsx` | 依帳號（＝專案類型）分組列專案 + 三 band（開啟中/已接觸/自動發現收合）+ 帳號色塊標題 + 底部開資料夾 + 右鍵選單（改帳號/Finder/移除/使用終端機開啟）；open/active 判定只認 claude tab；溢出展開器（surfacedMore）；收合窄軌（`localStorage fledge.sidebarCollapsed`）；搜尋列旁 dashboard(`ChartColumn`)+memory(`Brain`→`openMemory`) 入口（收合軌與展開列雙處）；專案列抽 top-level `ProjectRow`（`useDraggable` id `project:`、展開 caret 切換檔案樹、條件渲染 `<FileTree>`）；既有字串改走 `t()`（sidebar ns） | `Sidebar` |
| `components/TabBar.tsx` | tab 列：切換 + 帳號 chip + 關 tab + 統一狀態點（`tabDotState`：working 呼吸/waiting 穩定/連線態，取代 ●/⚠ 前綴）；terminal 分頁以 SquareTerminal 圖示取代狀態點；memory 分頁以 `Brain` 圖示 + 標題走 `memory:tabTitle`；分頁改 `SortableTab`（dnd-kit `useSortable` 水平排序；close button `onPointerDown` stopPropagation 不啟動拖曳）；aria 走 sidebar ns；標題改用 displayTabTitle（claude 多視窗序號） | `TabBar` |
| `components/Terminal.tsx` | xterm.js 渲染：連 WS（用 `wsUrl()` 帶 `?token=`）雙向 I/O + ResizeObserver 回報 PTY 尺寸 + onclose 重連狀態機（4001 ended/其他 backoff，gate on backendStatus 用 getState 不放 effect 依賴）；onmessage→recordActivity、teardown→clearActivity（活動偵測旁路，§7 僅 3 處）+ flow control 計帳（per-connection `FlowController`：write 前 record/write callback ack，越 HIGH 送 pause、回落 LOW 送 resume，控制訊息綁該連線 socket 不引用外層 ws）；回前景/切 tab 強制重繪（visibilitychange/focus/isActive → fit+refresh，rAF coalesce、dims 變動才回報 resize）+ WebGL renderer（active-only 掛載、context loss/載入失敗全域退 DOM 並 console.warn、`ENABLE_WEBGL` kill switch、fonts.ready 清 atlas）+ smoothScrollDuration 125/scrollback 5000 + IME 真懸置（container capture 吞組字中 Meta／Unidentified keydown 防 xterm 提前 finalize（Unidentified＝CapsLock 中英切換附隨事件、治組字中重複輸入）；`ImeReplayGuard` 重放保險網＋`ImeDraftTracker` 幽靈草稿 ghost DOM 掛 .xterm-helpers；切回後 Esc/點擊＝確認文字屬已知平台差異；`Terminal.css` 蓋 composition-view 為主題色＋底線）+ 拖檔貼路徑（整窗 `onDragDropEvent`、isActive 閘控、drop gate：!disposed/!modalOpen/ready/paths>0/格式化非空 → `term.focus()`+`term.paste(formatPathsForPaste)`，走既有 onData→ws guard；`isActiveRef` 改 render body 同步賦值消 gap）；mount 註冊 `{paste, isComposing}` handle 到 terminalRegistry、unmount 註銷；`composingRef`（IME 組字旗標）；OS 拖檔 `onDragDropEvent` 加 IME gate＋選取複製（xterm 選取是內部狀態非 DOM Selection：Cmd+C capture 攔截 preventDefault 消 NSBeep／右鍵自訂 `ContextMenu`〔複製·貼上·全選〕，複製走 `term.getSelection()`＋`navigator.clipboard.writeText`、貼上走 `pasteFromClipboard`〔readText 全程 try/catch〕）＋Cmd+click 開連結（iTerm2 風格 `registerLinkProvider`：修飾鍵閘控〔Mac=Meta/其餘=Ctrl〕，未按住不提供連結＝不奪點擊；URL→`openUrl`、檔案路徑→`revealItemInDir`；連結偵測走 `lib/terminalLinks`，行號/全形字校正；接 `projectPath` prop 解析相對路徑；activate 二次確認修飾鍵；單行偵測，wrapped 連結為已知 v1 限制） | `Terminal` |
| `components/Settings.tsx` | 設定頁 modal（Cmd+,）：roots/manual 編輯（打字或「瀏覽…」picker）+ 帳號編輯（接 AccountsEditor）+ KMS 根目錄欄位（input+picker+儲存→`putKmsRoot`，字串走 `memory:settings.*`、含 saveError） | `Settings` |
| `components/ContextMenu.tsx` | 通用右鍵選單（邊緣 clamp、任意鍵關、`MenuItem.disabled` 灰階常駐不可點） | `ContextMenu`, `MenuItem` |
| `components/ProjectPicker.tsx` | 選專案 dialog（Cmd+T，fuzzy filter） | `ProjectPicker` |
| `components/Onboarding.tsx` | 首次設定全屏 3 步 wizard（is_first_run 觸發：歡迎→設根+即時試掃→總結，完成才寫檔）；依 scan-preview status 擋無效 draft、denied 用 amber notice | `Onboarding` |
| `components/AccountsEditor.tsx` | 設定頁帳號編輯區：加/改 config_dir/改 label/刪（級聯轉移面板）+ config_dir 警告依 DirStatus（不存在/不可讀/非資料夾） | `AccountsEditor` |
| `components/Logo.tsx` | 品牌三色填色羽毛標（去背 PNG，與桌面 app icon 同源）共用元件；`<img>` 引用 `assets/fledge-feather.png`，接受 `size` prop（＝高度 px） | `FeatherMark` |
| `components/Workspace.tsx` | TabBar+Terminal 合成一體面板（保留全 tab mount + display 切換）；tab 狀態矩陣與 ended/offline 子狀態；kind 分派加 `memory`→`<Memory>` 分支；Terminal 分支（claude/terminal + projectPath）內掛 `<RelatedFloat>`（既有 absolute wrapper 為定位包含塊，不改終端機尺寸）、並把 `projectPath` 傳進 `<Terminal>`（Cmd+click 連結的相對路徑解析）；`ws-term-area` 設 `useDroppable`（id `terminal-drop`，需求 4 drop target） | `Workspace` |
| `components/Memory.tsx` | 記憶面板容器（**master-detail 雙欄**，純前端單例分頁）：持有 selection（複合 `{path,groupKey}`／`{projectKey}`）+ facet + group 展開 Set + body 快取（key=`path@mtime`）；30s 輪詢 gating（active+!hidden）；**q-guard**（q 非空時不清 selection、清搜尋後右欄復原 pin）；組 `<MemoryIndex>`（左）+ `<MemoryDetail>`（右）| `Memory` |
| `components/MemoryIndex.tsx` | 左欄：標題+scan_meta（掃描/搜尋總數）、搜尋框（後端 q）、facet chips（前端在地過濾 source/type）、可收合 groups（`applyFacet` 後渲染、計數=可見數）| `MemoryIndex` |
| `components/MemoryGroup.tsx` | 可收合 group：caret 獨立按鈕（stopPropagation 只收合、aria-expanded）+ 選取區（專案→選專案）+ 計數 + 建議 badge；專案展開預設、其餘收合 | `MemoryGroup` |
| `components/MemoryRow.tsx` | 單行密集列（badge + 標題 + 截斷摘要 + 已連結 ◈）；`<button>` + aria-selected | `MemoryRow` |
| `components/MemoryDetail.tsx` | 右欄三態：空狀態 / item 全文（badge+meta+`<pre>` body）/ 專案脈絡（相關 chips + `SuggestionChip`）| `MemoryDetail` |
| `components/SuggestionChip.tsx` | 建議 chip（topic + ✓✕，aria-label 走 `t()`）：await 真成功（wrapper !ok 會 throw）才 `onAfterWrite`、失敗顯 error 不樂觀消失、pending 雙路徑 reset | `SuggestionChip` |
| `components/RelatedFloat.tsx` | 終端機右下懸浮（claude/terminal 分頁）：`fetchMemoryRelated` 該專案相關連結+建議；收合 pill ↔ 展開 popover；count 0 回 `null`（無連結即隱形）；`position:absolute` 不奪終端機尺寸/scroll | `RelatedFloat` |
| `styles/term-theme.ts` | 從 CSS 變數讀終端機色組，回傳 xterm `ITheme`；讀取時機：xterm 初始化 + 主題切換 | `readTermTheme` |
| `index.css` | CSS 變數 token 層（`:root` 字型 + 終端機 ANSI 16 色〔深底兩主題共用〕、`[data-theme]` 語義/表面/終端機 token）；各 UI 元件 CSS 均從此繼承，末尾含 `prefers-reduced-motion` 全局重置 | — |

> 各 UI 元件均有同名 `*.css` 兄弟檔（如 `Sidebar.tsx` ↔ `Sidebar.css`），品牌 token 均從 `index.css` 繼承，不重複定義色彩值。

### sidecar/tests/ — sidecar 測試（鏡像對應）
| 檔案 | 測什麼 |
|------|------|
| `test_health.py` | health endpoint |
| `test_app_config.py` | 設定讀寫 round-trip + 寫入 helpers + 原子寫 |
| `test_project_scanner.py` | depth=1 掃描、排除隱藏、root 欄位、套 override |
| `test_projects.py` | /api/projects；tree endpoint（containment/kms_root deny/400/403/denied|missing|not_dir 200） |
| `test_dir_tree.py` | `list_dir_entries`（dotfiles 排除/資料夾在前+名稱排序/空目錄/path 欄位） |
| `test_paths.py` | containment helper（等於 root/子路徑/prefix 偽命中/root 外/trailing sep）＋既有 path 正規化 |
| `test_config_routes.py` | config 寫入 endpoints（鎖/驗證/防呆/持久化） |
| `test_pty_bridge.py` | PTY round-trip、env override、env_remove 剔除、並發 |
| `test_sessions.py` | session 建立 + WS echo + resize + 模式 A + flow control（`_apply_flow_control` 單測 + pause 真閘住 PTY→WS/roundtrip/text 不入 PTY/壞 frame 不斷線/paused EOF→4001）+ kind=install/login（allowlist 命令/未知 install_id 400/不注入帳號 env/login 注入帳號 env/codex login/未知帳號 400/未知欄位 422） |
| `test_usage_pricing.py` | 定價正規化（別名/後綴/synthetic/尺寸帶）＋兩源計價公式 |
| `test_usage_parser.py` | 兩格式解析（容錯/cache precedence/差分 clamp/壞 ts/中文 cwd/rate_limits 末筆） |
| `test_usage_scanner.py` | realpath 去重（symlink 帳號）＋codex canonical 三層 tier＋fallback |
| `test_codex_usage.py` | Codex 實時額度（normalize_usage 欄位映射/缺鍵→bad_response、fetch no_auth/401→unauthorized/URLError→network/壞 JSON；opener 注入不打真網路、token 進 header） |
| `test_usage_cache.py` | L1 命中/L2 roundtrip/損壞重建/pricing 重算/generation 防舊蓋新/並發序列化/ghost |
| `test_usage_aggregator.py` | dedup 替換規則/KPI 視窗/分源命中率/horizon/synthetic 濾除/壞訂閱防衛 |
| `test_usage_routes.py` | dashboard route（冷掃 202→ok/days 收斂/last-good/穩態 ok/error 語義/訂閱 PUT 驗證） |
| `test_usage_perf.py` | 效能煙囪（slow marker）：200k 條冷掃/增量/單檔變動/build_dashboard 計時 |
| `test_memory_parser.py` | frontmatter/wikilink（含 alias 取 target）/title fallback/malformed no-raise/missing→None |
| `test_memory_scanner.py` | native 三態（matched/orphan/ambiguous 碰撞）/跳 MEMORY.md/KMS containment + 逃逸 symlink 擋下/None root |
| `test_memory_links.py` | 無向去重+持久化/0600/dismiss 綁 pair/suggest 名稱包含+短名只手動/`_norm`/20 執行緒並寫不失 |
| `test_memory_aggregator.py` | scope mapping/global·projects·kb 分組/orphan·ambiguous 可見/已連 topic 掛 project/overview 不含 body/body 命中回 snippet |
| `test_memory_config.py` | kms_root round-trip（raw 含 ~）/清空 |
| `test_memory_routes.py` | overview shape/links CRUD+dismiss/item 擋 traversal（403） |
| `test_install_specs.py` | 資料表覆蓋 core 工具/欄位齊全/`get_spec`/`get_install_command` allowlist（未知 id、僅手動→None） |
| `test_env_detect.py` | 偵測純函式（裝了探版本/沒裝跳過/探測失敗與 timeout 容忍/`detect_all` 一 spec 一 status） |
| `test_setup_routes.py` | `/api/setup/status`（monkeypatch detect_all 注入假資料、回傳 shape）＋共通設置兩端點（plan 預覽不動 FS／apply 建連結／overwrite 閘與 pair 授權隔離／`_setup_lock` 並發序列化／400 判別碼／未知欄位與 client 夾帶 plan → 422／config 壞掉與探測 `OSError` 回判別碼不裸 500） |
| `test_common_config.py` | allowlist／graph 防呆（target≡source、雙向祖先—子孫 overlap、target 彼此巢狀、home 祖先與根、平行 sibling 不誤擋）／十一態探測（含 source 型別前置、逃逸連結不判 ok）／`_action_for` 涵蓋全部十一態／apply 各分支／備份不覆蓋既有備份／TOCTOU stale／target dir 掉包與每 op 重驗／relink 不誤刪實體檔且不覆蓋競態新檔／per-account 授權隔離／symlink 不寫穿且原連結入備份／短寫寫滿 |

### build / 環境
| 檔案 | 用途 |
|------|------|
| `sidecar/build_binary.sh` | PyInstaller 打包 sidecar 成 onedir 資料夾 + nested ad-hoc 簽章，rsync 到 `binaries/` |
| `scripts/build-app-devtools.sh` | 偵錯打包：sidecar + `tauri build --features devtools`（帶 Web Inspector，啟動自動開）；給「只有打包版重現、dev 正常」的 bug 蒐證用。`npm run build:app:devtools`。正式 build 不帶 feature、不外洩 devtools |
| `sidecar/pyproject.toml` | Python 依賴與測試設定 |
| `vitest.config.ts` | 前端 vitest 設定（store lifecycle 測試） |

### docs/agents/ — Agent skills 設定（mattpocock engineering skills 讀取）
| 檔案 | 用途 |
|------|------|
| `issue-tracker.md` | Issue 追蹤方式：local markdown（`.scratch/<feature-slug>/`，已 gitignore），一張 ticket 一個檔、`Status:` 行記 triage 狀態 |
| `triage-labels.md` | 五個 triage label 對應表（沿用預設字串） |
| `domain.md` | Domain 文件讀取規則：single-context（根目錄 `CONTEXT.md` + `docs/adr/`，由 skills 惰性建立） |

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
| `store/useAppStore.ts`（Tab 模型變更） | `src/App.tsx`（共用 isLiveClaudeTab predicate）、`src/components/TabBar.tsx`、`src/components/Terminal.tsx` |
| `sidecar/.../usage/pricing.py`（定價表/正規化變更） | **儀表板所有成本數字**；改表必升 `PRICING_VERSION`（L2 自動重算）；`test_usage_pricing.py` |
| `sidecar/.../usage/parser.py`（UsageEntry 欄位變更） | `usage/cache.py`（L2 序列化 roundtrip——欄位變更需升 `SCHEMA_VERSION`）、`usage/aggregator.py` |
| `sidecar/.../routes/usage.py`（payload shape 變更） | `src/lib/sidecar.ts`（`UsageDashboard`/`CodexUsage` 型別）、`src/components/Dashboard.tsx`、`test_usage_routes.py` |
| `sidecar/.../api/codex_usage.py`（端點/回傳合約變更） | `routes/usage.py`（`/usage/codex`）、`src/lib/sidecar.ts`（`CodexUsage`）、`Dashboard.tsx`（`CodexPanel`）、`test_codex_usage.py` |
| `sidecar/.../usage/account_activity.py`（事件格式/歸屬規則變更） | `routes/sessions.py`（寫 open/close）、`pty_bridge.py`（live_ids/on_close 契約）、`test_account_activity.py` |
| `app_config.subscriptions`（結構變更） | `routes/config.py` PUT 驗證、`src/lib/subscriptionsForm.ts`、`Settings.tsx`、KPI Net ROI |
| `src/locales/*/dashboard.json`（key 增刪） | 另一語言 catalog 同步（`i18nCatalog.test.ts` parity 會擋）、`Dashboard.tsx`/`Settings.tsx`/`Sidebar.tsx`/`TabBar.tsx` 的 t() 引用 |
| `sidecar/.../memory/aggregator.py`（payload shape 變更） | `src/lib/sidecar.ts`（`MemoryOverview`/`MemoryItem` 型別）、`Memory.tsx`/`RelatedFloat.tsx`、`test_memory_aggregator.py` |
| `sidecar/.../memory/scanner.py`（`is_kms_file_allowed`/掃描範圍變更） | `routes/memory.py`（`/item` containment 共用同一 allowlist）、`test_memory_scanner.py`、`test_memory_routes.py` |
| `sidecar/.../routes/memory.py`（endpoint/payload 變更） | `src/lib/sidecar.ts` memory fetchers、`Memory.tsx`+左右欄元件（`MemoryIndex`/`MemoryGroup`/`MemoryRow`/`MemoryDetail`/`SuggestionChip`）/`RelatedFloat.tsx`、`test_memory_routes.py` |
| `src/lib/memoryView.ts`（VM/facet/selection 邏輯變更） | `Memory.tsx`、`MemoryIndex`/`MemoryGroup`、`memoryView.test.ts` |
| `src/locales/*/memory.json`（key 增刪） | 另一語言 catalog 同步（`memory-parity.test.ts` 會擋）、`Memory.tsx`+記憶元件群/`RelatedFloat.tsx`/`Sidebar.tsx`/`TabBar.tsx`/`Settings.tsx` 的 t() 引用 |
| `sidecar/.../dir_tree.py`（列目錄邏輯變更） | `routes/projects.py`、`test_dir_tree.py` |
| `sidecar/.../paths.py`（containment helper 變更） | `routes/projects.py`、`test_paths.py` |
| `sidecar/.../routes/projects.py`（tree endpoint 變更） | `src/lib/sidecar.ts`、`Sidebar.tsx`/`FileTree*.tsx`、`test_projects.py` |
| `sidecar/.../routes/setup.py`／`setup/*.py`（偵測 payload/資料表／共通設置合約變更） | `src/lib/sidecar.ts`（B-4 加 fetcher 後）、`test_setup_routes.py`、`test_env_detect.py`、`test_install_specs.py`、`test_common_config.py` |
| `src/lib/tabOrder.ts`（排序/插入邏輯變更） | `store/useAppStore.ts`、`tabOrder.test.ts` |
| `src/lib/terminalRegistry.ts`（handle contract 變更） | `Terminal.tsx`、`App.tsx`（onDragEnd 貼路徑） |
| `src/locales/*/sidebar.json`（key 增刪） | 另一語言 catalog 同步（`sidebar-parity.test.ts` 會擋）、`Sidebar.tsx`/`TabBar.tsx`/`FileTree*.tsx`/`Terminal.tsx` 的 t() 引用 |

---

## 環境變數清單

| 變數名 | 用途 | 預設值 | 必填 |
|--------|------|--------|------|
| `CLAUDE_CONFIG_DIR` | 傳給 `claude` subprocess 切換帳號（工作/私人） | `~/.claude` | 由 sidecar 動態設 |
| `FLEDGE_CONFIG_PATH` | 覆蓋設定檔路徑（測試用） | `~/.fledge/config.json` | ❌ |
| `FLEDGE_TEST_COMMAND` | 測試模式替代 `claude` 的命令（如 `cat`） | 無（正常跑 claude） | ❌（僅測試） |
| `FLEDGE_TOKEN` | sidecar 認證 token（HTTP `X-Fledge-Token` / WS `?token=`） | 無 | 由 Tauri 殼 per-launch 生成注入（prod 必有；不灌進 claude 子進程） |
| `FLEDGE_TEST_UNAUTH` | 設 `1` 關閉認證（測試/手動執行 opt-out；conftest autouse 預設設此） | 無 | ❌（僅測試/手動） |
| `FLEDGE_CODEX_HOME` | 覆蓋 codex 資料根（觀測掃描；測試用） | `~/.codex` | ❌ |
| `FLEDGE_USAGE_CACHE` | 覆蓋觀測 L2 快取路徑（測試用） | `~/.fledge/cache/usage-v1.json` | ❌ |
| `FLEDGE_MEMORY_LINKS` | 覆蓋記憶層連結存儲路徑（測試用） | `~/.fledge/memory-links.json` | ❌ |

---

## 備註

- 本文件由開發者維護，Claude Code 在結構變更時應提醒更新
- 影響鏈僅為提醒，不代表一定要修改右側檔案
- 韌性、path 正規化、sidecar 認證 token + CORS 收緊、桌面打包（onedir sidecar + curl/dmg 安裝，macOS arm64）均已完成。
- 記憶層（跨專案連結層）：唯讀聚合 native memory + Obsidian KMS，唯一寫入 `memory-links.json`；後端 `memory/`（parser→scanner→links→aggregator→routes/memory），前端 memory 分頁 + 終端機右下懸浮。對來源永遠唯讀，`/memory/item` 以 realpath containment 守邊界。

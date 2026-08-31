import { create } from "zustand";
import { nextBackendState, type BackendStatus } from "../lib/backendStatus";
import { isLiveClaudeTab } from "../lib/liveTab";
import { reorderTabs, insertTabAdjacent } from "../lib/tabOrder";
import {
  Project,
  AppConfigData,
  SubscriptionItem,
  createSession,
  closeSession,
  fetchProjects,
  fetchConfig,
  addRoot,
  removeRoot,
  setRootAccount,
  addManualProject,
  removeManualProject,
  setProjectOverride,
  clearProjectOverride,
  onboard,
  addAccount,
  setAccountConfigDir,
  setAccountLabel,
  removeAccount,
  putSubscriptions,
  waitForSidecarPort,
  waitForSidecarToken,
  setAuthToken,
  fetchHealth,
  restartSidecar,
} from "../lib/sidecar";

// loadProjects 的 request-id：只套用最新一次 loadProjects 的結果，
// 防並發 config 寫入各自觸發的 loadProjects 互相蓋成 stale（Codex review）。
let loadProjectsSeq = 0;

// 啟動序列的去重閘（design §4.1.2）。module scope 而非 store 欄位——它是「有沒有一次執行
// 正在進行」的執行期事實，不是 UI 要訂閱的狀態。
//
// StrictMode 下 effect 會跑兩次，沒有它第二次呼叫會把已 ready 的狀態打回 running、splash 閃
// 第二次。回傳「同一個 promise 物件」而非 null，兩個呼叫端才會拿到相同答案、firstRun 不會漏。
let bootstrapInFlight: Promise<BootstrapResult | null> | null = null;

export interface BootstrapResult {
  firstRun: boolean;
  /** loadProjects 的非致命失敗原文；由 App 承接顯示，不進 store（design §4.1.4）。 */
  projectsError: string | null;
}

export type StartupPhase = "running" | "ready" | "failed";

export interface Tab {
  id: string; // 前端產生的 tab id（非 sessionId）
  projectPath: string;
  account: string;
  title: string;
  sessionId: string | null; // null = 建立中
  status: "creating" | "ready" | "error" | "offline" | "ended";
  kind: "claude" | "terminal" | "dashboard" | "memory" | "tasks"; // 分頁種類：claude session、純終端機 shell、觀測儀表板、記憶面板或待辦面板
  error?: string;
  activity?: "working" | "idle"; // 就緒後忙碌態（best-effort，只在 status==="ready" 有意義）
}

interface AppState {
  port: number | null;
  projects: Project[];
  tabs: Tab[];
  activeTabId: string | null;
  config: AppConfigData | null;
  backendStatus: BackendStatus;
  backendOkStreak: number;
  startup: StartupPhase;
  /** 啟動失敗的技術原文（英文）；只餵 Splash 的「詳細資訊」與 console，不進文案插值。 */
  startupError: string | null;
  bootstrap: (opts?: { restart?: boolean }) => Promise<BootstrapResult | null>;
  permissionError: boolean;
  claudeFound: boolean;
  pendingCloseTabId: string | null;
  modalOpen: boolean; // 任一 modal（Settings/Picker/Onboarding/關閉確認框）開啟＝true；拖檔 drop gate 用
  setModalOpen: (open: boolean) => void;
  setClaudeFound: (found: boolean) => void;
  setPort: (port: number) => void;
  loadProjects: () => Promise<void>;
  openTab: (project: Project, accountOverride?: string, kind?: "claude" | "terminal", forceNew?: boolean) => Promise<void>;
  openDashboard: () => void;
  openMemory: () => void;
  openTasks: () => void;
  closeTab: (tabId: string) => Promise<void>;
  requestCloseTab: (tabId: string) => void;
  setPendingCloseTab: (tabId: string | null) => void;
  recordHealth: (ok: boolean) => void;
  setBackendStatus: (status: BackendStatus) => void;
  setActive: (tabId: string) => void;
  reorderTabs: (activeId: string, overId: string) => void;
  setTabStatus: (tabId: string, status: Tab["status"]) => void;
  setTabActivity: (tabId: string, activity: "working" | "idle" | undefined) => void;
  restartTab: (tabId: string) => Promise<void>;
  markAllTabsEnded: () => void;
  loadConfig: () => Promise<void>;
  addRoot: (path: string, account: string) => Promise<void>;
  removeRoot: (path: string) => Promise<void>;
  setRootAccount: (path: string, account: string) => Promise<void>;
  addManual: (path: string, account: string) => Promise<void>;
  removeManual: (path: string) => Promise<void>;
  setProjectAccount: (path: string, account: string) => Promise<void>;
  clearProjectAccount: (path: string) => Promise<void>;
  completeOnboarding: (roots: { path: string; default_account: string }[]) => Promise<void>;
  addAccount: (key: string, configDir: string, label: string) => Promise<void>;
  setAccountConfigDir: (key: string, configDir: string) => Promise<void>;
  setAccountLabel: (key: string, label: string) => Promise<void>;
  removeAccount: (key: string, reassignTo?: string) => Promise<void>;
  saveSubscriptions: (subs: SubscriptionItem[]) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  port: null,
  projects: [],
  tabs: [],
  activeTabId: null,
  config: null,
  backendStatus: "up",
  backendOkStreak: 0,
  permissionError: false,
  claudeFound: true,
  pendingCloseTabId: null,
  modalOpen: false,
  // 初始即 running（不設 idle）：app 一掛載就在跑序列，多一個 idle 只會讓 Splash 有一幀
  // 渲染在「什麼都還沒開始」的狀態。
  startup: "running",
  startupError: null,

  // 啟動序列：取 port → token → health → config →（首次跳過／否則載專案）。design §4.1。
  //
  // ⚠ 刻意不是 async 函式：async 的 `return bootstrapInFlight` 會產生一個「採納」該結果的新
  // promise，identity 不再相等，去重就失效了。
  bootstrap: (opts) => {
    if (bootstrapInFlight) return bootstrapInFlight;

    const run = async (): Promise<BootstrapResult | null> => {
      try {
        // ⚠ 狀態必須在 restart 之前就切走：restartSidecar 在 Rust 端同步等新 port、最長 30s，
        // 若等它回來才設 running，這段期間 startup 仍是 failed，Splash 會一直顯示「可按的重試」
        // 而不是 disabled 的「重試中…」——使用者無從判斷操作有沒有被受理，還會連點。
        // ⚠ 狀態必須在 restart 之前就切走：restartSidecar 在 Rust 端同步等新 port、最長 30s，
        // 若等它回來才設 running，這段期間 startup 仍是 failed，Splash 會一直顯示「可按的重試」
        // 而不是 disabled 的「重試中…」——使用者無從判斷操作有沒有被受理，還會連點。
        set({ startup: "running", startupError: null });
        // 重試才 restart：先 kill 殘屍再重 spawn，失敗會立即回 Err（不空等 30s）
        if (opts?.restart) await restartSidecar();

        const port = await waitForSidecarPort();
        const token = await waitForSidecarToken();
        setAuthToken(token);
        const health = await fetchHealth(port);
        set({ claudeFound: health.claude_found });
        // 最後才設 port → 觸發 5s health poll 的 effect 時 token 必已 set
        set({ port });
        await get().loadConfig();

        const firstRun = get().config?.is_first_run === true;
        let projectsError: string | null = null;
        if (!firstRun) {
          // 專案掃描失敗不致命：config 已載入，設定頁與加根目錄都還走得通。
          // 升級成滿版阻斷會比現況更糟，所以在這裡局部攔下、由回傳值帶給 App 顯示 banner。
          try {
            await get().loadProjects();
          } catch (e) {
            console.error("loadProjects 失敗（不阻斷啟動）", e);
            projectsError = String(e);
          }
        }
        set({ startup: "ready" });
        return { firstRun, projectsError };
      } catch (e) {
        console.error("啟動序列失敗", e);
        set({ startup: "failed", startupError: String(e) });
        return null;
      }
    };

    // 存的是 .finally() 之後的 promise，identity 才與呼叫端拿到的一致；
    // 且只在 identity 相符時清除——否則會清掉別人的那一輪，或讓下一次重試撿到舊結果。
    let p: Promise<BootstrapResult | null>;
    p = run().finally(() => {
      if (bootstrapInFlight === p) bootstrapInFlight = null;
    });
    bootstrapInFlight = p;
    return p;
  },

  setPort: (port) => set({ port }),

  loadProjects: async () => {
    const port = get().port;
    if (port == null) return;
    const seq = ++loadProjectsSeq;
    const { projects, permissionError } = await fetchProjects(port);
    if (seq === loadProjectsSeq) set({ projects, permissionError }); // 只套用最新一次（防並發 stale）
  },

  openTab: async (project, accountOverride, kind = "claude", forceNew = false) => {
    const { port, tabs } = get();
    if (port == null) return;
    const account = accountOverride ?? project.account;
    // claude 去重（同專案同帳號聚焦既有）；terminal 不去重、每次都開新分頁（spec §1.3/1.4）。
    // forceNew（右鍵「開新 claude 視窗」/重啟）跳過去重，強制建新分頁與新 session。
    if (kind === "claude" && !forceNew) {
      const existing = tabs.find(
        (t) => t.kind === "claude" && t.projectPath === project.path && t.account === account,
      );
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }
    }
    const id = crypto.randomUUID();
    const tab: Tab = {
      id,
      projectPath: project.path,
      account,
      title: project.name,
      sessionId: null,
      status: "creating",
      kind,
    };
    // terminal 分頁插到同專案分頁群尾端（需求 2）；其餘（claude）維持末端
    set((s) => ({
      tabs: kind === "terminal" ? insertTabAdjacent(s.tabs, tab) : [...s.tabs, tab],
      activeTabId: id,
    }));
    try {
      const sessionId = await createSession(port, { path: project.path, account, kind });
      // 若 tab 在建立期間已被關閉，補清這個剛建好的 session（防 orphan，審查 round 1 HIGH）
      if (!get().tabs.some((t) => t.id === id)) {
        await closeSession(port, sessionId);
        return;
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, sessionId, status: "ready" } : t,
        ),
      }));
    } catch (e) {
      // tab 還在才標 error（已關閉就無需處理）
      if (get().tabs.some((t) => t.id === id)) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id ? { ...t, status: "error", error: String(e) } : t,
          ),
        }));
      }
    }
  },

  openDashboard: () => {
    // 單例：已開啟則 focus（與 claude tab 同專案去重同精神）
    const existing = get().tabs.find((t) => t.kind === "dashboard");
    if (existing) { set({ activeTabId: existing.id }); return; }
    const id = `dash-${Date.now()}`;
    set((s) => ({
      tabs: [...s.tabs, { id, projectPath: "", account: "", title: "", sessionId: null,
                          status: "ready", kind: "dashboard" } as Tab],
      activeTabId: id,
    }));
  },

  openMemory: () => {
    // 單例：已開啟則 focus（鏡像 openDashboard，純前端 tab、無 session）
    const existing = get().tabs.find((t) => t.kind === "memory");
    if (existing) { set({ activeTabId: existing.id }); return; }
    const id = `mem-${Date.now()}`;
    set((s) => ({
      tabs: [...s.tabs, { id, projectPath: "", account: "", title: "", sessionId: null,
                          status: "ready", kind: "memory" } as Tab],
      activeTabId: id,
    }));
  },

  openTasks: () => {
    // 單例：已開啟則 focus（鏡像 openMemory，純前端 tab、無 session）
    const existing = get().tabs.find((t) => t.kind === "tasks");
    if (existing) { set({ activeTabId: existing.id }); return; }
    const id = `tasks-${Date.now()}`;
    set((s) => ({
      tabs: [...s.tabs, { id, projectPath: "", account: "", title: "", sessionId: null,
                          status: "ready", kind: "tasks" } as Tab],
      activeTabId: id,
    }));
  },

  loadConfig: async () => {
    const port = get().port;
    if (port == null) return;
    set({ config: await fetchConfig(port) });
  },
  addRoot: async (path, account) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await addRoot(port, path, account) });
    await get().loadProjects();
  },
  removeRoot: async (path) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await removeRoot(port, path) });
    await get().loadProjects();
  },
  setRootAccount: async (path, account) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await setRootAccount(port, path, account) });
    await get().loadProjects();
  },
  addManual: async (path, account) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await addManualProject(port, path, account) });
    await get().loadProjects();
  },
  removeManual: async (path) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await removeManualProject(port, path) });
    await get().loadProjects();
  },
  setProjectAccount: async (path, account) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await setProjectOverride(port, path, account) });
    await get().loadProjects();
  },
  clearProjectAccount: async (path) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await clearProjectOverride(port, path) });
    await get().loadProjects();
  },
  completeOnboarding: async (roots) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await onboard(port, roots) });
    await get().loadProjects();
  },
  addAccount: async (key, configDir, label) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await addAccount(port, key, configDir, label) });
    await get().loadProjects();
  },
  setAccountConfigDir: async (key, configDir) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await setAccountConfigDir(port, key, configDir) });
    await get().loadProjects(); // config_dir 影響 recent 掃描
  },
  setAccountLabel: async (key, label) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await setAccountLabel(port, key, label) });
    // label 純顯示、不影響掃描，不需 loadProjects
  },
  removeAccount: async (key, reassignTo) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await removeAccount(port, key, reassignTo) });
    await get().loadProjects(); // 級聯 reassign 改了 account 分組
  },
  saveSubscriptions: async (subs) => {
    const port = get().port;
    if (port == null) return;
    set({ config: await putSubscriptions(port, subs) });
  },

  closeTab: async (tabId) => {
    const { port, tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // 先移 tab（UI 即時）；active 落到最後一個剩下的 tab
    const remaining = tabs.filter((t) => t.id !== tabId);
    const newActive =
      activeTabId === tabId
        ? (remaining[remaining.length - 1]?.id ?? null)
        : activeTabId;
    // 先移 tab（UI 即時）；兩類 tab 均需此 set，故提前執行後再依種類決定後續
    set({ tabs: remaining, activeTabId: newActive });
    if (tab.kind === "dashboard" || tab.kind === "memory" || tab.kind === "tasks") {
      // 純前端 tab：不打 closeSession，移除後直接結束
      return;
    }
    // async 關 session（claude 子進程）；creating 中的 tab 由 openTab resolve 後補清
    if (port != null && tab.sessionId) {
      await closeSession(port, tab.sessionId);
    }
  },

  // 關閉守門：只要分頁是「作用中的 session」(status==="ready" && sessionId) 就攔下、跳確認框。這涵蓋
  // AI 處理中 / 回覆完成 / 等待選擇(權限提示) / 等待輸入——這些都是 ready 子狀態，誤關任一都會殺掉 claude
  // 子進程、丟掉當前進度，故一律先確認。offline(ws 斷線重連中) / ended / 無 session → 直接關，不確認
  // （使用者裁示 offline 不需擋；誤關仍可 /resume 救對話）。
  // 為何不只擋「AI 處理中」：activity 只有 working/idle（餵自 PTY 輸出量），回覆完成/等待選擇/等待輸入
  // 在它眼中都是 idle、分不出來；要分得解析 claude TUI 畫面＝脆弱且違背套殼架構，故改成「ready 一律確認」。
  requestCloseTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (tab && isLiveClaudeTab(tab)) {
      set({ pendingCloseTabId: tabId });
    } else {
      get().closeTab(tabId);
    }
  },
  setPendingCloseTab: (tabId) => set({ pendingCloseTabId: tabId }),
  setModalOpen: (open) => set({ modalOpen: open }),

  recordHealth: (ok) =>
    set((s) => {
      const next = nextBackendState({ status: s.backendStatus, okStreak: s.backendOkStreak }, ok);
      return { backendStatus: next.status, backendOkStreak: next.okStreak };
    }),
  setBackendStatus: (status) => set({ backendStatus: status, backendOkStreak: 0 }),

  setClaudeFound: (found) => set({ claudeFound: found }),
  setActive: (tabId) => set({ activeTabId: tabId }),
  reorderTabs: (activeId, overId) =>
    set((s) => ({ tabs: reorderTabs(s.tabs, activeId, overId) })),

  // 找不到 tab 就原樣回傳（不是 `tabs` 沒變、而是連新陣列都不建）：精靈的安裝終端機走合成
  // tabId、store 內沒有對應 tab，仍會照常回報狀態與活動——照樣 set 會讓 select `s.tabs` 的
  // TabBar／Workspace 每次都白重繪一輪。
  setTabStatus: (tabId, status) =>
    set((s) => (s.tabs.some((t) => t.id === tabId)
      ? { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, status } : t)) }
      : s)),

  setTabActivity: (tabId, activity) =>
    set((s) => (s.tabs.some((t) => t.id === tabId)
      ? { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activity } : t)) }
      : s)),

  // ended 的 tab 按「重啟」：關舊 tab + 用同專案同帳號開新 session
  restartTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.kind === "dashboard" || tab.kind === "memory" || tab.kind === "tasks") return; // 純前端 tab，無 session 無法重啟
    const project = get().projects.find((p) => p.path === tab.projectPath);
    if (!project) return; // 專案已不在清單（root/manual 被移除）→ 不動，避免無聲銷毀 ended tab
    await get().closeTab(tabId);
    // forceNew=true：允許同專案多 claude 視窗後，重啟須建自己的新 session，
    // 否則去重會誤聚焦到同專案兄弟分頁而非重開本分頁。
    await get().openTab(project, tab.account, tab.kind, true);
  },

  // sidecar 重啟：舊 session 全沒了，所有 tab 標 ended、清 sessionId（前端原子轉移用）。
  // dashboard／memory／tasks tab 純前端、無 session，不標 ended（否則會出現重啟按鈕、但純前端 tab 無法重啟）。
  markAllTabsEnded: () =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.kind === "dashboard" || t.kind === "memory" || t.kind === "tasks" ? t : { ...t, status: "ended" as const, sessionId: null },
      ),
    })),
}));

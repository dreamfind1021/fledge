import { describe, it, expect, vi, beforeEach } from "vitest";
import * as sidecar from "../lib/sidecar";
import { useAppStore } from "./useAppStore";

vi.mock("../lib/sidecar");

const proj = (path: string): sidecar.Project => ({
  name: path.split("/").pop()!,
  path,
  account: "work",
  source: "root",
  root: "/Users/tc/NAS/work",
  recent: null,
});

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState({ port: 1234, projects: [], tabs: [], activeTabId: null, config: null, pendingCloseTabId: null });
    vi.clearAllMocks();
  });

  it("openTab 同一專案第二次改為切換、不重複開", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValue("sess-1");
    await useAppStore.getState().openTab(proj("/p/a"));
    const firstId = useAppStore.getState().tabs[0].id;
    await useAppStore.getState().openTab(proj("/p/a"));
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().activeTabId).toBe(firstId);
    expect(sidecar.createSession).toHaveBeenCalledTimes(1);
  });

  it("close creating tab 後，session 建好仍會被補清（防 orphan）", async () => {
    let resolveCreate!: (s: string) => void;
    vi.mocked(sidecar.createSession).mockReturnValue(
      new Promise<string>((r) => {
        resolveCreate = r;
      }),
    );
    vi.mocked(sidecar.closeSession).mockResolvedValue();
    const opening = useAppStore.getState().openTab(proj("/p/b"));
    const id = useAppStore.getState().tabs[0].id;
    // 在 createSession resolve 前關 tab
    await useAppStore.getState().closeTab(id);
    resolveCreate("sess-orphan");
    await opening;
    expect(sidecar.closeSession).toHaveBeenCalledWith(1234, "sess-orphan");
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });

  it("closeTab active 後 active 落到剩下的最後一個", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValueOnce("s1").mockResolvedValueOnce("s2");
    vi.mocked(sidecar.closeSession).mockResolvedValue();
    await useAppStore.getState().openTab(proj("/p/1"));
    await useAppStore.getState().openTab(proj("/p/2"));
    const [t1, t2] = useAppStore.getState().tabs;
    useAppStore.getState().setActive(t2.id);
    await useAppStore.getState().closeTab(t2.id);
    expect(useAppStore.getState().activeTabId).toBe(t1.id);
  });

  it("requestCloseTab：ready+sessionId（處理中 working）攔下跳確認框、不關 tab", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValue("s-busy");
    vi.mocked(sidecar.closeSession).mockResolvedValue();
    await useAppStore.getState().openTab(proj("/p/busy"));
    const id = useAppStore.getState().tabs[0].id;
    useAppStore.getState().setTabActivity(id, "working");
    useAppStore.getState().requestCloseTab(id);
    expect(useAppStore.getState().pendingCloseTabId).toBe(id);
    expect(useAppStore.getState().tabs).toHaveLength(1); // 沒被關
    expect(sidecar.closeSession).not.toHaveBeenCalled();
  });

  it("requestCloseTab：ready+sessionId（回覆完成／等待選擇／等待輸入＝idle）也攔下——ready 一律確認", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValue("s-idle");
    vi.mocked(sidecar.closeSession).mockResolvedValue();
    await useAppStore.getState().openTab(proj("/p/idle"));
    const id = useAppStore.getState().tabs[0].id;
    useAppStore.getState().setTabActivity(id, "idle"); // idle 仍是 ready 子狀態 → 仍攔
    useAppStore.getState().requestCloseTab(id);
    expect(useAppStore.getState().pendingCloseTabId).toBe(id);
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(sidecar.closeSession).not.toHaveBeenCalled();
  });

  it("requestCloseTab：offline（斷線重連中）直接關、不跳框（使用者裁示 offline 不需確認）", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValue("s-off");
    vi.mocked(sidecar.closeSession).mockResolvedValue();
    await useAppStore.getState().openTab(proj("/p/off"));
    const id = useAppStore.getState().tabs[0].id;
    useAppStore.getState().setTabStatus(id, "offline"); // 非 ready → 直接關
    useAppStore.getState().requestCloseTab(id);
    expect(useAppStore.getState().pendingCloseTabId).toBeNull();
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });

  it("requestCloseTab：非 live（ended／無 session）直接關、不跳框", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValue("s-x");
    vi.mocked(sidecar.closeSession).mockResolvedValue();
    await useAppStore.getState().openTab(proj("/p/x"));
    const id = useAppStore.getState().tabs[0].id;
    useAppStore.getState().markAllTabsEnded(); // status=ended、sessionId=null → 非 ready
    useAppStore.getState().requestCloseTab(id);
    expect(useAppStore.getState().pendingCloseTabId).toBeNull();
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });

  it("openTab 帶 accountOverride 用指定帳號（臨時、不寫 config）", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValue("sess-ov");
    await useAppStore.getState().openTab(proj("/p/x"), "personal");
    expect(sidecar.createSession).toHaveBeenCalledWith(1234, { path: "/p/x", account: "personal", kind: "claude" });
    expect(useAppStore.getState().tabs[0].account).toBe("personal");
    expect(sidecar.setProjectOverride).not.toHaveBeenCalled();
  });

  it("同專案不同帳號開兩個 tab（(path,account) 比對）", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValueOnce("s-work").mockResolvedValueOnce("s-personal");
    await useAppStore.getState().openTab(proj("/p/y")); // work（proj 預設）
    await useAppStore.getState().openTab(proj("/p/y"), "personal");
    expect(useAppStore.getState().tabs).toHaveLength(2);
    expect(sidecar.createSession).toHaveBeenCalledTimes(2);
  });

  it("setProjectAccount 寫 override 後重新 loadProjects", async () => {
    const cfg = {
      version: 1, roots: [], accounts: {}, manual_projects: [],
      project_overrides: { "/p/z": { account: "personal" } }, ui: { theme: "dark" },
    };
    vi.mocked(sidecar.setProjectOverride).mockResolvedValue(cfg);
    vi.mocked(sidecar.fetchProjects).mockResolvedValue({ projects: [], permissionError: false });
    await useAppStore.getState().setProjectAccount("/p/z", "personal");
    expect(sidecar.setProjectOverride).toHaveBeenCalledWith(1234, "/p/z", "personal");
    expect(sidecar.fetchProjects).toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(cfg);
  });

  it("completeOnboarding 寫入後 set config 並 loadProjects", async () => {
    const cfg = {
      version: 1,
      roots: [{ path: "/r1", default_account: "work" }],
      accounts: {},
      manual_projects: [],
      project_overrides: {},
      ui: { theme: "dark" },
      is_first_run: false,
    };
    vi.mocked(sidecar.onboard).mockResolvedValue(cfg);
    vi.mocked(sidecar.fetchProjects).mockResolvedValue({ projects: [], permissionError: false });
    await useAppStore.getState().completeOnboarding([{ path: "/r1", default_account: "work" }]);
    expect(sidecar.onboard).toHaveBeenCalledWith(1234, [{ path: "/r1", default_account: "work" }]);
    expect(sidecar.fetchProjects).toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(cfg);
  });

  it("addAccount 寫入後 set config 並 loadProjects", async () => {
    const cfg = {
      version: 1, roots: [], accounts: { team: { config_dir: "~/.claude-team", label: "團隊" } },
      manual_projects: [], project_overrides: {}, ui: { theme: "dark" },
    };
    vi.mocked(sidecar.addAccount).mockResolvedValue(cfg);
    vi.mocked(sidecar.fetchProjects).mockResolvedValue({ projects: [], permissionError: false });
    await useAppStore.getState().addAccount("team", "~/.claude-team", "團隊");
    expect(sidecar.addAccount).toHaveBeenCalledWith(1234, "team", "~/.claude-team", "團隊");
    expect(useAppStore.getState().config).toEqual(cfg);
  });

  it("openTab kind=terminal 不去重：同專案開兩個 terminal 分頁", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValueOnce("term1").mockResolvedValueOnce("term2");
    await useAppStore.getState().openTab(proj("/p/t"), undefined, "terminal");
    await useAppStore.getState().openTab(proj("/p/t"), undefined, "terminal");
    expect(useAppStore.getState().tabs).toHaveLength(2);
    expect(useAppStore.getState().tabs.every((t) => t.kind === "terminal")).toBe(true);
    expect(sidecar.createSession).toHaveBeenLastCalledWith(1234, { path: "/p/t", account: "work", kind: "terminal" });
  });

  it("requestCloseTab：terminal 分頁直接關、不跳確認框（即使 ready+sessionId）", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValue("term-x");
    vi.mocked(sidecar.closeSession).mockResolvedValue();
    await useAppStore.getState().openTab(proj("/p/tt"), undefined, "terminal");
    const id = useAppStore.getState().tabs[0].id;
    expect(useAppStore.getState().tabs[0].status).toBe("ready");
    useAppStore.getState().requestCloseTab(id);
    expect(useAppStore.getState().pendingCloseTabId).toBeNull();
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });

  it("terminal 與 claude 並存：claude 仍去重、terminal 不影響", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValue("s");
    await useAppStore.getState().openTab(proj("/p/c"), undefined, "terminal"); // terminal
    await useAppStore.getState().openTab(proj("/p/c")); // claude
    await useAppStore.getState().openTab(proj("/p/c")); // claude 第二次→聚焦既有
    expect(useAppStore.getState().tabs.filter((t) => t.kind === "claude")).toHaveLength(1);
    expect(useAppStore.getState().tabs).toHaveLength(2);
  });

  it("openTab forceNew=true：同專案同帳號強制開第二個 claude 分頁、不聚焦既有", async () => {
    vi.mocked(sidecar.createSession).mockResolvedValueOnce("s1").mockResolvedValueOnce("s2");
    await useAppStore.getState().openTab(proj("/p/m"));
    await useAppStore.getState().openTab(proj("/p/m"), undefined, "claude", true);
    expect(useAppStore.getState().tabs.filter((t) => t.kind === "claude")).toHaveLength(2);
    expect(sidecar.createSession).toHaveBeenCalledTimes(2);
  });

  it("restartTab：存在同專案兄弟 claude 分頁時，重啟建新 session、不誤聚焦兄弟", async () => {
    vi.mocked(sidecar.createSession)
      .mockResolvedValueOnce("s1")
      .mockResolvedValueOnce("s2")
      .mockResolvedValueOnce("s3");
    vi.mocked(sidecar.closeSession).mockResolvedValue();
    await useAppStore.getState().openTab(proj("/p/r"));
    await useAppStore.getState().openTab(proj("/p/r"), undefined, "claude", true);
    const second = useAppStore.getState().tabs[1];
    // restartTab 需從 store.projects 找回 project
    useAppStore.setState({ projects: [proj("/p/r")] });
    await useAppStore.getState().restartTab(second.id);
    expect(useAppStore.getState().tabs.filter((t) => t.kind === "claude")).toHaveLength(2);
    expect(sidecar.createSession).toHaveBeenCalledTimes(3); // s1, s2, 重啟 s3
  });

  it("openDashboard 單例：第二次只 focus 不重開", () => {
    useAppStore.getState().openDashboard();
    useAppStore.getState().openDashboard();
    const tabs = useAppStore.getState().tabs.filter((t) => t.kind === "dashboard");
    expect(tabs).toHaveLength(1);
    expect(useAppStore.getState().activeTabId).toBe(tabs[0].id);
  });

  it("closeTab 對 dashboard tab 不打 closeSession", async () => {
    useAppStore.getState().openDashboard();
    const id = useAppStore.getState().tabs[0].id;
    await useAppStore.getState().closeTab(id);
    expect(sidecar.closeSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });

  it("openMemory 單例：重複呼叫只一個 memory tab", () => {
    const s = useAppStore.getState();
    s.openMemory(); s.openMemory();
    const mem = useAppStore.getState().tabs.filter((t) => t.kind === "memory");
    expect(mem.length).toBe(1);
  });

  it("removeAccount 帶 reassignTo 呼叫後重掃", async () => {
    const cfg = {
      version: 1, roots: [], accounts: { work: { config_dir: "~/.claude", label: "工作" } },
      manual_projects: [], project_overrides: {}, ui: { theme: "dark" },
    };
    vi.mocked(sidecar.removeAccount).mockResolvedValue(cfg);
    vi.mocked(sidecar.fetchProjects).mockResolvedValue({ projects: [], permissionError: false });
    await useAppStore.getState().removeAccount("personal", "work");
    expect(sidecar.removeAccount).toHaveBeenCalledWith(1234, "personal", "work");
    expect(sidecar.fetchProjects).toHaveBeenCalled();
  });

  it("recordHealth：fail→suspect→down、連 2 次成功回 up；setBackendStatus 直接設", () => {
    useAppStore.setState({ backendStatus: "up", backendOkStreak: 0 });
    useAppStore.getState().recordHealth(false);
    expect(useAppStore.getState().backendStatus).toBe("suspect");
    useAppStore.getState().recordHealth(false);
    expect(useAppStore.getState().backendStatus).toBe("down");
    useAppStore.getState().recordHealth(true);
    expect(useAppStore.getState().backendStatus).toBe("down"); // 第 1 次成功還不回
    expect(useAppStore.getState().backendOkStreak).toBe(1); // 成功計數累積
    useAppStore.getState().recordHealth(true);
    expect(useAppStore.getState().backendStatus).toBe("up"); // 第 2 次成功回 up
    useAppStore.getState().setBackendStatus("restarting");
    expect(useAppStore.getState().backendStatus).toBe("restarting");
    expect(useAppStore.getState().backendOkStreak).toBe(0); // setBackendStatus 歸零 streak
  });

  it("setTabActivity 更新指定 tab 的 activity（working/idle/undefined 重置）", () => {
    useAppStore.setState({
      tabs: [{ id: "t1", projectPath: "/p", account: "work", title: "p", sessionId: "s1", status: "ready", kind: "claude" }],
    });
    useAppStore.getState().setTabActivity("t1", "working");
    expect(useAppStore.getState().tabs[0].activity).toBe("working");
    useAppStore.getState().setTabActivity("t1", "idle");
    expect(useAppStore.getState().tabs[0].activity).toBe("idle");
    useAppStore.getState().setTabActivity("t1", undefined);
    expect(useAppStore.getState().tabs[0].activity).toBeUndefined();
  });

  it("setTabStatus 改某 tab 狀態；markAllTabsEnded 把所有 tab 標 ended、清 sessionId", () => {
    useAppStore.setState({
      tabs: [
        { id: "t1", projectPath: "/a", account: "work", title: "a", sessionId: "s1", status: "ready", kind: "claude" },
        { id: "t2", projectPath: "/b", account: "work", title: "b", sessionId: "s2", status: "ready", kind: "claude" },
      ],
    });
    useAppStore.getState().setTabStatus("t1", "offline");
    expect(useAppStore.getState().tabs.find((t) => t.id === "t1")!.status).toBe("offline");

    useAppStore.getState().markAllTabsEnded();
    for (const t of useAppStore.getState().tabs) {
      expect(t.status).toBe("ended");
      expect(t.sessionId).toBeNull();
    }
  });

  // 精靈的安裝終端機用合成 tabId（store 內沒有對應 tab），Terminal 仍會照常回報狀態與活動。
  // 若照樣 set 出一支新 tabs 陣列，select s.tabs 的 TabBar／Workspace 會被無意義地重繪一輪。
  it("setTabStatus／setTabActivity 打到不存在的 tabId：tabs 引用不變（不觸發訂閱者）", () => {
    const tabs = [
      { id: "t1", projectPath: "/a", account: "work", title: "a", sessionId: "s1", status: "ready" as const, kind: "claude" as const },
    ];
    useAppStore.setState({ tabs });

    useAppStore.getState().setTabStatus("ob-install-sess-9", "ended");
    useAppStore.getState().setTabActivity("ob-install-sess-9", "working");

    expect(useAppStore.getState().tabs).toBe(tabs);
  });
});

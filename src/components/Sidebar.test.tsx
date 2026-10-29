// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import i18n from "../i18n";
import enTasks from "../locales/en/tasks.json";
import enSidebar from "../locales/en/sidebar.json";
import * as sidecar from "../lib/sidecar";
import { useAppStore } from "../store/useAppStore";
import { Sidebar } from "./Sidebar";
import { Workspace } from "./Workspace";

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("../lib/dialog", () => ({ pickDirectory: vi.fn() }));
vi.mock("./Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchTasksOverview: () => Promise.resolve({ projects: [], permission_error: false }),
  createSession: vi.fn(),   // 右鍵「用 Pi 開啟」的測試會真的 openTab：不能打到真 fetch
}));

// 收合狀態由 localStorage 決定（Sidebar.tsx 的 collapsed 初值），故用它挑要 render 哪一套按鈕區
function renderSidebar(collapsed: boolean) {
  localStorage.setItem("fledge.sidebarCollapsed", collapsed ? "1" : "0");
  return render(
    <DndContext>
      <Sidebar onOpenPicker={() => {}} onOpenSettings={() => {}} />
      <Workspace />
    </DndContext>,
  );
}

// 接線測試（design §9.1）：Sidebar 有兩套獨立按鈕區——收合時的 rail（:239 附近）與展開時
// （:308 附近）。只接其中一套，另一套的使用者就沒有入口，而所有測試仍會全綠。
// 必須是「點按鈕」而非呼叫 store method——後者只證明 store 會去重，不證明按鈕存在。
describe("Sidebar 的待辦入口", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useAppStore.setState({ port: 1234, projects: [], tabs: [], activeTabId: null, config: null });
  });
  afterEach(cleanup);

  it("收合時的 rail 按鈕：點下去開出待辦面板", () => {
    renderSidebar(true);
    fireEvent.click(screen.getByLabelText(enTasks.entry));
    expect(useAppStore.getState().tabs.filter((t) => t.kind === "tasks")).toHaveLength(1);
    expect(screen.getByTestId("tasks-panel")).toBeTruthy();
  });

  it("展開時的按鈕：點下去開出待辦面板", () => {
    renderSidebar(false);
    fireEvent.click(screen.getByLabelText(enTasks.entry));
    expect(useAppStore.getState().tabs.filter((t) => t.kind === "tasks")).toHaveLength(1);
    expect(screen.getByTestId("tasks-panel")).toBeTruthy();
  });
});

// 入口接線（Pi spec §6.2 #18）：store 會去重不代表選單上有那一項——必須真的右鍵、真的點
describe("Sidebar 的「用 Pi 開啟」", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.mocked(sidecar.createSession).mockResolvedValue("pi-sess");
    useAppStore.setState({
      port: 1234, tabs: [], activeTabId: null,
      // recent 非 null：root 掃到且沒用過的專案會收進「自動發現」摺疊區、畫面上沒有這一列
      projects: [{ name: "fledge", path: "/w/fledge", account: "work", source: "root", root: "/w", recent: 1_700_000_000 }],
      config: { version: 1, roots: [{ path: "/w", default_account: "work" }],
                accounts: { work: { config_dir: "~/.claude", label: "工作" } },
                manual_projects: [], project_overrides: {}, ui: { theme: "dark" } },
    });
  });
  afterEach(cleanup);

  it("右鍵專案 → 用 Pi 開啟 → 開出 agent=pi、帶專案帳號的 AI 分頁", async () => {
    renderSidebar(false);
    fireEvent.contextMenu(screen.getByText("fledge"));
    const item = screen.queryByText(enSidebar.menu.openPiWindow);
    expect(item).not.toBeNull();                        // 選單上真的有這一項（不是只有 store 支援）
    fireEvent.click(item!);
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));
    const tab = useAppStore.getState().tabs[0];
    expect([tab.kind, tab.agent, tab.account, tab.projectPath]).toEqual(["claude", "pi", "work", "/w/fledge"]);
    expect(sidecar.createSession).toHaveBeenCalledWith(1234, { path: "/w/fledge", account: "work", kind: "claude", agent: "pi" });
  });
});

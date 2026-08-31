// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import i18n from "../i18n";
import enTasks from "../locales/en/tasks.json";
import { useAppStore } from "../store/useAppStore";
import { Sidebar } from "./Sidebar";
import { Workspace } from "./Workspace";

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("../lib/dialog", () => ({ pickDirectory: vi.fn() }));
vi.mock("./Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchTasksOverview: () => Promise.resolve({ projects: [], permission_error: false }),
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

// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { useAppStore } from "../store/useAppStore";
import { Workspace } from "./Workspace";

// xterm 進 jsdom 會炸（canvas/WebGL）；本檔只驗 kind 分派，終端機換成可辨識的替身
vi.mock("./Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchTasksOverview: () => Promise.resolve({ projects: [], permission_error: false }),
}));

// 接線測試（design §9.1）：Tasks.tsx 的 render 測試直接 render 元件、不經過 Workspace 的
// 分派點——漏掉 kind === "tasks" 那個分支時，tab 會掉進終端機的失敗分支而測試仍全綠。
describe("Workspace 的 kind 分派", () => {
  beforeEach(() => {
    useAppStore.setState({ port: 1234, projects: [], tabs: [], activeTabId: null, config: null });
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  it("kind: tasks 的 tab 渲染待辦面板，不是掉進終端機分支", () => {
    useAppStore.getState().openTasks();
    render(
      <DndContext>
        <Workspace />
      </DndContext>,
    );
    expect(screen.getByTestId("tasks-panel")).toBeTruthy();
    expect(screen.queryByTestId("terminal")).toBeNull();
  });
});

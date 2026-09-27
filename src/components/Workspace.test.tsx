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

  // spec S4：面板外圍的 4px 只拿掉左邊（側欄卡片到面板之間只留 .ws-main 的 5px 縫）。
  // 待辦、記憶、觀測共用這同一個分頁容器（Workspace.tsx 同一段 JSX），驗待辦分頁就涵蓋三種；
  // 終端機的外層是 left: 12 的絕對定位，不吃這層 padding
  it("面板分頁的容器左邊留白 0、其他三邊 4px", () => {
    useAppStore.getState().openTasks();
    render(
      <DndContext>
        <Workspace />
      </DndContext>,
    );
    const wrap = screen.getByTestId("tasks-panel").parentElement as HTMLElement;
    expect(wrap.style.paddingLeft).toBe("0px");
    expect([wrap.style.paddingTop, wrap.style.paddingRight, wrap.style.paddingBottom]).toEqual(["4px", "4px", "4px"]);
  });
});

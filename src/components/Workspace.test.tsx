// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import i18n from "../i18n";
import enApp from "../locales/en/app.json";
import { useAppStore } from "../store/useAppStore";
import { Workspace } from "./Workspace";

// xterm 進 jsdom 會炸（canvas/WebGL）；本檔只驗 kind 分派與傳給終端機的 props，終端機換成可辨識的替身
vi.mock("./Terminal", () => ({
  Terminal: ({ zoomable }: { zoomable?: boolean }) => <div data-testid="terminal" data-zoomable={String(zoomable === true)} />,
}));
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

// 找不到 agent 的 binary（後端 400 agent_not_found）要顯示可讀文案，不是「開啟失敗：SessionError: createSession failed: 400」
// （Pi spec §5.7／§6.2 #21）；沒有對應判別碼的錯誤維持原文
describe("Workspace 的 session 建立失敗", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useAppStore.setState({
      port: 1234, projects: [], activeTabId: "e1", config: null,
      tabs: [
        { id: "e1", projectPath: "/p", account: "work", title: "fledge", sessionId: null, status: "error", kind: "claude",
          agent: "pi", error: "SessionError: createSession failed: 400", errorCode: "agent_not_found" },
        { id: "e2", projectPath: "/p", account: "work", title: "fledge", sessionId: null, status: "error", kind: "claude",
          error: "SessionError: createSession failed: 500" },
      ],
    });
  });
  afterEach(cleanup);

  it("agent_not_found → 帶 agent 名的 i18n 文案；其他錯誤 → 原文", () => {
    render(
      <DndContext>
        <Workspace />
      </DndContext>,
    );
    // 用 queryByText＋expect：getByText 找不到時丟的是 TestingLibraryElementError，驗紅工具只認斷言失敗
    expect(screen.queryByText(enApp.errors.agent_not_found.replace("{{agent}}", "pi"))).not.toBeNull();
    expect(screen.queryByText("開啟失敗：SessionError: createSession failed: 500")).not.toBeNull();
    expect(screen.queryByText(/failed: 400/)).toBeNull();
  });
});

// 字級（票 50，spec §4.3）：工作區的終端機跟著 Cmd+= / Cmd+- / Cmd+0 變；設置卡不跟（CardTerminal.test.tsx）
describe("Workspace 的終端機", () => {
  beforeEach(() => {
    // projectPath 留空：不畫右下的「相關」浮窗（它一掛上就打 sidecar），本檔不驗它
    useAppStore.setState({
      port: 1234, projects: [], activeTabId: "t1", config: null,
      tabs: [{ id: "t1", projectPath: "", account: "work", title: "fledge", sessionId: "s1", status: "ready", kind: "terminal" }],
    });
  });
  afterEach(cleanup);

  it("傳 zoomable 給 Terminal", () => {
    render(
      <DndContext>
        <Workspace />
      </DndContext>,
    );
    expect(screen.getByTestId("terminal").dataset.zoomable).toBe("true");
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import i18n from "../i18n";
import enTasks from "../locales/en/tasks.json";
import { useAppStore } from "../store/useAppStore";
import { TabBar } from "./TabBar";

// 接線測試（design §9.1）：TabBar 漏掉 tasks 分派時，tab 會退回 session 狀態圓點、
// 標題是空的——而所有其他測試仍會全綠。
describe("TabBar 的 tasks 分頁", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useAppStore.setState({ port: 1234, tabs: [], activeTabId: null });
  });
  afterEach(cleanup);

  it("有專屬 icon 與標題，不退回 session 狀態圓點或空標題", () => {
    useAppStore.getState().openTasks();
    const { container } = render(
      <DndContext>
        <TabBar />
      </DndContext>,
    );
    expect(screen.getByLabelText(enTasks.tabTitle)).toBeTruthy(); // icon 的 aria-label
    expect(screen.getByText(enTasks.tabTitle)).toBeTruthy(); // 標題取自 tasks namespace
    expect(container.querySelector(".tab-dot")).toBeNull(); // 沒有分派時會落到這個 else 分支
  });
});

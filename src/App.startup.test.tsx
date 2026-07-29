// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import i18n from "./i18n";
import { useAppStore } from "./store/useAppStore";
import type { BootstrapResult } from "./store/useAppStore";

// App 掛了一整棵樹（xterm、dnd-kit、Tauri plugin…）——這裡只驗啟動接線，
// 把重量級子樹換成空殼，讓測試聚焦在 App 自己的邏輯。
vi.mock("./components/Sidebar", () => ({ Sidebar: () => <div /> }));
vi.mock("./components/Workspace", () => ({ Workspace: () => <div /> }));
vi.mock("./components/Settings", () => ({ Settings: () => <div /> }));
vi.mock("./components/ProjectPicker", () => ({ ProjectPicker: () => <div /> }));
vi.mock("./components/Onboarding", () => ({
  Onboarding: () => <div data-testid="onboarding" />,
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.reject(new Error("no tauri")) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import App from "./App";

/** 讓 bootstrap 由測試控制：回傳指定結果並把 startup 推到對應狀態。 */
function stubBootstrap(result: BootstrapResult | null) {
  return vi.fn(async () => {
    useAppStore.setState(
      result ? { startup: "ready" } : { startup: "failed", startupError: "boom" },
    );
    return result;
  });
}

describe("App 啟動接線", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await i18n.changeLanguage("zh-TW");
    useAppStore.setState({ startup: "running", startupError: null, port: 1234, tabs: [], config: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  /** 等 Splash 走完最短顯示 + 淡出後卸載。 */
  async function settleSplash() {
    await act(async () => {
      vi.advanceTimersByTime(2000 + 320 + 50);
    });
  }

  it("啟動成功且非首次時，Splash 淡出後不開 onboarding", async () => {
    const bootstrap = stubBootstrap({ firstRun: false, projectsError: null });
    useAppStore.setState({ bootstrap });
    const { queryByTestId } = render(<App />);
    await settleSplash();
    expect(queryByTestId("splash")).toBeNull();
    expect(queryByTestId("onboarding")).toBeNull();
  });

  it("firstRun 時開啟 onboarding", async () => {
    useAppStore.setState({ bootstrap: stubBootstrap({ firstRun: true, projectsError: null }) });
    const { queryByTestId } = render(<App />);
    await settleSplash();
    await waitFor(() => expect(queryByTestId("onboarding")).not.toBeNull());
  });

  it("projectsError 有值時顯示 banner，沒值時不顯示", async () => {
    useAppStore.setState({
      bootstrap: stubBootstrap({ firstRun: false, projectsError: "scan boom" }),
    });
    const { queryByText } = render(<App />);
    await settleSplash();
    expect(queryByText(i18n.t("app:banners.projects_failed"))).not.toBeNull();
  });

  // R3：重試若直接呼叫 bootstrap 就會繞過 runStartup，firstRun 與 projectsError 都沒人承接
  it("Splash 重試走 runStartup：重試成功且 firstRun 時仍會開 onboarding", async () => {
    const bootstrap = vi
      .fn<(opts?: { restart?: boolean }) => Promise<BootstrapResult | null>>()
      .mockImplementationOnce(async () => {
        useAppStore.setState({ startup: "failed", startupError: "spawn boom" });
        return null;
      })
      .mockImplementationOnce(async () => {
        useAppStore.setState({ startup: "ready" });
        return { firstRun: true, projectsError: null };
      });
    useAppStore.setState({ bootstrap });

    const { getByRole, queryByTestId } = render(<App />);
    await waitFor(() => getByRole("button", { name: i18n.t("splash:actions.retry") }));

    await act(async () => {
      getByRole("button", { name: i18n.t("splash:actions.retry") }).click();
    });
    await settleSplash();

    expect(bootstrap).toHaveBeenLastCalledWith({ restart: true });
    await waitFor(() => expect(queryByTestId("onboarding")).not.toBeNull());
  });

  it("Splash 重試走 runStartup：重試時 loadProjects 失敗仍顯示 banner", async () => {
    const bootstrap = vi
      .fn<(opts?: { restart?: boolean }) => Promise<BootstrapResult | null>>()
      .mockImplementationOnce(async () => {
        useAppStore.setState({ startup: "failed", startupError: "boom" });
        return null;
      })
      .mockImplementationOnce(async () => {
        useAppStore.setState({ startup: "ready" });
        return { firstRun: false, projectsError: "scan boom" };
      });
    useAppStore.setState({ bootstrap });

    const { getByRole, queryByText } = render(<App />);
    await waitFor(() => getByRole("button", { name: i18n.t("splash:actions.retry") }));
    await act(async () => {
      getByRole("button", { name: i18n.t("splash:actions.retry") }).click();
    });
    await settleSplash();

    expect(queryByText(i18n.t("app:banners.projects_failed"))).not.toBeNull();
  });

  // Codex 實作審查：.app-banner 只給 left/right，anchor 由 variant 提供；
  // 兩條底部 warning 若各自 fixed 會疊在同一位置互相遮蔽，蓋掉「重新掃描」按鈕
  it("專案失敗與權限兩條 banner 同時出現時，都在底部堆疊容器內", async () => {
    useAppStore.setState({
      bootstrap: stubBootstrap({ firstRun: false, projectsError: "scan boom" }),
      permissionError: true,
    });
    const { container } = render(<App />);
    await settleSplash();

    const stack = container.querySelector(".app-banner-stack--bottom");
    expect(stack).not.toBeNull();
    expect(stack!.querySelectorAll(".app-banner").length).toBe(2);
  });

  // R1：gate 放在 preventDefault 之前的話，Splash 期間 Cmd+W 會落回 Tauri 預設直接關掉 app
  it("Splash 期間 Cmd+W／Cmd+R 被 preventDefault 且不觸發 action", async () => {
    const loadProjects = vi.fn();
    useAppStore.setState({
      bootstrap: vi.fn(async () => new Promise<BootstrapResult | null>(() => {})), // 永遠 running
      loadProjects,
      requestCloseTab: vi.fn(),
    });
    render(<App />);

    for (const key of ["w", "r"]) {
      const e = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true, bubbles: true });
      act(() => { window.dispatchEvent(e); });
      expect(e.defaultPrevented).toBe(true);
    }
    expect(loadProjects).not.toHaveBeenCalled();
    expect(useAppStore.getState().requestCloseTab).not.toHaveBeenCalled();
  });
});

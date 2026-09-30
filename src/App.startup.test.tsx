// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import i18n from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store/useAppStore";
import type { BootstrapResult, Tab } from "./store/useAppStore";
import appEn from "./locales/en/app.json";

// App 掛了一整棵樹（xterm、dnd-kit、Tauri plugin…）——這裡只驗啟動接線，
// 把重量級子樹換成空殼，讓測試聚焦在 App 自己的邏輯。
vi.mock("./components/Sidebar", () => ({
  Sidebar: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <button data-testid="sidebar-settings" onClick={onOpenSettings} />
  ),
}));
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

/** 等 Splash 走完最短顯示 + 淡出後卸載。 */
async function settleSplash() {
  await act(async () => {
    vi.advanceTimersByTime(2000 + 320 + 50);
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

  // 票 12（Codex 查證）：Splash 擋住了滑鼠與 meta 快捷鍵，卻沒擋鍵盤焦點——用 Tab 摸到底下
  // 看不見的齒輪，就能在 config 還沒載入時開設定頁、再從「重跑引導」進精靈
  it("Splash 期間底下的主畫面是 inert，Splash 自己的重試鈕不是", async () => {
    useAppStore.setState({ bootstrap: stubBootstrap(null) }); // 啟動失敗，停在 Splash 的錯誤頁
    const { getByRole, getByTestId } = render(<App />);
    const retry = await waitFor(() => getByRole("button", { name: i18n.t("splash:actions.retry") }));

    expect(getByTestId("sidebar-settings").closest("[inert]")).not.toBeNull();
    expect(retry.closest("[inert]")).toBeNull();
  });

  it("Splash 結束後主畫面解除 inert", async () => {
    useAppStore.setState({ bootstrap: stubBootstrap({ firstRun: false, projectsError: null }) });
    const { getByTestId, queryByTestId } = render(<App />);
    await settleSplash();

    expect(queryByTestId("splash")).toBeNull();
    expect(getByTestId("sidebar-settings").closest("[inert]")).toBeNull();
  });
});

// 票 33：殼層的橫幅、Cmd+R 提示與關閉 session 確認框原本寫死中文，英文介面也顯示中文。
describe("App 殼層文字走 i18n", () => {
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const liveTab = (title: string): Tab => ({
    id: "tab-1", projectPath: "/p/demo", account: "work", title,
    sessionId: "s-1", status: "ready", kind: "claude",
  });
  const cmdR = () => new KeyboardEvent("keydown", { key: "r", metaKey: true, cancelable: true, bubbles: true });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 本檔各案例之間 store 不會自動歸零（上一組會把 permissionError、loadProjects 留下來），這裡全部重設
    useAppStore.setState({
      startup: "running", startupError: null, port: 1234, config: null, tabs: [],
      backendStatus: "up", claudeFound: true, permissionError: false, pendingCloseTabId: null,
      bootstrap: stubBootstrap({ firstRun: false, projectsError: null }),
      loadProjects: vi.fn(async () => {}),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.mocked(invoke).mockReset();
  });

  it("英文介面：三條橫幅與關閉確認框都是英文，畫面上沒有任何中文", async () => {
    await i18n.changeLanguage("en");
    useAppStore.setState({
      backendStatus: "down", claudeFound: false, permissionError: true,
      tabs: [liveTab("demo")], pendingCloseTabId: "tab-1",
    });
    const ui = render(<App />);
    await settleSplash();

    for (const text of [
      appEn.banners.backend_down, appEn.banners.restart, appEn.banners.claude_missing,
      appEn.banners.install_guide, appEn.banners.permission_denied,
      appEn.close_confirm.title, appEn.close_confirm.cancel, appEn.close_confirm.confirm,
    ]) {
      expect(ui.getByText(text)).toBeTruthy();
    }
    expect(ui.container.querySelector("#close-confirm-desc code")?.textContent).toBe("/resume");
    expect(ui.container.textContent).not.toMatch(CJK);
  });

  it("英文介面：按下重啟後，橫幅與按鈕都顯示英文的重啟中", async () => {
    await i18n.changeLanguage("en");
    vi.mocked(invoke).mockReturnValue(new Promise(() => {})); // restart_sidecar 一直沒回來，停在重啟中
    useAppStore.setState({ backendStatus: "down" });
    const ui = render(<App />);
    await settleSplash();

    await act(async () => { ui.getByText(appEn.banners.restart).click(); });

    expect(ui.getByText(appEn.banners.backend_restarting)).toBeTruthy();
    expect(ui.getByText(appEn.banners.restarting)).toBeTruthy();
    expect(ui.container.textContent).not.toMatch(CJK);
  });

  it("英文介面：Cmd+R 重新掃描的提示是英文", async () => {
    await i18n.changeLanguage("en");
    const ui = render(<App />);
    await settleSplash();

    act(() => { window.dispatchEvent(cmdR()); });

    expect(ui.getByText(appEn.toast.rescanned)).toBeTruthy();
  });

  // 中文是從程式碼原封不動搬進 catalog 的——這裡釘住原文，搬移時改到任何一個字都會紅
  it("中文介面：所有文字與搬進 catalog 前一字不差", async () => {
    await i18n.changeLanguage("zh-TW");
    useAppStore.setState({
      backendStatus: "down", claudeFound: false, permissionError: true,
      tabs: [liveTab("demo")], pendingCloseTabId: "tab-1",
    });
    const ui = render(<App />);
    await settleSplash();

    for (const text of [
      "後端斷線（sidecar 無回應）", "重啟 sidecar", "找不到 Claude Code（claude）。請先安裝。", "安裝說明",
      "無法讀取部分資料夾。請到「系統設定 → 隱私權與安全性 → 檔案與資料夾／App 管理」允許 Fledge。",
      "關閉這個 session？", "取消", "關閉 session",
    ]) {
      expect(ui.getByText(text)).toBeTruthy();
    }
    expect(ui.container.querySelector("#close-confirm-desc")?.textContent).toBe(
      "「demo」的 session 尚未結束。若 AI 仍在處理或等待回覆，關閉會中斷正在執行的程序、目前進度不會保留；" +
      "若只是階段性停止（回覆結束／等待輸入），關閉後仍可用 /resume 恢復對話。確定要關閉嗎？",
    );
    expect(ui.container.querySelector("#close-confirm-desc code")?.textContent).toBe("/resume");
  });

  it("中文介面：重啟中與 Cmd+R 提示的文字與原本相同", async () => {
    await i18n.changeLanguage("zh-TW");
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    useAppStore.setState({ backendStatus: "down" });
    const ui = render(<App />);
    await settleSplash();

    await act(async () => { ui.getByText("重啟 sidecar").click(); });
    expect(ui.getByText("正在重啟 sidecar…")).toBeTruthy();
    expect(ui.getByText("重啟中…")).toBeTruthy();

    act(() => { window.dispatchEvent(cmdR()); });
    expect(ui.getByText("已重新掃描專案")).toBeTruthy();
  });

  // session 名稱是使用者可控的字串，插進帶 <code> 標籤的句子裡時不能被當成標籤解析，也不能被再插值一次
  // （Codex 審查：<Trans> 解析後會對文字節點再跑一次插值，`{{title}}` 會被展開成名稱本身）
  it.each([
    ["標籤字元", "a <code>b</code> & <b>c</b>"],
    ["字面的 entity（抓多還原一次）", "a &amp; &lt;b&gt; &amp;amp;"],
    ["插值語法", "demo {{title}}"],
    ["i18next 的保留參數名", "{{defaultValue}}"],
  ])("session 名稱含%s時照原樣顯示", async (_case, title) => {
    await i18n.changeLanguage("zh-TW");
    useAppStore.setState({ tabs: [liveTab(title)], pendingCloseTabId: "tab-1" });
    const ui = render(<App />);
    await settleSplash();

    const desc = ui.container.querySelector("#close-confirm-desc")!;
    expect(desc.textContent).toContain(`「${title}」`);
    expect(desc.querySelectorAll("code")).toHaveLength(1); // 只有 /resume 那一個
    expect(desc.querySelector("b")).toBeNull();
  });
});

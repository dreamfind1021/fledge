// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import type { ToolStatus } from "../lib/sidecar";
import { EnvCard } from "./EnvCard";

const fetchSetupStatus = vi.fn<(port: number) => Promise<ToolStatus[]>>();
const writeClipboard = vi.fn<(text: string) => Promise<boolean>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchSetupStatus: (port: number) => fetchSetupStatus(port),
}));
vi.mock("../lib/clipboard", () => ({ writeClipboard: (t: string) => writeClipboard(t) }));

const BREW_CMD = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

// 僅手動安裝（install_command=null）→ 只給「複製指令」
const brew: ToolStatus = {
  id: "homebrew", label: "Homebrew", tier: "core", installed: false, path: null, version: null,
  binary: "brew", install_command: null, manual_command: BREW_CMD,
};
const node: ToolStatus = {
  id: "node", label: "Node.js", tier: "core", installed: true, path: "/opt/homebrew/bin/node",
  version: "v25.8.2", binary: "node", install_command: "brew install node", manual_command: null,
};
const gh: ToolStatus = {
  id: "gh", label: "GitHub CLI", tier: "recommended", installed: false, path: null, version: null,
  binary: "gh", install_command: "brew install gh", manual_command: null,
};

const noop = () => {};
const renderCard = () => render(<EnvCard port={1234} onPrev={noop} onNext={noop} />);

describe("EnvCard 環境偵測卡", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW"); // 固定語言，斷言才對得上 catalog
    fetchSetupStatus.mockReset().mockResolvedValue([brew, node, gh]);
    writeClipboard.mockReset().mockResolvedValue(true);
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  it("依 tier 分核心／常用兩區，已安裝顯示版本、未安裝顯示 binary 名", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("Node.js")).toBeTruthy());

    const [core, recommended] = [...ui.container.querySelectorAll(".b4-sec")];
    expect(core.textContent).toContain(zh.env.core);
    expect(core.textContent).toContain("Homebrew");
    expect(core.textContent).toContain("v25.8.2");     // 已安裝 → 版本
    expect(core.textContent).toContain("brew");        // 未安裝 → binary 名
    expect(core.textContent).not.toContain("GitHub CLI");
    expect(recommended.textContent).toContain(zh.env.recommended);
    expect(recommended.textContent).toContain("GitHub CLI");

    const rows = [...ui.container.querySelectorAll(".b4-item")];
    const nodeRow = rows.find((r) => r.textContent?.includes("Node.js"))!;
    expect(nodeRow.querySelector(".b4-dot.ok")).toBeTruthy();
    expect(nodeRow.textContent).toContain(zh.env.installed);
    const brewRow = rows.find((r) => r.textContent?.includes("Homebrew"))!;
    expect(brewRow.querySelector(".b4-dot.todo")).toBeTruthy();
    expect(brewRow.textContent).toContain(zh.env.missing);
  });

  it("PATH 與 git 身分：顯示靜態提醒（本版不偵測）", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("Node.js")).toBeTruthy());
    expect(ui.container.querySelector(".b4-hint")?.textContent).toContain("~/.local/bin");
  });

  it("未安裝且有 install_command：顯示安裝按鈕，本票尚無行為（票 24 接 PTY）", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("GitHub CLI")).toBeTruthy());

    const install = ui.getByText(zh.env.install) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    // 已安裝的工具不給安裝按鈕
    expect(ui.getAllByText(zh.env.install)).toHaveLength(1);
  });

  it("僅手動安裝（Homebrew）：只給複製指令，展開看得到完整官方指令", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("Homebrew")).toBeTruthy());
    expect(ui.container.textContent).not.toContain(BREW_CMD); // 預設收合

    ui.getByText(zh.env.copyCmd).click();

    await waitFor(() => expect(ui.getByText(BREW_CMD)).toBeTruthy());
    expect(ui.getByText(zh.env.brewTitle)).toBeTruthy();
    expect(ui.getByText(zh.env.brewHint)).toBeTruthy();
  });

  it("複製按鈕把後端給的指令寫進剪貼簿並回饋已複製", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("Homebrew")).toBeTruthy());
    ui.getByText(zh.env.copyCmd).click();
    await waitFor(() => expect(ui.getByText(zh.common.copy)).toBeTruthy());

    ui.getByText(zh.common.copy).click();

    await waitFor(() => expect(ui.getByText(zh.env.copied)).toBeTruthy());
    expect(writeClipboard).toHaveBeenCalledWith(BREW_CMD);
  });

  // 觸發鍵只在未安裝時渲染：面板若不跟著收，重新檢查後會留下一塊「需要手動安裝」且無收合入口
  it("展開中的工具在重新檢查後變成已安裝：面板跟著收起", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("Homebrew")).toBeTruthy());
    ui.getByText(zh.env.copyCmd).click();
    await waitFor(() => expect(ui.getByText(BREW_CMD)).toBeTruthy());

    fetchSetupStatus.mockResolvedValue([{ ...brew, installed: true, version: "Homebrew 5.0.6" }, node, gh]);
    ui.getByText(zh.env.recheck).click();

    await waitFor(() => expect(ui.container.textContent).toContain("Homebrew 5.0.6"));
    expect(ui.queryByText(BREW_CMD)).toBeNull();
    expect(ui.queryByText(zh.env.brewTitle)).toBeNull();
  });

  it("重新檢查重打端點並更新狀態", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("GitHub CLI")).toBeTruthy());
    expect(fetchSetupStatus).toHaveBeenCalledTimes(1);

    fetchSetupStatus.mockResolvedValue([brew, node, { ...gh, installed: true, version: "gh 2.65.0" }]);
    ui.getByText(zh.env.recheck).click();

    await waitFor(() => expect(ui.container.textContent).toContain("gh 2.65.0"));
    expect(fetchSetupStatus).toHaveBeenCalledTimes(2);
    const ghRow = [...ui.container.querySelectorAll(".b4-item")]
      .find((r) => r.textContent?.includes("GitHub CLI"))!;
    expect(ghRow.querySelector(".b4-dot.ok")).toBeTruthy();
    expect(ghRow.querySelector("button")).toBeNull(); // 已安裝 → 安裝按鈕消失
  });

  // 重疊偵測的真實入口是 port 變更（重啟 sidecar）——「重新檢查」在 loading 時是 disabled 的。
  // 先發的請求晚到時若照樣寫進 state，畫面會退回上一個 sidecar 的偵測結果。
  it("重疊偵測：先發的回應晚到也不能覆蓋新結果", async () => {
    let resolveStale!: (v: ToolStatus[]) => void;
    fetchSetupStatus.mockImplementationOnce(() => new Promise<ToolStatus[]>((r) => { resolveStale = r; }));
    fetchSetupStatus.mockResolvedValue([{ ...gh, installed: true, version: "gh 2.65.0" }]);

    const ui = render(<EnvCard port={1234} onPrev={noop} onNext={noop} />);
    ui.rerender(<EnvCard port={5678} onPrev={noop} onNext={noop} />); // 新 port → 新一輪偵測
    await waitFor(() => expect(ui.container.textContent).toContain("gh 2.65.0"));

    resolveStale([node]); // 舊 sidecar 的回應這時才到
    await waitFor(() => expect(ui.container.textContent).toContain("gh 2.65.0"));
    expect(ui.queryByText("Node.js")).toBeNull();
  });

  it("重疊偵測：先發的失敗晚到也不能在新結果上蓋錯誤", async () => {
    let rejectStale!: (e: Error) => void;
    fetchSetupStatus.mockImplementationOnce(() => new Promise<ToolStatus[]>((_, rej) => { rejectStale = rej; }));
    fetchSetupStatus.mockResolvedValue([node]);

    const ui = render(<EnvCard port={1234} onPrev={noop} onNext={noop} />);
    ui.rerender(<EnvCard port={5678} onPrev={noop} onNext={noop} />);
    await waitFor(() => expect(ui.getByText("Node.js")).toBeTruthy());

    rejectStale(new Error("HTTP 500"));
    await waitFor(() => expect(ui.getByText("Node.js")).toBeTruthy());
    expect(ui.queryByRole("alert")).toBeNull();
  });

  // 複製的 Promise 尚未 resolve 就切頁：cleanup 已跑完，回呼不得再排一個逃過清理的 timer
  it("複製途中卸載：resolve 後不再排 timer", async () => {
    let resolveWrite!: (v: boolean) => void;
    writeClipboard.mockImplementationOnce(() => new Promise<boolean>((r) => { resolveWrite = r; }));
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("Homebrew")).toBeTruthy());
    ui.getByText(zh.env.copyCmd).click();
    await waitFor(() => expect(ui.getByText(zh.common.copy)).toBeTruthy());
    ui.getByText(zh.common.copy).click();

    cleanup(); // 卸載發生在 writeClipboard 完成之前
    const timers = vi.spyOn(globalThis, "setTimeout");
    resolveWrite(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
  });

  it("偵測失敗顯示錯誤訊息，且可再按重新檢查重試", async () => {
    fetchSetupStatus.mockRejectedValue(new Error("HTTP 500"));
    const ui = renderCard();

    await waitFor(() => expect(ui.getByRole("alert").textContent).toContain("HTTP 500"));

    fetchSetupStatus.mockResolvedValue([node]);
    ui.getByText(zh.env.recheck).click();
    await waitFor(() => expect(ui.getByText("Node.js")).toBeTruthy());
    expect(ui.queryByRole("alert")).toBeNull(); // 重試成功後錯誤要消失
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import { SessionError, type CreateSessionOptions, type ToolStatus } from "../lib/sidecar";
import { EnvCard } from "./EnvCard";

const fetchSetupStatus = vi.fn<(port: number) => Promise<ToolStatus[]>>();
const writeClipboard = vi.fn<(text: string) => Promise<boolean>>();
const createSession = vi.fn<(port: number, opts: CreateSessionOptions) => Promise<string>>();
const closeSession = vi.fn<(port: number, sessionId: string) => Promise<void>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchSetupStatus: (port: number) => fetchSetupStatus(port),
  createSession: (port: number, opts: CreateSessionOptions) => createSession(port, opts),
  closeSession: (port: number, sessionId: string) => closeSession(port, sessionId),
}));
vi.mock("../lib/clipboard", () => ({ writeClipboard: (t: string) => writeClipboard(t) }));
// xterm 進 jsdom 會炸（canvas/WebGL）；本卡只需驗「終端機有沒有被掛上、掛在哪個 session」
vi.mock("./Terminal", () => ({
  Terminal: ({ sessionId, tabId }: { sessionId: string; tabId: string }) => (
    <div data-testid="terminal" data-session={sessionId} data-tab={tabId} />
  ),
}));

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
    createSession.mockReset().mockResolvedValue("sess-1");
    closeSession.mockReset().mockResolvedValue(undefined);
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

  it("安裝按鈕只出現在未安裝且能一鍵安裝的列上", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("GitHub CLI")).toBeTruthy());

    const install = ui.getByText(zh.env.install) as HTMLButtonElement;
    expect(install.disabled).toBe(false);
    // 已安裝（node）與只能手動安裝（homebrew）的列都不給安裝按鈕
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

  // 上面兩個競態測試都先等新請求完成才讓舊請求落地，那時 loading 本來就是 false——單獨把
  // finally 的 guard 拿掉也不會被抓到。這條專門鎖 stale finally：兩個請求都還在途時先 settle 舊的。
  it("重疊偵測：先發的請求落地不得提前解除 loading", async () => {
    let settleStale!: (v: ToolStatus[]) => void;
    let settleFresh!: (v: ToolStatus[]) => void;
    fetchSetupStatus
      .mockImplementationOnce(() => new Promise<ToolStatus[]>((r) => { settleStale = r; }))
      .mockImplementationOnce(() => new Promise<ToolStatus[]>((r) => { settleFresh = r; }));

    const ui = render(<EnvCard port={1234} onPrev={noop} onNext={noop} />);
    ui.rerender(<EnvCard port={5678} onPrev={noop} onNext={noop} />);
    const recheck = () => ui.getByText(zh.env.recheck) as HTMLButtonElement;
    expect(recheck().disabled).toBe(true);

    await act(async () => { settleStale([node]); });
    expect(recheck().disabled).toBe(true); // 舊請求落地，新的還在途 → 仍是載入中

    await act(async () => { settleFresh([gh]); });
    expect(recheck().disabled).toBe(false);
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

describe("EnvCard 一鍵安裝", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    fetchSetupStatus.mockReset().mockResolvedValue([brew, node, gh]);
    writeClipboard.mockReset().mockResolvedValue(true);
    createSession.mockReset().mockResolvedValue("sess-1");
    closeSession.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  /** 載入完成後按下 gh 那列的「安裝」，回到確認面板前的狀態 */
  async function reachConfirm(ui: ReturnType<typeof render>) {
    await waitFor(() => expect(ui.getByText("GitHub CLI")).toBeTruthy());
    ui.getByText(zh.env.install).click();
    await waitFor(() => expect(ui.getByText(zh.env.confirmTitle)).toBeTruthy());
  }

  // 上游 spec §5 硬性要求：執行前必須讓使用者看到完整命令並確認
  it("按安裝先出確認面板顯示完整命令，此時還沒建立 session", async () => {
    const ui = renderCard();
    await reachConfirm(ui);

    expect(ui.getByText("brew install gh")).toBeTruthy();
    expect(ui.getByText(zh.env.confirmRun)).toBeTruthy();
    expect(ui.getByText(zh.common.cancel)).toBeTruthy();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("取消：面板收起、不建立 session", async () => {
    const ui = renderCard();
    await reachConfirm(ui);

    ui.getByText(zh.common.cancel).click();

    await waitFor(() => expect(ui.queryByText(zh.env.confirmTitle)).toBeNull());
    expect(createSession).not.toHaveBeenCalled();
    expect(ui.queryByTestId("terminal")).toBeNull();
  });

  // 安全不變式（spec §5）：前端只送 install_id，永遠不送 raw command，也不送 account
  it("確認執行：以 install_id 建 session 並在卡片內掛終端機", async () => {
    const ui = renderCard();
    await reachConfirm(ui);

    ui.getByText(zh.env.confirmRun).click();

    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    expect(createSession).toHaveBeenCalledWith(1234, { path: "", kind: "install", installId: "gh" });
    const term = ui.getByTestId("terminal");
    expect(term.getAttribute("data-session")).toBe("sess-1");
    expect(term.getAttribute("data-tab")).toContain("sess-1"); // 合成 tabId，不與真 tab 相撞
    expect(ui.queryByText(zh.env.confirmRun)).toBeNull();      // 確認面板讓位給終端機
  });

  it("建立 session 失敗：顯示映射後的判別碼訊息，不掛終端機", async () => {
    createSession.mockRejectedValue(new SessionError("unknown_install_id", 400));
    const ui = renderCard();
    await reachConfirm(ui);

    ui.getByText(zh.env.confirmRun).click();

    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy());
    expect(ui.getByRole("alert").textContent).toBe(zh.errors.unknown_install_id);
    expect(ui.queryByTestId("terminal")).toBeNull();
  });

  // 安裝跑完後 shell 結束，輸出要留在原地供檢視——「重新檢查」轉成已安裝也不能把它收掉
  it("重新檢查後該工具轉為已安裝：終端機輸出仍保留", async () => {
    const ui = renderCard();
    await reachConfirm(ui);
    ui.getByText(zh.env.confirmRun).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());

    fetchSetupStatus.mockResolvedValue([brew, node, { ...gh, installed: true, version: "gh 2.65.0" }]);
    ui.getByText(zh.env.recheck).click();

    await waitFor(() => expect(ui.container.textContent).toContain("gh 2.65.0"));
    expect(ui.getByTestId("terminal")).toBeTruthy();
  });

  // 偵測錯誤與安裝錯誤是兩個 state（合併顯示）：安裝時若不清掉上一輪的偵測錯誤，
  // 使用者會看到過期的「工具偵測失敗」蓋住這次的安裝結果（Codex 票25 R1 Medium-1）
  it("重新檢查失敗後安裝也失敗：顯示安裝錯誤而非過期的偵測錯誤", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("GitHub CLI")).toBeTruthy());

    fetchSetupStatus.mockRejectedValue(new Error("HTTP 500"));
    ui.getByText(zh.env.recheck).click();
    await waitFor(() => expect(ui.getByRole("alert").textContent).toContain("HTTP 500"));

    createSession.mockRejectedValue(new SessionError("unknown_install_id", 400));
    await reachConfirm(ui);            // 舊清單還在，那一列仍可按安裝
    ui.getByText(zh.env.confirmRun).click();

    await waitFor(() => expect(ui.getByRole("alert").textContent).toBe(zh.errors.unknown_install_id));
  });

  it("重新檢查失敗後安裝成功：偵測錯誤不殘留在畫面上", async () => {
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("GitHub CLI")).toBeTruthy());

    fetchSetupStatus.mockRejectedValue(new Error("HTTP 500"));
    ui.getByText(zh.env.recheck).click();
    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy());

    await reachConfirm(ui);
    ui.getByText(zh.env.confirmRun).click();

    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    expect(ui.queryByRole("alert")).toBeNull();   // 安裝真的跑起來了，卻還掛著偵測失敗＝誤導
  });

  // 偵測與安裝各自寫一個 error state、合併顯示時偵測優先——兩者若能並行，晚返回的那個
  // 就會蓋掉另一個的結果。最小解是讓兩種操作互斥（Codex 票25 R2 Medium-1）。
  it("偵測進行中：安裝的確認鍵停用", async () => {
    const ui = renderCard();
    await reachConfirm(ui);

    let settleLoad!: (v: ToolStatus[]) => void;
    fetchSetupStatus.mockImplementationOnce(() => new Promise<ToolStatus[]>((r) => { settleLoad = r; }));
    ui.getByText(zh.env.recheck).click();

    await waitFor(() =>
      expect((ui.getByText(zh.env.confirmRun) as HTMLButtonElement).disabled).toBe(true));
    ui.getByText(zh.env.confirmRun).click();
    expect(createSession).not.toHaveBeenCalled();

    await act(async () => { settleLoad([brew, node, gh]); });
  });

  it("安裝建立中：重新檢查停用", async () => {
    let settleCreate!: (id: string) => void;
    createSession.mockImplementationOnce(() => new Promise<string>((r) => { settleCreate = r; }));
    const ui = renderCard();
    await reachConfirm(ui);

    ui.getByText(zh.env.confirmRun).click();

    await waitFor(() =>
      expect((ui.getByText(zh.env.recheck) as HTMLButtonElement).disabled).toBe(true));
    expect(fetchSetupStatus).toHaveBeenCalledTimes(1); // 初次載入那一次，沒有第二次

    await act(async () => { settleCreate("sess-1"); });
  });

  // start() 在 port 未就緒時直接回 false，什麼都沒發生——這時不該把畫面上的偵測錯誤清掉
  it("port 未就緒：按確認不清掉既有的偵測錯誤", async () => {
    const ui = renderCard();
    await reachConfirm(ui);                                  // 先展開確認面板

    fetchSetupStatus.mockRejectedValue(new Error("HTTP 500"));
    ui.getByText(zh.env.recheck).click();                    // 造出偵測錯誤（舊清單保留）
    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy());

    ui.rerender(<EnvCard port={null} onPrev={noop} onNext={noop} />);  // sidecar 重啟中
    await act(async () => { ui.getByText(zh.env.confirmRun).click(); });

    expect(ui.queryByRole("alert")).toBeTruthy();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("卸載時關閉安裝 session，不留 orphan PTY", async () => {
    const ui = renderCard();
    await reachConfirm(ui);
    ui.getByText(zh.env.confirmRun).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());

    await act(async () => { cleanup(); });

    expect(closeSession).toHaveBeenCalledWith(1234, "sess-1");
  });

  // 「一次只跑一個」是為了避免兩個 brew 併行撞鎖——所以順序必須是「關完舊的才 spawn 新的」。
  // 只斷言 closeSession 有被呼叫是不夠的：先 spawn 再關，兩個安裝仍會短暫併行（Codex R1 Medium）。
  it("改裝另一個工具：舊 session 關閉完成前，不得建立新的", async () => {
    const claude: ToolStatus = {
      id: "claude", label: "Claude Code CLI", tier: "core", installed: false, path: null, version: null,
      binary: "claude", install_command: "curl -fsSL https://claude.ai/install.sh | bash", manual_command: null,
    };
    fetchSetupStatus.mockResolvedValue([brew, node, claude, gh]);
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("GitHub CLI")).toBeTruthy());
    ui.getAllByText(zh.env.install)[1].click(); // gh
    await waitFor(() => expect(ui.getByText(zh.env.confirmTitle)).toBeTruthy());
    ui.getByText(zh.env.confirmRun).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());

    let settleClose!: () => void;
    closeSession.mockImplementationOnce(() => new Promise<void>((r) => { settleClose = () => r(); }));
    createSession.mockClear().mockResolvedValue("sess-2");

    ui.getByText(zh.env.install).click(); // 只剩 claude 那顆
    await waitFor(() => expect(ui.getByText(zh.env.confirmTitle)).toBeTruthy());
    ui.getByText(zh.env.confirmRun).click();

    await waitFor(() => expect(closeSession).toHaveBeenCalledWith(1234, "sess-1"));
    expect(createSession).not.toHaveBeenCalled(); // 舊的還沒關掉 → 不得先 spawn

    await act(async () => { settleClose(); });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
  });

  it("改裝另一個工具：卡片內仍只有一個終端機，指向新 session", async () => {
    const claude: ToolStatus = {
      id: "claude", label: "Claude Code CLI", tier: "core", installed: false, path: null, version: null,
      binary: "claude", install_command: "curl -fsSL https://claude.ai/install.sh | bash", manual_command: null,
    };
    fetchSetupStatus.mockResolvedValue([brew, node, claude, gh]);
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText("GitHub CLI")).toBeTruthy());
    ui.getAllByText(zh.env.install)[1].click(); // 常用區的 gh（核心區的 claude 是第 0 顆）
    await waitFor(() => expect(ui.getByText(zh.env.confirmTitle)).toBeTruthy());
    ui.getByText(zh.env.confirmRun).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());

    createSession.mockResolvedValue("sess-2");
    ui.getByText(zh.env.install).click(); // 只剩 claude 那列還有安裝鍵（gh 的已讓位給終端機）
    await waitFor(() => expect(ui.getByText(zh.env.confirmTitle)).toBeTruthy());
    ui.getByText(zh.env.confirmRun).click();

    await waitFor(() => expect(ui.getByTestId("terminal").getAttribute("data-session")).toBe("sess-2"));
    expect(closeSession).toHaveBeenCalledWith(1234, "sess-1");
    expect(ui.getAllByTestId("terminal")).toHaveLength(1);
  });
});

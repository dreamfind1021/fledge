// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import { SessionError, type CreateSessionOptions } from "../lib/sidecar";
import { LoginCard } from "./LoginCard";

const createSession = vi.fn<(port: number, opts: CreateSessionOptions) => Promise<string>>();
const closeSession = vi.fn<(port: number, sessionId: string) => Promise<void>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  createSession: (port: number, opts: CreateSessionOptions) => createSession(port, opts),
  closeSession: (port: number, sessionId: string) => closeSession(port, sessionId),
}));
vi.mock("./Terminal", () => ({
  Terminal: ({ sessionId, tabId }: { sessionId: string; tabId: string }) => (
    <div data-testid="terminal" data-session={sessionId} data-tab={tabId} />
  ),
}));

const accounts = {
  work: { config_dir: "~/.claude", label: "工作" },
  personal: { config_dir: "~/.claude-tc", label: "私人" },
};
const noop = () => {};
const renderCard = (props: Partial<Parameters<typeof LoginCard>[0]> = {}) =>
  render(<LoginCard port={1234} accounts={accounts} onPrev={noop} onNext={noop} {...props} />);

describe("LoginCard 登入卡", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW"); // 固定語言，斷言才對得上 catalog
    createSession.mockReset().mockResolvedValue("sess-1");
    closeSession.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  it("每個帳號一張卡（顯示 key 與 config_dir），Codex 另有一張", () => {
    const ui = renderCard();
    const cards = [...ui.container.querySelectorAll(".b4-card")];

    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toContain("work");
    expect(cards[0].textContent).toContain("~/.claude");
    expect(cards[1].textContent).toContain("personal");
    expect(cards[1].textContent).toContain("~/.claude-tc");
    // Codex 是品牌名、不進 catalog（比照 Fledge wordmark，§4.6.13 記錄例外）
    expect(cards[2].textContent).toContain("Codex");
    expect(cards[2].textContent).toContain(zh.login.codexDesc);
  });

  // spec-b4 §1：macOS 的 Claude 憑證在 Keychain、不在 config_dir，前端沒有可靠的成功訊號。
  // 假裝有完成狀態就是騙人——寧可誠實說明這裡只負責開對環境的終端機。
  it("不顯示任何完成狀態，並說明原因", () => {
    const ui = renderCard();

    expect(ui.container.querySelector(".b4-chip")).toBeNull();
    expect(ui.container.querySelector(".b4-dot")).toBeNull();
    expect(ui.container.querySelector(".b4-note")?.textContent).toContain("Keychain");
  });

  it("按帳號的登入鍵：帶該帳號建 login session 並掛終端機", async () => {
    const ui = renderCard();

    ui.getAllByText(zh.login.open)[1].click(); // personal 那張

    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    expect(createSession).toHaveBeenCalledWith(1234, {
      path: "", account: "personal", kind: "login", loginTarget: "claude",
    });
    expect(ui.getByTestId("terminal").getAttribute("data-session")).toBe("sess-1");
  });

  // Codex 登入本質是全域的（B-1 收尾票已確認），不可做成 per-account
  it("Codex 卡用 login_target=codex，且只有一張", async () => {
    const ui = renderCard();

    ui.getAllByText(zh.login.open)[2].click();

    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    const opts = createSession.mock.calls[0][1];
    expect(opts.kind).toBe("login");
    expect(opts.loginTarget).toBe("codex");
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  // 沿用票 24 的教訓：一次只掛一個終端機，且必須「關完舊的才建新的」
  it("換一張卡登入：舊 session 關閉完成前不得建立新的", async () => {
    const ui = renderCard();
    ui.getAllByText(zh.login.open)[0].click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());

    let settleClose!: () => void;
    closeSession.mockImplementationOnce(() => new Promise<void>((r) => { settleClose = () => r(); }));
    createSession.mockClear().mockResolvedValue("sess-2");

    ui.getAllByText(zh.login.open)[1].click();

    await waitFor(() => expect(closeSession).toHaveBeenCalledWith(1234, "sess-1"));
    expect(createSession).not.toHaveBeenCalled();

    await act(async () => { settleClose(); });
    await waitFor(() => expect(ui.getByTestId("terminal").getAttribute("data-session")).toBe("sess-2"));
    expect(ui.getAllByTestId("terminal")).toHaveLength(1);
  });

  it("卸載時關閉 session，不留 orphan PTY", async () => {
    const ui = renderCard();
    ui.getAllByText(zh.login.open)[0].click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());

    await act(async () => { cleanup(); });

    expect(closeSession).toHaveBeenCalledWith(1234, "sess-1");
  });

  it("建立失敗：顯示映射後的判別碼訊息，不掛終端機", async () => {
    createSession.mockRejectedValue(new SessionError("unknown_account", 400));
    const ui = renderCard();

    ui.getAllByText(zh.login.open)[0].click();

    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy());
    expect(ui.getByRole("alert").textContent).toBe(zh.errors.unknown_account);
    expect(ui.queryByTestId("terminal")).toBeNull();
  });

  it("稍後再登入：直接往下一頁，不建任何 session", () => {
    const onNext = vi.fn();
    const ui = renderCard({ onNext });

    ui.getByText(zh.login.later).click();

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
  });
});

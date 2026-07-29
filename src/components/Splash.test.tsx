// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import i18n from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { Splash } from "./Splash";

// Tauri 的 app 資訊在測試環境取不到 → 版本號那條路走 catch（design §4.3）
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.reject(new Error("no tauri")) }));

const MIN_DISPLAY = 2000;
const FADE = 320;

function setStartup(phase: "running" | "ready" | "failed", error: string | null = null) {
  act(() => {
    useAppStore.setState({ startup: phase, startupError: error });
  });
}

describe("Splash", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await i18n.changeLanguage("zh-TW");
    useAppStore.setState({ startup: "running", startupError: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup(); // vitest 未開 globals → testing-library 不會自動 cleanup
    vi.restoreAllMocks();
  });

  it("ready 早於最短顯示時，仍等滿 2s 才淡出", () => {
    const onDone = vi.fn();
    render(<Splash onDone={onDone} onRetry={vi.fn()} />);

    act(() => { vi.advanceTimersByTime(300); });
    setStartup("ready");
    act(() => { vi.advanceTimersByTime(300); }); // 累計 600ms
    expect(onDone).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(MIN_DISPLAY - 600 + FADE); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("ready 晚於最短顯示時，立即進入淡出", () => {
    const onDone = vi.fn();
    render(<Splash onDone={onDone} onRetry={vi.fn()} />);

    act(() => { vi.advanceTimersByTime(3000); });
    setStartup("ready");
    act(() => { vi.advanceTimersByTime(FADE); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // R3 收斂成單一規則：淡出恆為「自掛載起滿 2s」，早期失敗＋快速重試也不例外
  it("早期失敗後快速重試成功、總時長未滿 2s 時仍補滿才淡出", () => {
    const onDone = vi.fn();
    render(<Splash onDone={onDone} onRetry={vi.fn()} />);

    act(() => { vi.advanceTimersByTime(200); });
    setStartup("failed", "loadConfig boom");
    act(() => { vi.advanceTimersByTime(200); });
    setStartup("ready"); // 累計才 400ms
    act(() => { vi.advanceTimersByTime(FADE); });
    expect(onDone).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(MIN_DISPLAY - 400); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("逾時提示在 5s 後才出現", () => {
    const { queryByText } = render(<Splash onDone={vi.fn()} onRetry={vi.fn()} />);
    const hint = () => queryByText(i18n.t("splash:wait.hint"));

    act(() => { vi.advanceTimersByTime(4900); });
    expect(hint()).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(hint()).not.toBeNull();
  });

  it("failed 時顯示錯誤區、等待指示消失", () => {
    const { queryByText, queryByRole } = render(<Splash onDone={vi.fn()} onRetry={vi.fn()} />);
    setStartup("failed", "spawn boom");

    expect(queryByText(i18n.t("splash:errors.startup_failed"))).not.toBeNull();
    expect(queryByRole("button", { name: i18n.t("splash:actions.retry") })).not.toBeNull();
    expect(queryByRole("status")).toBeNull(); // 等待指示
  });

  it("詳細資訊預設收合，展開後含 startupError 原文", () => {
    const { getByRole, queryByText } = render(<Splash onDone={vi.fn()} onRetry={vi.fn()} />);
    setStartup("failed", "spawn /path/fledge-sidecar failed: EACCES");

    expect(queryByText(/EACCES/)).toBeNull();
    act(() => { getByRole("button", { name: i18n.t("splash:actions.details") }).click(); });
    expect(queryByText(/EACCES/)).not.toBeNull();
  });

  it("按重試呼叫 onRetry，重試中按鈕 disabled 並顯示重試中", () => {
    const onRetry = vi.fn();
    const { getByRole } = render(<Splash onDone={vi.fn()} onRetry={onRetry} />);
    setStartup("failed", "boom");

    act(() => { getByRole("button", { name: i18n.t("splash:actions.retry") }).click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);

    setStartup("running"); // 重試進行中
    const btn = getByRole("button", { name: i18n.t("splash:actions.retrying") }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("重試再次失敗後按鈕恢復可按", () => {
    const onRetry = vi.fn();
    const { getByRole } = render(<Splash onDone={vi.fn()} onRetry={onRetry} />);
    setStartup("failed", "boom");
    act(() => { getByRole("button", { name: i18n.t("splash:actions.retry") }).click(); });
    setStartup("running");
    setStartup("failed", "boom again");

    const btn = getByRole("button", { name: i18n.t("splash:actions.retry") }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    act(() => { btn.click(); });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});

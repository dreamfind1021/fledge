// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import { useAppStore } from "../store/useAppStore";
import { Onboarding } from "./Onboarding";

vi.mock("../lib/dialog", () => ({ pickDirectory: vi.fn() }));
vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  scanPreview: vi.fn(async (_port: number, path: string) => ({ path, count: 3, status: "ok" as const })),
}));

const account = { config_dir: "~/.claude", label: "Work" };
const baseConfig = {
  version: 1,
  roots: [],
  accounts: { work: account, personal: { ...account, label: "Personal" } },
  manual_projects: [],
  project_overrides: {},
  ui: { theme: "nightfall" },
  is_first_run: true,
};

/** 走到根目錄頁並加一個 draft root（onboard 的前置條件：至少一個根目錄） */
async function reachRootsWithDraft(ui: ReturnType<typeof render>) {
  ui.getByText(zh.welcome.cta).click();
  await waitFor(() => expect(ui.getByText(zh.roots.h)).toBeTruthy());
  fireEvent.change(ui.getByPlaceholderText(zh.roots.placeholder), { target: { value: "/tmp/work" } });
  ui.getByText(zh.roots.add).click();
  await waitFor(() => expect(ui.getByText("/tmp/work")).toBeTruthy());
}

describe("Onboarding 精靈外殼", () => {
  let onboardCalls: number;
  let onClose: Mock<() => void>;

  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW"); // 固定語言，斷言才對得上 catalog
    onboardCalls = 0;
    onClose = vi.fn<() => void>();
    useAppStore.setState({
      port: 1234,
      config: baseConfig,
      completeOnboarding: async () => {
        onboardCalls += 1;
      },
    });
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  it("根目錄頁落檔後留在精靈，直接進到下一頁（不關閉）", async () => {
    const ui = render(<Onboarding onClose={onClose} />);
    await reachRootsWithDraft(ui);

    ui.getByText(zh.roots.next).click();

    await waitFor(() => expect(ui.getByText(zh.env.h)).toBeTruthy()); // 已在環境頁
    expect(onboardCalls).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("落檔後回根目錄頁再按下一步，不會重打 onboard（first-run only，重入回 409）", async () => {
    const ui = render(<Onboarding onClose={onClose} />);
    await reachRootsWithDraft(ui);

    ui.getByText(zh.roots.next).click();
    await waitFor(() => expect(ui.getByText(zh.env.h)).toBeTruthy());

    ui.getByText(zh.common.prev).click(); // 回根目錄頁
    await waitFor(() => expect(ui.getByText(zh.roots.created)).toBeTruthy()); // 已落檔提示取代原說明
    ui.getByText(zh.common.next).click(); // 主按鈕已改為單純前進

    await waitFor(() => expect(ui.getByText(zh.env.h)).toBeTruthy());
    expect(onboardCalls).toBe(1);
  });

  it("單帳號少一頁：登入頁的下一步直接到系統設置，不經共通設置", async () => {
    useAppStore.setState({ config: { ...baseConfig, accounts: { work: account } } });
    const ui = render(<Onboarding onClose={onClose} />);
    await reachRootsWithDraft(ui);

    ui.getByText(zh.roots.next).click();
    await waitFor(() => expect(ui.getByText(zh.env.h)).toBeTruthy());
    ui.getByText(zh.common.next).click(); // 環境 → 登入
    await waitFor(() => expect(ui.getByText(zh.login.h)).toBeTruthy());
    ui.getByText(zh.common.next).click(); // 登入 → ?

    await waitFor(() => expect(ui.getByText(zh.sys.h)).toBeTruthy());
    expect(ui.queryByText(zh.cc.h)).toBeNull();
  });

  it("進度條格數跟著帳號數：雙帳號七格、單帳號六格", async () => {
    const dual = render(<Onboarding onClose={onClose} />);
    expect(dual.container.querySelectorAll(".ob-step-bar")).toHaveLength(7);
    cleanup();

    useAppStore.setState({ config: { ...baseConfig, accounts: { work: account } } });
    const single = render(<Onboarding onClose={onClose} />);
    expect(single.container.querySelectorAll(".ob-step-bar")).toHaveLength(6);
  });

  it("語言切換掛在歡迎頁，離開歡迎頁後不再出現", async () => {
    const ui = render(<Onboarding onClose={onClose} />);
    expect(ui.container.querySelector(".ob-lang")).toBeTruthy();

    ui.getByText(zh.welcome.cta).click();
    await waitFor(() => expect(ui.getByText(zh.roots.h)).toBeTruthy());
    expect(ui.container.querySelector(".ob-lang")).toBeNull();
  });
});

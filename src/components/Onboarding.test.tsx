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
  fetchSetupStatus: vi.fn(async () => []), // 環境頁掛 EnvCard 後會偵測；外殼測試不碰網路
  // 共通設置頁掛 CommonConfigCard 後會探帳號目錄並預覽；同樣不碰網路
  checkDir: vi.fn(async () => "dir" as const),
  commonConfigPlan: vi.fn(async () => ({ source_dir: "/Users/x/.claude", operations: [] })),
  // 系統設置頁掛 SystemSettingsCard → TemplateCard 後會抓範本清單；外殼測試同樣不碰網路
  fetchTemplates: vi.fn(async () => []),
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
      loadConfig: async () => {}, // 預設：後端對帳結果與快照一致（仍未落檔）
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

  // store 的 completeOnboarding 是兩步：onboard 落檔（不可逆）→ loadProjects。後半失敗會讓整個
  // await reject，但設定檔已經寫進去了——誤判成未落檔的話，使用者再按一次只會撞 409 死循環。
  it("onboard 已落檔、專案重載才失敗：訊息據實以告，再按不重打 onboard", async () => {
    useAppStore.setState({
      completeOnboarding: async () => {
        onboardCalls += 1;
        useAppStore.setState({ config: { ...baseConfig, is_first_run: false } }); // 落檔已生效
        throw new Error("fetchProjects failed: 500");
      },
    });
    const ui = render(<Onboarding onClose={onClose} />);
    await reachRootsWithDraft(ui);

    ui.getByText(zh.roots.next).click();

    // 停在根目錄頁但已認得落檔：錯誤文案不得說「設定寫入失敗」
    await waitFor(() => expect(ui.getByText(zh.roots.created)).toBeTruthy());
    expect(ui.container.textContent).toContain("fetchProjects failed: 500");
    expect(ui.queryByText(/設定寫入失敗/)).toBeNull();

    ui.getByText(zh.common.next).click(); // 主按鈕已轉為單純前進
    await waitFor(() => expect(ui.getByText(zh.env.h)).toBeTruthy());
    expect(onboardCalls).toBe(1);
  });

  // onboard() 是 resp.ok 之後才 resp.json()：body 截斷／sidecar 在 config.save() 後斷線，都會讓
  // 「已落檔」這個事實根本沒進 store 快照。落檔與否只有後端說了算，快照推斷不出來。
  it("onboard 回應解析失敗但後端已落檔：向後端對帳後不重打 onboard", async () => {
    useAppStore.setState({
      completeOnboarding: async () => {
        onboardCalls += 1;
        throw new Error("Unexpected end of JSON input"); // 落檔已發生，config 卻沒更新
      },
      loadConfig: async () => {
        useAppStore.setState({ config: { ...baseConfig, is_first_run: false } }); // 後端：檔案在
      },
    });
    const ui = render(<Onboarding onClose={onClose} />);
    await reachRootsWithDraft(ui);

    ui.getByText(zh.roots.next).click();

    await waitFor(() => expect(ui.getByText(zh.roots.created)).toBeTruthy());
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.env.h)).toBeTruthy());
    expect(onboardCalls).toBe(1);
  });

  it("對帳本身也失敗（sidecar 不可用）：維持未落檔，不擅自前進", async () => {
    useAppStore.setState({
      completeOnboarding: async () => {
        onboardCalls += 1;
        throw new Error("Failed to fetch");
      },
      loadConfig: async () => {
        throw new Error("Failed to fetch"); // 後端問不到 → 狀態不明時採保守解
      },
    });
    const ui = render(<Onboarding onClose={onClose} />);
    await reachRootsWithDraft(ui);

    ui.getByText(zh.roots.next).click();

    await waitFor(() => expect(ui.getByText(/設定寫入失敗/)).toBeTruthy());
    expect(ui.getByText(zh.roots.next)).toBeTruthy(); // 主按鈕仍是「建立設定並繼續」
  });

  it("onboard 本身失敗（config 未更新）：仍視為未落檔，可重試", async () => {
    useAppStore.setState({
      completeOnboarding: async () => {
        onboardCalls += 1;
        throw new Error("onboard failed: 400"); // config 未被 set，store 仍是 is_first_run:true
      },
    });
    const ui = render(<Onboarding onClose={onClose} />);
    await reachRootsWithDraft(ui);

    ui.getByText(zh.roots.next).click();
    await waitFor(() => expect(ui.getByText(/設定寫入失敗/)).toBeTruthy());
    expect(ui.getByText(zh.roots.next)).toBeTruthy(); // 主按鈕仍是「建立設定並繼續」

    ui.getByText(zh.roots.next).click(); // 重試會真的再打一次
    await waitFor(() => expect(onboardCalls).toBe(2));
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

  it("雙帳號：登入頁的下一步進到共通設置卡", async () => {
    const ui = render(<Onboarding onClose={onClose} />);
    await reachRootsWithDraft(ui);

    ui.getByText(zh.roots.next).click();
    await waitFor(() => expect(ui.getByText(zh.env.h)).toBeTruthy());
    ui.getByText(zh.common.next).click(); // 環境 → 登入
    await waitFor(() => expect(ui.getByText(zh.login.h)).toBeTruthy());
    ui.getByText(zh.common.next).click(); // 登入 → 共通設置

    await waitFor(() => expect(ui.getByText(zh.cc.h)).toBeTruthy());
    expect(ui.queryByText(zh.sys.h)).toBeNull();
  });

  // 重跑引導（票 29 的入口）：設定檔已存在時進精靈。`draftRoots` 是「這一次新加的」，重跑時
  // 必然是空的——拿它當清單來源與按鈕條件，會讓根目錄頁變成「設定檔已建立」配一張空清單，
  // 且「下一步」永遠停用＝精靈卡在第二頁，後面五頁全部到不了（2026-07-27 驗收實測）
  it("重跑引導：根目錄頁列出設定檔既有的根目錄，下一步可以往前走", async () => {
    useAppStore.setState({
      config: {
        ...baseConfig,
        is_first_run: false,
        roots: [{ path: "/Users/x/work", default_account: "work" }],
      },
      projects: [
        { name: "a", path: "/Users/x/work/a", account: "work", source: "root", root: "/Users/x/work", recent: null },
        { name: "b", path: "/Users/x/work/b", account: "work", source: "root", root: "/Users/x/work", recent: null },
      ],
    });
    const ui = render(<Onboarding onClose={onClose} />);
    ui.getByText(zh.welcome.cta).click();
    await waitFor(() => expect(ui.getByText(zh.roots.h)).toBeTruthy());

    expect(ui.getByText(zh.roots.created)).toBeTruthy();
    const row = ui.getByText("/Users/x/work").closest(".ob-row")!;
    expect(row.textContent).toContain("2"); // 專案數取自已載入的專案，不用再掃一次

    const next = ui.getByText(zh.common.next) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);

    await waitFor(() => expect(ui.getByText(zh.env.h)).toBeTruthy());
    expect(onboardCalls).toBe(0); // 重跑不得再打 onboard（first-run only，會撞 409）
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

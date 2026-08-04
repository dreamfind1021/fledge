// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import { useAppStore } from "../store/useAppStore";
import { scanPreview, runInstall, fetchBundleInfo, RestoreError } from "../lib/sidecar";
import { Onboarding } from "./Onboarding";

vi.mock("../lib/dialog", () => ({ pickDirectory: vi.fn(), pickFile: vi.fn() }));
// 備份包頁自己的行為在 `BundleCard.test.tsx`；這裡測的是**精靈的導覽**，所以只保留
// 「回報包資訊」這個對外介面——`paths` 頁的去留與能不能離開 bundle 頁都綁在它上面。
vi.mock("./BundleCard", async () => {
  // vi.mock 會被 hoist 到 import 之前，工廠裡不能引用頂部的 `zh`（尚未初始化）
  const catalog = (await import("../locales/zh-TW/onboarding.json")).default;
  const info = { host: "old", created: "x", accounts: ["work"], extra: [], project_count: 0 };
  type Sel = { gen: number; bundlePath: string | null; plan: unknown; probe: unknown };
  return {
    EMPTY_BUNDLE_SELECTION: { gen: 0, bundlePath: null, plan: null, probe: { kind: "unknown" } },
    BundleCard: ({ selection, onSelection }: {
      selection: Sel; onSelection: (s: Sel) => void;
    }) => {
      const probe = (p: unknown) => onSelection({
        ...selection, gen: selection.gen + 1, bundlePath: "/tmp/picked.tar.gz", probe: p,
      });
      return (
        <div>
          <h2>{catalog.mig.bundle.h}</h2>
          {/* 選包狀態住在精靈：卡片卸載再掛回來，這一格必須還在 */}
          <span data-testid="picked">{selection.bundlePath ?? "no-bundle"}</span>
          <button onClick={() => probe({ kind: "present", info: { ...info, project_count: 9 }, dest: "/d" })}>
            probe-present
          </button>
          <button onClick={() => probe({ kind: "absent", info, dest: "/d" })}>probe-absent</button>
        </div>
      );
    },
  };
});
vi.mock("./TargetsCard", async () => {
  const catalog = (await import("../locales/zh-TW/onboarding.json")).default;
  return {
    TargetsCard: ({ dest, saved, onSaved }: {
      dest: string; saved: boolean;
      onSaved: (c: { dest: string; accounts: { key: string; config_dir: string }[] })
        => void | Promise<void>;
    }) => (
      <div>
        <h2>{catalog.mig.targets.h}</h2>
        <span data-testid="targets-dest">{dest}</span>
        {/* 真卡片的形狀：`adopt-config` 只會成功一次（`create_if_absent`），收尾失敗時
            重按**只重跑 `onSaved()`**、不再 POST。mock 保留這個形狀，否則父層測試會在
            一條真實流程走不到的路徑上變綠（Codex 票 03 R2 指出的假綠） */}
        <button
          onClick={() => void Promise.resolve(onSaved({
            // 與 `baseConfig.accounts` 一致：父層會拿讀回來的 config 跟這一組對帳
            // （Codex 票 03 R4 F1），對不上就不放行
            dest,
            accounts: [
              { key: "work", config_dir: "~/.claude" },
              { key: "personal", config_dir: "~/.claude" },
            ],
          })).catch(() => {})}
          disabled={saved}
        >
          adopt
        </button>
      </div>
    ),
  };
});
vi.mock("./PathsCard", async () => {
  const catalog = (await import("../locales/zh-TW/onboarding.json")).default;
  return {
    PathsCard: ({ dest, projectCount, sourceGen, mapping, onMapping, onStatus }: {
      dest: string; projectCount: number; sourceGen: number;
      mapping: Record<string, string>; onMapping: (m: Record<string, string>) => void;
      onStatus: (s: string) => void;
    }) => (
      <div>
        <h2>{catalog.mig.paths.h}</h2>
        <span data-testid="paths-dest">{dest}</span>
        <span data-testid="paths-count">{projectCount}</span>
        <span data-testid="paths-gen">{sourceGen}</span>
        <span data-testid="paths-mapping">{JSON.stringify(mapping)}</span>
        <button onClick={() => onMapping({ "/old/a": "/new/a" })}>map</button>
        <button onClick={() => onStatus("loaded")}>paths-loaded</button>
        <button onClick={() => onStatus("error")}>paths-error</button>
      </div>
    ),
  };
});
vi.mock("./InstallPreviewCard", async () => {
  const catalog = (await import("../locales/zh-TW/onboarding.json")).default;
  return {
    InstallPreviewCard: ({ dest, sourceGen, mapping, onStatus }: {
      dest: string; sourceGen: number; mapping: Record<string, string>;
      onStatus: (s: string) => void;
    }) => (
      <div>
        <h2>{catalog.mig.install.h}</h2>
        <span data-testid="preview-dest">{dest}</span>
        <span data-testid="preview-gen">{sourceGen}</span>
        <span data-testid="preview-mapping">{JSON.stringify(mapping)}</span>
        <button onClick={() => onStatus("loaded")}>preview-loaded</button>
        <button onClick={() => onStatus("error")}>preview-error</button>
      </div>
    ),
  };
});
vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  scanPreview: vi.fn(async (_port: number, path: string) => ({ path, count: 3, status: "ok" as const })),
  fetchSetupStatus: vi.fn(async () => []), // 環境頁掛 EnvCard 後會偵測；外殼測試不碰網路
  // 共通設置頁掛 CommonConfigCard 後會探帳號目錄並預覽；同樣不碰網路
  checkDir: vi.fn(async () => "dir" as const),
  commonConfigPlan: vi.fn(async () => ({ source_dir: "/Users/x/.claude", operations: [] })),
  // 系統設置頁掛 SystemSettingsCard → TemplateCard 後會抓範本清單；外殼測試同樣不碰網路
  fetchTemplates: vi.fn(async () => []),
  // 移機的安裝（票 06）：**唯一會寫使用者現役目錄的呼叫**，測試絕不讓它真的發出去
  runInstall: vi.fn(async () => ({ results: [], stale_temps: [] })),
  // 續作（票 07）：精靈直接進安裝頁之前要先確認那份展開的包還讀得出來
  fetchBundleInfo: vi.fn(async () => ({
    host: "old", created: "x", accounts: ["work"], extra: [], project_count: 2,
  })),
}));
// 結果頁的殘骸行會用到 opener（真元件，不 mock 掉——它的顯示契約才是這裡要驗的）
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(async () => {}),
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
  ui.getByText(zh.welcome.fresh).click();
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
    vi.clearAllMocks();     // 呼叫記錄逐條歸零（實作保留）——安裝那組會數呼叫次數
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

  // 試掃失敗是本次唯一沒有行為測試的洩漏路徑（Codex R2 Medium）。catalog 那條 parity 測試
  // 只擋 `{{reason}}` 這個插值位置，擋不住呼叫端直接 `setError(String(e))` 或換個插值名——
  // 每條失敗路徑都要有自己的哨兵斷言
  it("試掃失敗：顯示通用訊息，例外原文不進畫面", async () => {
    vi.mocked(scanPreview).mockRejectedValueOnce(new Error("SCAN-SENTINEL-500"));
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.fresh).click();
    await waitFor(() => expect(ui.getByText(zh.roots.h)).toBeTruthy());
    fireEvent.change(ui.getByPlaceholderText(zh.roots.placeholder), { target: { value: "/tmp/work" } });
    ui.getByText(zh.roots.add).click();

    await waitFor(() => expect(ui.getByText(zh.errors.scan_failed)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("SCAN-SENTINEL-500");
  });

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
    expect(ui.container.textContent).toContain(zh.errors.projects_reload_failed);
    expect(ui.container.textContent).not.toContain("fetchProjects failed: 500"); // 原文只進 console
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
    ui.getByText(zh.welcome.fresh).click();
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

  it("歡迎頁是二選一：全新設定或我有備份", () => {
    const ui = render(<Onboarding onClose={onClose} />);
    expect(ui.getByText(zh.welcome.fresh)).toBeTruthy();
    expect(ui.getByText(zh.welcome.restore)).toBeTruthy();
  });

  // 移機分支的第二頁是選備份包，不是「設定工作根目錄」——兩條路從歡迎頁之後就分岔
  it("選「我有備份」後進到備份包頁，不是全新設定的根目錄頁", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();

    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    expect(ui.queryByText(zh.roots.h)).toBeNull();
  });

  // 骨架的驗收條件：九頁一頁一頁走得過去，且移機分支不經共通設置與範本部署——那兩頁是給
  // 新使用者鋪底的，東西都跟著備份搬回來的人不需要（上游 spec §5.1）
  // 票 02 的 gating：包還沒展開（`unknown`）就往下走，後面每一頁都沒有資料可依據——
  // 落點頁要列的帳號、`paths` 頁在不在，全都來自這一包
  it("包資訊還不知道時走不出備份包頁", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());

    expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(true);
    expect(ui.getByText(zh.mig.bundle.needInfo)).toBeTruthy();
    ui.getByText(zh.common.next).click();
    expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy();      // 還在同一頁
  });

  // 包裡沒有專案歷史 → `paths` 整頁不出現（不是顯示「不適用」，比照 common 的降級）
  it("包裡沒有專案歷史時，路徑對應頁整頁不出現", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-absent").click();

    await waitFor(() => expect(ui.container.querySelectorAll(".ob-step-bar")).toHaveLength(8));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText("adopt").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.install.h)).toBeTruthy());
    expect(ui.queryByText(zh.mig.paths.h)).toBeNull();
  });

  // 票 03：落點頁的落檔是**不可逆**的（建立設定檔），確認之前不讓精靈往下走——後面的
  // 預覽與安裝都從落檔後的 config.json 讀落點
  it("落點還沒確認就走不出落點頁；落檔後才放行", async () => {
    useAppStore.setState({ config: { ...baseConfig, is_first_run: true } });
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());

    // 落點頁拿到的是上一頁那一包的展開位置，不是別的
    expect(ui.getByTestId("targets-dest").textContent).toBe("/d");
    expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(true);

    ui.getByText("adopt").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
  });

  // Codex 票 03 R1 F2：落檔只翻旗標不夠——後面的頁面（登入卡等）讀的是 store 裡的
  // accounts，不把剛建立的 config 讀回來，使用者會看到 in-memory 的預設帳號
  // 這裡測的是**父層的職責**：收尾被呼叫時刷新 store、失敗就不放行。卡片那側「重試不
  // 重複 POST」的狀態機在 `TargetsCard.test.tsx`（R2 F1）。
  it("落點落檔後把新設定讀回 store，讀不回來就不放行", async () => {
    let loads = 0;
    let failNext = true;
    useAppStore.setState({
      config: { ...baseConfig, is_first_run: true },
      loadConfig: async () => {
        loads += 1;
        if (failNext) {
          failNext = false;
          throw new Error("RELOAD-SENTINEL");
        }
        useAppStore.setState({ config: { ...baseConfig, is_first_run: false } });
      },
    });
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());

    ui.getByText("adopt").click();          // 第一次：刷新失敗
    await waitFor(() => expect(loads).toBe(1));
    expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(true);

    ui.getByText("adopt").click();          // 第二次：刷新成功才放行
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    expect(loads).toBe(2);
  });

  // 票 04：這一頁不寫任何東西，對應關係住在精靈——走到下一頁再回來必須還在，
  // 而且它要能一路帶到 install 頁（票 05 用它算預覽）
  it("專案對應住在精靈：離開這一頁再回來還在，且拿得到這一包的專案數", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText("adopt").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());

    // 展開位置與專案數都來自上一頁確認過的那一包
    expect(ui.getByTestId("paths-dest").textContent).toBe("/d");
    expect(ui.getByTestId("paths-count").textContent).toBe("9");

    ui.getByText("map").click();
    await waitFor(() => expect(ui.getByTestId("paths-mapping").textContent)
      .toBe(JSON.stringify({ "/old/a": "/new/a" })));

    ui.getByText("paths-loaded").click();                  // 清單讀到了才放行
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();                  // 走到安裝頁
    await waitFor(() => expect(ui.getByText(zh.mig.install.h)).toBeTruthy());
    ui.getByText(zh.common.prev).click();                  // 再回來
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());
    expect(ui.getByTestId("paths-mapping").textContent)
      .toBe(JSON.stringify({ "/old/a": "/new/a" }));
  });

  // Codex 票 04 R1 F1：mapping 只初始化一次，換包後舊的對應會被當成新包的 seed——
  // 舊 key 不屬於新包，送進 plan 是 `mapping_unknown_project`；兩包剛好有同一條舊路徑
  // 時更糟：上一包的人工選擇會靜靜套到新包上
  it("換一包 → 專案對應清空重來", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText("adopt").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());
    ui.getByText("map").click();
    await waitFor(() => expect(ui.getByTestId("paths-mapping").textContent).toContain("/old/a"));

    // 回備份包頁換一包（mock 的 probe 每次都遞增 gen）
    ui.getByText(zh.common.prev).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText(zh.common.prev).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());

    expect(ui.getByTestId("paths-mapping").textContent).toBe("{}");
  });

  // Codex 票 04 R1 F3：讀取失敗還放行 → 使用者在看不到任何專案、也沒有對應的情況下繼續，
  // install 把所有歷史原樣搬過去、`/resume` 全部列不出來。那不是他選的「留空即照搬」
  it("專案清單讀不出來時擋住下一步（包裡確實有專案）", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText("adopt").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());

    ui.getByText("paths-error").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(true));
    ui.getByText("paths-loaded").click();          // 重試成功後才放行
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
  });

  // 票 05：預覽是不可逆操作前的最後一道人工確認——算不出來就不該讓使用者往下走
  it("預覽算不出來時擋住下一步，而且拿得到這一頁帶來的對應", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText("adopt").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());
    ui.getByText("map").click();
    ui.getByText("paths-loaded").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.install.h)).toBeTruthy());

    // 預覽拿到的是上一頁填的對應與這一包的展開位置
    expect(ui.getByTestId("preview-mapping").textContent)
      .toBe(JSON.stringify({ "/old/a": "/new/a" }));
    expect(ui.getByTestId("preview-dest").textContent).toBe("/d");

    // 票 06 起這一頁的主按鈕是「開始安裝」（裝完才變成下一步）——算不出預覽時
    // 擋住的就是那顆，語意比原本更嚴：連不可逆的動作都按不下去
    ui.getByText("preview-error").click();
    await waitFor(() =>
      expect(ui.getByText(zh.mig.install.run).closest("button")!.disabled).toBe(true));
    ui.getByText("preview-loaded").click();
    await waitFor(() =>
      expect(ui.getByText(zh.mig.install.run).closest("button")!.disabled).toBe(false));
  });

  // Codex 票 04 R2：`pathsStatus` 沒跟著 `bundle.gen` 失效的話，換包之後 gating 會先看到
  // 上一包的 `loaded`——在新包的清單根本還沒讀之前就放行
  it("換一包之後，上一包的「清單已讀到」不算數", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText("adopt").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());
    ui.getByText("paths-loaded").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));

    // 回備份包頁換一包（mock 每次 probe 都遞增 gen）
    ui.getByText(zh.common.prev).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText(zh.common.prev).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());

    // 新包的清單還沒讀到 → 擋住
    expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(true);
  });

  // Codex 票 03 R4 F1：409 只證明「有一份 config」。後續 install 直接從那份 config 取
  // 目的地，沿用一份無關的設定＝把備份內容寫進使用者沒確認過的現役目錄。
  it("讀回來的設定與剛確認的落點對不上 → 不放行", async () => {
    useAppStore.setState({
      config: { ...baseConfig, is_first_run: true },
      loadConfig: async () => {
        // 後端其實有一份**別的** config（不是這次建立的）
        useAppStore.setState({
          config: {
            ...baseConfig, is_first_run: false,
            accounts: { stranger: { config_dir: "/somewhere/else", label: "" } },
          },
        });
      },
    });
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());

    ui.getByText("adopt").click();
    // 對帳不符 → 收尾 throw → 精靈不放行
    await waitFor(() => expect(useAppStore.getState().config?.accounts).toHaveProperty("stranger"));
    expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(true);
  });

  // Codex 票 02 R1 F2：包資訊與「選了哪一包」原本分居兩處（前者在精靈、後者在卡片），
  // 卡片一卸載選包狀態就沒了、摘要卻還在。三者一起提升到精靈之後，離開再回來看到的
  // 是**同一組**狀態——摘要與它描述的那一包始終對得上。
  it("離開備份包頁再回來：選包狀態與包資訊一起留著，不會只剩半邊", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    expect(ui.getByTestId("picked").textContent).toBe("no-bundle");
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));

    ui.getByText(zh.common.next).click();                 // 走到落點頁（卡片卸載）
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText(zh.common.prev).click();                 // 回來（卡片重新掛載）
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());

    expect(ui.getByTestId("picked").textContent).toBe("/tmp/picked.tar.gz");
    expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false);
  });

  // 同一條的另一半：回到歡迎頁再選一次「我有備份」。**保留**是正確的——選包路徑、展開
  // 位置與摘要是完整的一組，展開目錄也還在磁碟上，使用者不必重選。要擋的是「只剩摘要、
  // 沒有包」那種半邊狀態，而那已由狀態提升消滅。
  it("回歡迎頁再進移機：整組狀態一致地留著，不是只剩摘要", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));

    ui.getByText(zh.common.prev).click();                 // 回歡迎頁
    await waitFor(() => expect(ui.getByText(zh.welcome.restore)).toBeTruthy());
    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());

    expect(ui.getByTestId("picked").textContent).toBe("/tmp/picked.tar.gz");
  });

  // 票 01 F1 的整合層守護：導覽 state 存的是**頁面身分**不是索引。從 `install` 回頭換一包、
  // 新的一包沒有專案歷史 → 序列少一頁，此時若存的是索引，同一個數字會把使用者丟到別頁。
  it("從安裝頁回頭換包、序列因此縮短時，使用者仍停在備份包頁", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    // 等 gating 解除再走：同一個 tick 內按鈕還是 disabled，click 不會有任何作用
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    // 每步之間要等——連續 click 在同一個 tick 內用的是同一份閉包，只會前進一頁
    for (const heading of [zh.mig.targets.h, zh.mig.paths.h, zh.mig.install.h]) {
      ui.getByText(zh.common.next).click();
      await waitFor(() => expect(ui.getByText(heading)).toBeTruthy());
      if (heading === zh.mig.targets.h) {
        ui.getByText("adopt").click();
        await waitFor(() =>
          expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
      }
      if (heading === zh.mig.paths.h) {
        ui.getByText("paths-loaded").click();
        await waitFor(() =>
          expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
      }
    }
    for (const heading of [zh.mig.paths.h, zh.mig.targets.h, zh.mig.bundle.h]) {
      ui.getByText(zh.common.prev).click();
      await waitFor(() => expect(ui.getByText(heading)).toBeTruthy());
    }
    ui.getByText("probe-absent").click();        // 新的一包沒有專案歷史 → `paths` 頁消失

    await waitFor(() => expect(ui.container.querySelectorAll(".ob-step-bar")).toHaveLength(8));
    expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy();
    expect(ui.queryByText(zh.mig.targets.h)).toBeNull();
  });

  it("移機分支一路走到完成頁，全程不出現共通設置與範本部署", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();       // 有專案歷史＝完整九頁序列
    for (const heading of [
      zh.mig.bundle.h,
      zh.mig.targets.h,
      zh.mig.paths.h,
      zh.mig.install.h,
      zh.env.h,
      zh.login.h,
      zh.mig.repair.h,
    ]) {
      await waitFor(() => expect(ui.getByText(heading)).toBeTruthy());
      expect(ui.queryByText(zh.cc.h)).toBeNull();
      expect(ui.queryByText(zh.sys.h)).toBeNull();
      // 落點頁的落檔是往下走的前提（票 03）：不落檔就過不去，這一步不是裝飾
      if (heading === zh.mig.targets.h) {
        ui.getByText("adopt").click();
        await waitFor(() =>
          expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
      }
      // 專案清單讀到了才放行（票 04 R1 F3），同樣不是裝飾
      if (heading === zh.mig.paths.h) {
        ui.getByText("paths-loaded").click();
        await waitFor(() =>
          expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
      }
      // 安裝頁同理：算不出預覽就按不下安裝（票 05）；而**裝完才有下一步**（票 06）
      if (heading === zh.mig.install.h) {
        ui.getByText("preview-loaded").click();
        await waitFor(() =>
          expect(ui.getByText(zh.mig.install.run).closest("button")!.disabled).toBe(false));
        ui.getByText(zh.mig.install.run).click();
        await waitFor(() => expect(ui.getByText(zh.mig.result.h)).toBeTruthy());
      }
      ui.getByText(zh.common.next).click();
    }

    await waitFor(() => expect(ui.getByText(zh.done.h)).toBeTruthy());
    expect(onboardCalls).toBe(0); // 移機的落檔走 adopt-config（票 03），不是 onboard
  });

  // ── 安裝的執行與結果（票 06） ───────────────────────────────────────────────
  //
  // 這是整條移機流程裡唯一會寫使用者現役目錄的一步，所以三件事要在整合層釘住：
  // 呼叫帶的是這一包的展開位置與這一頁的對應、執行中不可離開也不可重複送出、
  // 結果（含殘骸告知）真的顯示出來。

  /** 走到安裝頁並讓預覽就緒（gating 解除）。 */
  async function reachInstallPage(ui: ReturnType<typeof render>) {
    ui.getByText(zh.welcome.restore).click();
    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    ui.getByText("probe-present").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    ui.getByText("adopt").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.h)).toBeTruthy());
    ui.getByText("map").click();
    ui.getByText("paths-loaded").click();
    await waitFor(() =>
      expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.install.h)).toBeTruthy());
    ui.getByText("preview-loaded").click();
    await waitFor(() =>
      expect(ui.getByText(zh.mig.install.run).closest("button")!.disabled).toBe(false));
  }

  it("按下安裝：帶這一包的展開位置與這一頁的對應去打端點", async () => {
    const ui = render(<Onboarding onClose={onClose} />);
    await reachInstallPage(ui);

    ui.getByText(zh.mig.install.run).click();

    await waitFor(() => expect(runInstall)
      .toHaveBeenCalledWith(1234, "/d", { "/old/a": "/new/a" }));
  });

  // 預覽算不出來就不該讓使用者按下不可逆的安裝（與票 04／05 同一條理由）
  it("預覽還沒就緒時按不下安裝", async () => {
    const ui = render(<Onboarding onClose={onClose} />);
    await reachInstallPage(ui);

    ui.getByText("preview-error").click();
    await waitFor(() =>
      expect(ui.getByText(zh.mig.install.run).closest("button")!.disabled).toBe(true));
  });

  // 票面：不可逆操作，安裝中不可離開或重複送出
  it("安裝中：按鈕與上一步都鎖住，端點只被打一次", async () => {
    let release: (o: { results: []; stale_temps: [] }) => void = () => {};
    vi.mocked(runInstall).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }));
    const ui = render(<Onboarding onClose={onClose} />);
    await reachInstallPage(ui);

    ui.getByText(zh.mig.install.run).click();
    await waitFor(() => expect(ui.getByText(zh.mig.install.running)).toBeTruthy());

    // 重複送出：按鈕已 disabled，再點也不會有第二次呼叫
    ui.getByText(zh.mig.install.running).click();
    expect(ui.getByText(zh.mig.install.running).closest("button")!.disabled).toBe(true);
    // 離開：上一步同樣鎖住——寫入進行中換頁會讓使用者以為可以中止
    expect(ui.getByText(zh.common.prev).closest("button")!.disabled).toBe(true);
    expect(runInstall).toHaveBeenCalledTimes(1);

    release({ results: [], stale_temps: [] });
    await waitFor(() => expect(ui.getByText(zh.mig.result.h)).toBeTruthy());
  });

  it("裝完顯示逐項結果與殘骸告知，預覽頁收起來", async () => {
    vi.mocked(runInstall).mockResolvedValueOnce({
      results: [
        { account: "work", rel_path: "CLAUDE.md", outcome: "installed", error: null },
        { account: "work", rel_path: "skills/b.md", outcome: "failed",
          error: "permission_denied" },
      ],
      stale_temps: ["/Users/me/.claude/.fledge-install-1-aaaa"],
    });
    const ui = render(<Onboarding onClose={onClose} />);
    await reachInstallPage(ui);

    ui.getByText(zh.mig.install.run).click();

    await waitFor(() => expect(ui.getByText(zh.mig.result.h)).toBeTruthy());
    expect(ui.queryByTestId("preview-dest")).toBeNull();      // 預覽已由結果取代
    expect(ui.getByText(zh.mig.result.failed)).toBeTruthy();
    expect(ui.getByText(
      zh.mig.result.itemReason
        .replace("{{path}}", "work/skills/b.md")
        .replace("{{reason}}", zh.mig.result.reason.permission_denied))).toBeTruthy();
    expect(ui.getByText(zh.mig.result.stale.h.replace("{{count}}", "1"))).toBeTruthy();
    // 裝完才放行往下走（在那之前主按鈕是「開始安裝」）
    expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false);
  });

  // 後端明確拒絕（帶判別碼）＝請求在動手之前就被擋下：可以斷言什麼都沒發生
  it("後端明確拒絕：說清楚一個檔案都沒動，例外原文不進畫面，可以再試一次", async () => {
    vi.mocked(runInstall).mockRejectedValueOnce(
      new RestoreError("config_not_initialized", 400));
    const ui = render(<Onboarding onClose={onClose} />);
    await reachInstallPage(ui);

    ui.getByText(zh.mig.install.run).click();

    await waitFor(() =>
      expect(ui.getByText(zh.mig.install.errors.installFailed)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("config_not_initialized");
    expect(ui.queryByText(zh.mig.result.h)).toBeNull();       // 沒有結果可報
    // 失敗回到可再送出的狀態——不留在鎖死的「安裝中」
    expect(ui.getByText(zh.mig.install.run).closest("button")!.disabled).toBe(false);
  });

  // Codex 票 06 R1（high）：拿不到判別碼＝**不知道後端做到哪裡**。sidecar 可能已經完整
  // 跑完、只是答案沒回來——此時說「安裝沒能完成」是在斷言一件我們不知道的事，使用者會
  // 以為東西沒搬。這條釘住兩件事：文案不斷言，而且重送之後拿得到真正的結果
  it("回應遺失（拿不到判別碼）：不謊稱沒動過，重送之後看得到已經在那裡的東西", async () => {
    vi.mocked(runInstall).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const ui = render(<Onboarding onClose={onClose} />);
    await reachInstallPage(ui);

    ui.getByText(zh.mig.install.run).click();

    await waitFor(() =>
      expect(ui.getByText(zh.mig.install.errors.installUnknown)).toBeTruthy());
    expect(ui.queryByText(zh.mig.install.errors.installFailed)).toBeNull();

    // 重送：後端這次答得出來——第一輪其實寫進去了，所以全是 skipped
    vi.mocked(runInstall).mockResolvedValueOnce({
      results: [{ account: "work", rel_path: "CLAUDE.md", outcome: "skipped", error: null }],
      stale_temps: [],
    });
    ui.getByText(zh.mig.install.run).click();

    await waitFor(() => expect(ui.getByText(zh.mig.result.h)).toBeTruthy());
    // 「那個位置已經有東西，一律不覆蓋」＝使用者唯一能拿到的「東西確實在那裡」的證據
    expect(ui.getByText(zh.mig.result.skipped)).toBeTruthy();
  });

  // 結果是「對某一包做的」：換一包之後那份報告不屬於新的包，留著會讓使用者以為新包也裝過了
  it("裝完再換一包 → 結果作廢，回到預覽態", async () => {
    const ui = render(<Onboarding onClose={onClose} />);
    await reachInstallPage(ui);
    ui.getByText(zh.mig.install.run).click();
    await waitFor(() => expect(ui.getByText(zh.mig.result.h)).toBeTruthy());

    for (const heading of [zh.mig.paths.h, zh.mig.targets.h, zh.mig.bundle.h]) {
      ui.getByText(zh.common.prev).click();
      await waitFor(() => expect(ui.getByText(heading)).toBeTruthy());
    }
    ui.getByText("probe-present").click();                    // 換一包（gen 前進）
    for (const heading of [zh.mig.targets.h, zh.mig.paths.h, zh.mig.install.h]) {
      ui.getByText(zh.common.next).click();
      await waitFor(() => expect(ui.getByText(heading)).toBeTruthy());
      if (heading === zh.mig.paths.h) {
        ui.getByText("paths-loaded").click();
        await waitFor(() =>
          expect(ui.getByText(zh.common.next).closest("button")!.disabled).toBe(false));
      }
    }
    expect(ui.queryByText(zh.mig.result.h)).toBeNull();
    expect(ui.getByText(zh.mig.install.run)).toBeTruthy();
  });

  it("進度條格數跟著路線：移機九格", async () => {
    const ui = render(<Onboarding onClose={onClose} />);

    ui.getByText(zh.welcome.restore).click();

    await waitFor(() => expect(ui.getByText(zh.mig.bundle.h)).toBeTruthy());
    expect(ui.container.querySelectorAll(".ob-step-bar")).toHaveLength(9);
  });

  it("語言切換掛在歡迎頁，離開歡迎頁後不再出現", async () => {
    const ui = render(<Onboarding onClose={onClose} />);
    expect(ui.container.querySelector(".ob-lang")).toBeTruthy();

    ui.getByText(zh.welcome.fresh).click();
    await waitFor(() => expect(ui.getByText(zh.roots.h)).toBeTruthy());
    expect(ui.container.querySelector(".ob-lang")).toBeNull();
  });
});

// ── 中斷續作（票 07）：從還原卡按「繼續移機」直接進安裝頁 ────────────────────

describe("Onboarding 的移機續作", () => {
  const RESUME = {
    sourceRoot: "/home/me/.claude-restore-20260727-1432",
    mapping: [{ old: "/old/a", new: "/new/a" }],
  };

  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    useAppStore.setState({
      port: 1234,
      config: { ...baseConfig, is_first_run: false },   // 續作的前提：設定檔早已落檔
      completeOnboarding: async () => {},
      loadConfig: async () => {},
    });
  });
  afterEach(cleanup);

  it("一進來就在安裝頁，不是歡迎頁", async () => {
    const ui = render(<Onboarding onClose={() => {}} resume={RESUME} />);
    await waitFor(() => expect(ui.getByTestId("preview-dest")).toBeTruthy());
    expect(ui.queryByText(zh.welcome.h)).toBeNull();
  });

  // 這兩樣是續作的全部意義：使用者上次填的東西不必再填一次
  it("預填上次的展開位置與專案路徑對應", async () => {
    const ui = render(<Onboarding onClose={() => {}} resume={RESUME} />);
    await waitFor(() =>
      expect(ui.getByTestId("preview-dest").textContent).toBe(RESUME.sourceRoot));
    expect(ui.getByTestId("preview-mapping").textContent)
      .toBe(JSON.stringify({ "/old/a": "/new/a" }));
    expect(fetchBundleInfo).toHaveBeenCalledWith(1234, RESUME.sourceRoot);
  });

  // **預填的對應不能被「換包就清空」的機制洗掉**（票 04 的 gen 綁定）：續作不是換包，
  // 來源從一開始就是這一個。這條測試守的正是那個交互作用
  it("讀到包資訊之後，預填的對應仍在", async () => {
    let release: (info: unknown) => void = () => {};
    vi.mocked(fetchBundleInfo).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }) as never);
    const ui = render(<Onboarding onClose={() => {}} resume={RESUME} />);

    release({ host: "old", created: "x", accounts: ["work"], extra: [], project_count: 2 });

    await waitFor(() => expect(ui.getByTestId("preview-mapping").textContent)
      .toBe(JSON.stringify({ "/old/a": "/new/a" })));
  });

  // Codex 票 07 R1 F2：續作的探測**已經在飛**的時候，使用者可以回上一頁換一包——遲到的
  // 回應若照樣寫進 state，畫面上是新包、預覽與安裝卻是舊來源。這是票 02／04／05 一路守
  // 的「遲到回應不得覆蓋」同一族，續作這條路徑當初漏了套
  it("續作探測還在飛時換了一包 → 遲到的回應不得把來源換回去", async () => {
    let release: (info: unknown) => void = () => {};
    vi.mocked(fetchBundleInfo).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }) as never);
    const ui = render(<Onboarding onClose={() => {}} resume={RESUME} />);

    // 從安裝頁一路退回備份包頁（包資訊還沒到，中間兩頁是空殼）
    for (const heading of [zh.mig.paths.h, zh.mig.targets.h, zh.mig.bundle.h]) {
      ui.getByText(zh.common.prev).click();
      await waitFor(() => expect(ui.getByText(heading)).toBeTruthy());
    }
    ui.getByText("probe-present").click();          // 換一包（gen 前進、dest 變 /d）
    await waitFor(() => expect(ui.getByTestId("picked").textContent)
      .toBe("/tmp/picked.tar.gz"));

    release({ host: "old", created: "x", accounts: ["work"], extra: [], project_count: 2 });

    // 往下走一頁就看得到來源：必須是使用者剛選的那一包，不是續作帶進來的那個
    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    expect(ui.getByTestId("targets-dest").textContent).toBe("/d");
  });

  // Codex 票 07 R2：effect 依賴 port 與 t，sidecar 重啟換 port（或退回歡迎頁切語言）都會
  // 讓它重跑——那時「進場時的 gen」會重新擷取成當下的值，換過包之後的比對照樣成立
  it("換包之後 sidecar 重啟：續作探測不得重新套用", async () => {
    const ui = render(<Onboarding onClose={() => {}} resume={RESUME} />);
    await waitFor(() => expect(ui.getByTestId("preview-dest")).toBeTruthy());

    for (const heading of [zh.mig.paths.h, zh.mig.targets.h, zh.mig.bundle.h]) {
      ui.getByText(zh.common.prev).click();
      await waitFor(() => expect(ui.getByText(heading)).toBeTruthy());
    }
    ui.getByText("probe-present").click();          // 換一包（dest 變 /d）
    await waitFor(() => expect(ui.getByTestId("picked").textContent)
      .toBe("/tmp/picked.tar.gz"));
    vi.mocked(fetchBundleInfo).mockClear();

    useAppStore.setState({ port: 5678 });           // sidecar 重啟換 port

    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    expect(fetchBundleInfo).not.toHaveBeenCalled(); // 入場動作不該再跑一次
    expect(ui.getByTestId("targets-dest").textContent).toBe("/d");
  });

  // Codex 票 07 R3：R2 的一次性旗標設在請求**開始前**，sidecar 在探測途中重啟就永久取消
  // 了它——既不向新 sidecar 重試、也不顯示錯誤，續作頁永遠停在空殼。「已換包」與「還沒
  // 成功」是兩件事
  it("探測途中 sidecar 重啟：向新 port 重試，續作預覽照樣出得來", async () => {
    let release: (info: unknown) => void = () => {};
    vi.mocked(fetchBundleInfo).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }) as never);
    const ui = render(<Onboarding onClose={() => {}} resume={RESUME} />);
    await waitFor(() => expect(fetchBundleInfo).toHaveBeenCalledWith(1234, RESUME.sourceRoot));

    useAppStore.setState({ port: 5678 });        // sidecar 重啟換 port
    release({ host: "old", created: "x", accounts: ["work"], extra: [], project_count: 2 });

    await waitFor(() => expect(fetchBundleInfo)
      .toHaveBeenCalledWith(5678, RESUME.sourceRoot));
    await waitFor(() => expect(ui.getByTestId("preview-dest").textContent)
      .toBe(RESUME.sourceRoot));
  });

  // 兩個條件真正分工的那一格：**探測還沒成功**（一次性旗標還沒消費）時使用者換了包，
  // 之後 sidecar 又重啟——只看旗標的話 effect 會重跑並把舊來源套上去，因為「進場時的
  // gen」在重跑時已重新擷取成新包的 gen。mutation 抓出前面幾條的換包都發生在探測**成功
  // 之後**，被旗標擋住了，gen 比對從沒被驗到
  it("探測還沒成功就換了包，之後 sidecar 重啟也不得套用舊來源", async () => {
    vi.mocked(fetchBundleInfo).mockImplementationOnce(
      () => new Promise(() => {}) as never);        // 永遠不回來
    const ui = render(<Onboarding onClose={() => {}} resume={RESUME} />);
    await waitFor(() => expect(fetchBundleInfo).toHaveBeenCalledTimes(1));

    for (const heading of [zh.mig.paths.h, zh.mig.targets.h, zh.mig.bundle.h]) {
      ui.getByText(zh.common.prev).click();
      await waitFor(() => expect(ui.getByText(heading)).toBeTruthy());
    }
    ui.getByText("probe-present").click();          // 換一包（探測仍未成功）
    await waitFor(() => expect(ui.getByTestId("picked").textContent)
      .toBe("/tmp/picked.tar.gz"));
    vi.mocked(fetchBundleInfo).mockClear();

    useAppStore.setState({ port: 5678 });           // sidecar 重啟

    ui.getByText(zh.common.next).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.h)).toBeTruthy());
    expect(fetchBundleInfo).not.toHaveBeenCalled();  // 續作已因換包永久失效
    expect(ui.getByTestId("targets-dest").textContent).toBe("/d");
  });

  it("包資訊讀不出來：說明白，而且不讓使用者停在一份假的預覽上", async () => {
    vi.mocked(fetchBundleInfo).mockRejectedValueOnce(new Error("INFO-SENTINEL-500"));
    const ui = render(<Onboarding onClose={() => {}} resume={RESUME} />);

    await waitFor(() =>
      expect(ui.getByText(zh.mig.install.errors.resumeFailed)).toBeTruthy());
    expect(ui.queryByTestId("preview-dest")).toBeNull();
    expect(ui.container.textContent).not.toContain("INFO-SENTINEL-500");
  });

  it("沒有 resume 就照舊從歡迎頁開始", async () => {
    const ui = render(<Onboarding onClose={() => {}} />);
    expect(ui.getByText(zh.welcome.h)).toBeTruthy();
    expect(fetchBundleInfo).not.toHaveBeenCalled();
  });
});

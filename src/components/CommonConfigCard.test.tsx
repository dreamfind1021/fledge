// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import {
  SetupError,
  COMMON_CONFIG_ENTRIES,
  type CommonConfigOperation,
  type CommonConfigOpResult,
  type CommonConfigPlan,
  type CommonConfigRequest,
  type DirStatus,
} from "../lib/sidecar";
import { CommonConfigCard } from "./CommonConfigCard";

const checkDir = vi.fn<(port: number, path: string) => Promise<DirStatus>>();
const commonConfigPlan = vi.fn<(port: number, req: CommonConfigRequest) => Promise<CommonConfigPlan>>();
const commonConfigApply =
  vi.fn<(port: number, req: CommonConfigRequest & { overwrite: unknown[] }) => Promise<CommonConfigOpResult[]>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  checkDir: (port: number, path: string) => checkDir(port, path),
  commonConfigPlan: (port: number, req: CommonConfigRequest) => commonConfigPlan(port, req),
  commonConfigApply: (port: number, req: CommonConfigRequest & { overwrite: unknown[] }) =>
    commonConfigApply(port, req),
}));

const accounts = {
  work: { config_dir: "~/.claude", label: "工作" },
  personal: { config_dir: "~/.claude-tc", label: "私人" },
};

const op = (over: Partial<CommonConfigOperation> = {}): CommonConfigOperation => ({
  account: "personal",
  entry: "commands",
  target_path: "/Users/x/.claude-tc/commands",
  state: "missing",
  action: "create_link",
  needs_overwrite: false,
  ...over,
});

const result = (over: Partial<CommonConfigOpResult> = {}): CommonConfigOpResult => ({
  account: "personal",
  entry: "commands",
  outcome: "created",
  backup_path: null,
  error: null,
  ...over,
});

/** catalog 文案帶插值／`<Trans>` 標籤，textContent 比對前要先還原成畫面上的樣子 */
const withSource = (s: string) => s.replace("{{source}}", "work");
const firstLine = (s: string) => s.split("<br />")[0];

const noop = () => {};
const renderCard = (props: Partial<Parameters<typeof CommonConfigCard>[0]> = {}) =>
  render(<CommonConfigCard port={1234} accounts={accounts} onPrev={noop} onNext={noop} {...props} />);

/** 等到卡片載完（不適用卡或項目清單其中之一出現） */
const settled = (ui: ReturnType<typeof render>) =>
  waitFor(() => expect(ui.container.querySelector(".b4-card")).toBeTruthy());

describe("CommonConfigCard 共通設置卡", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW"); // 固定語言，斷言才對得上 catalog
    checkDir.mockReset().mockResolvedValue("dir");
    commonConfigPlan.mockReset().mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [op()],
    });
    commonConfigApply.mockReset().mockResolvedValue([result()]);
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  it("逐項顯示現況與將執行的動作，並標出實體檔持有者", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ entry: "commands", state: "ok", action: "skip" }),
        op({ entry: "plugins", state: "missing", action: "create_link" }),
        op({ entry: "skills", state: "wrong_link", action: "relink" }),
      ],
    });
    const ui = renderCard();
    await settled(ui);

    // 卡頭：source（實體檔持有者）與 target 都要寫明
    const head = ui.container.querySelector(".b4-card-title")!;
    expect(head.textContent).toContain("work");
    expect(ui.container.querySelector(".b4-card-desc")?.textContent).toContain("personal");

    const rows = [...ui.container.querySelectorAll(".b4-item")];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("commands");
    expect(rows[0].textContent).toContain(zh.cc.ready);
    expect(rows[0].querySelector(".b4-chip")?.className).toContain("ok");
    expect(rows[1].textContent).toContain(zh.cc.state.missing);
    expect(rows[1].textContent).toContain(zh.cc.willLink);
    expect(rows[2].textContent).toContain(zh.cc.state.wrong_link);
    expect(rows[2].textContent).toContain(zh.cc.willRelink);
    // 重新指向不損失資料（原目標還在）但仍是改動，用琥珀而非灰
    expect(rows[2].querySelector(".b4-chip")?.className).toContain("warn");
  });

  // 精靈不給破壞性授權是刻意的（spec-b4 定案 8）：needs_overwrite 的項目一律保留不動，
  // 且要告訴使用者去哪裡處理——否則使用者只會看到一個沒解釋的琥珀 chip
  it("needs_overwrite 的項目標「保留不動」並指向設定頁", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ entry: "commands", state: "missing", action: "create_link" }),
        op({ entry: "CLAUDE.md", state: "content_differs", action: "backup_and_copy", needs_overwrite: true }),
      ],
    });
    const ui = renderCard();
    await settled(ui);

    const rows = [...ui.container.querySelectorAll(".b4-item")];
    expect(rows[1].textContent).toContain(zh.cc.state.content_differs);
    expect(rows[1].textContent).toContain(zh.cc.keep);
    expect(rows[1].querySelector(".b4-chip")?.className).toContain("warn");
    expect(ui.container.querySelector(".b4-hint-warn")?.textContent).toContain("設定");
  });

  it("沒有任何保留不動的項目時不顯示那段說明", async () => {
    const ui = renderCard();
    await settled(ui);

    expect(ui.container.querySelector(".b4-hint-warn")).toBeNull();
  });

  // 票 26 硬性要求：精靈一律送空 overwrite 清單，且 entries 不含進階項 projects
  it("套用送空 overwrite 清單、entries 不含 projects", async () => {
    const ui = renderCard();
    await settled(ui);

    ui.getByText(zh.cc.apply).click();

    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(1));
    expect(commonConfigApply).toHaveBeenCalledWith(1234, {
      source: "work",
      targets: ["personal"],
      entries: COMMON_CONFIG_ENTRIES,
      overwrite: [],
    });
    expect([...COMMON_CONFIG_ENTRIES]).not.toContain("projects");
    // 預覽也是同一份 entries（plan 與 apply 的輸入必須一致，否則 server 重算的是另一張 plan）
    expect(commonConfigPlan.mock.calls[0][1].entries).toEqual(COMMON_CONFIG_ENTRIES);
    expect(ui.container.textContent).toContain("projects"); // 進階項的一行說明
  });

  it("套用後逐項回報結果並重新偵測狀態", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ entry: "commands", state: "missing", action: "create_link" }),
        op({ entry: "CLAUDE.md", state: "content_differs", action: "backup_and_copy", needs_overwrite: true }),
      ],
    });
    commonConfigApply.mockResolvedValue([
      result({ entry: "commands", outcome: "created" }),
      result({ entry: "CLAUDE.md", outcome: "conflict" }),
    ]);
    const ui = renderCard();
    await settled(ui);

    ui.getByText(zh.cc.apply).click();

    await waitFor(() => expect(ui.container.textContent).toContain(zh.results.created));
    expect(ui.container.textContent).toContain(zh.results.conflict);
    // 狀態即時偵測（spec-b4 §4）：套用後畫面不能停在過時的 plan
    expect(commonConfigPlan).toHaveBeenCalledTimes(2);
    // 套用過了就往下走，主按鈕不再是「套用」
    expect(ui.queryByText(zh.cc.apply)).toBeNull();
    expect(ui.getByText(zh.common.next)).toBeTruthy();
  });

  it("套用失敗：顯示映射後的判別碼訊息，不謊稱已套用", async () => {
    commonConfigApply.mockRejectedValue(new SetupError("config_not_initialized", 400));
    const ui = renderCard();
    await settled(ui);

    ui.getByText(zh.cc.apply).click();

    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy());
    expect(ui.getByRole("alert").textContent).toBe(zh.errors.config_not_initialized);
    expect(ui.getByText(zh.cc.apply)).toBeTruthy(); // 仍可重試
  });

  // spec-b4 §5：sidecar 回英文判別碼，前端負責映射——判別碼本身不得出現在畫面上
  it("預覽失敗：判別碼映射成 i18n 字串，未知碼退到通用訊息", async () => {
    commonConfigPlan.mockRejectedValue(new SetupError("probe_failed", 500));
    const ui = renderCard();

    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy());
    expect(ui.getByRole("alert").textContent).toBe(zh.errors.probe_failed);
    expect(ui.container.textContent).not.toContain("probe_failed");

    cleanup();
    commonConfigPlan.mockRejectedValue(new SetupError("brand_new_code", 400));
    const other = renderCard();

    await waitFor(() => expect(other.getByRole("alert")).toBeTruthy());
    expect(other.getByRole("alert").textContent).toBe(zh.errors.common_config_failed);
    expect(other.container.textContent).not.toContain("brand_new_code");
  });

  // 次帳號目錄不存在 → 整張卡「不適用」。**不可以照送 plan／apply**：apply 會 mkdir，
  // 等於替只用一個帳號的使用者建出他沒要的帳號目錄
  it("次帳號目錄不存在：整張卡不適用，不打 plan", async () => {
    checkDir.mockResolvedValue("missing");
    const ui = renderCard();

    await waitFor(() => expect(ui.getByText(zh.cc.naTitle)).toBeTruthy());
    expect(ui.container.querySelector(".b4-card")?.className).toContain("is-na");
    expect(ui.container.textContent).toContain("~/.claude-tc");
    expect(commonConfigPlan).not.toHaveBeenCalled();
    expect(ui.queryByText(zh.cc.apply)).toBeNull();
    expect(ui.getByText(zh.common.next)).toBeTruthy();
  });

  it("只登記一個帳號：不適用，連目錄都不用探", async () => {
    const ui = renderCard({ accounts: { work: accounts.work } });

    await waitFor(() => expect(ui.getByText(zh.cc.naTitle)).toBeTruthy());
    expect(ui.container.textContent).toContain(firstLine(zh.cc.naDescSingle));
    expect(checkDir).not.toHaveBeenCalled();
    expect(commonConfigPlan).not.toHaveBeenCalled();
  });

  it("三帳號其中一個目錄不存在：只把存在的列為 target", async () => {
    checkDir.mockImplementation(async (_port, path) => (path === "~/.claude-x" ? "missing" : "dir"));
    const ui = renderCard({
      accounts: { ...accounts, extra: { config_dir: "~/.claude-x", label: "額外" } },
    });
    await settled(ui);

    expect(commonConfigPlan).toHaveBeenCalledWith(1234, {
      source: "work",
      targets: ["personal"],
      entries: COMMON_CONFIG_ENTRIES,
    });
  });

  it("目錄探測失敗：當作不適用（寧可不動，也不對未確認的目錄動手）", async () => {
    checkDir.mockRejectedValue(new Error("Failed to fetch"));
    const ui = renderCard();

    await waitFor(() => expect(ui.getByText(zh.cc.naTitle)).toBeTruthy());
    expect(commonConfigPlan).not.toHaveBeenCalled();
    expect(ui.getByRole("alert").textContent).toContain(zh.errors.check_dir_failed.split("{{")[0]);
    expect(ui.container.textContent).toContain("~/.claude-tc"); // 說明是哪個目錄沒確認到
  });

  it("全部已就緒：主按鈕直接是下一步，不打 apply", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ entry: "commands", state: "ok", action: "skip" }),
        op({ entry: "CLAUDE.md", state: "source_missing", action: "skip" }),
      ],
    });
    const ui = renderCard();
    await settled(ui);

    expect(ui.queryByText(zh.cc.apply)).toBeNull();
    expect(ui.getByText(zh.cc.nothingToDo)).toBeTruthy();
    // source 沒有這一項時不能顯示「已就緒」——那會讓使用者以為同步好了
    const rows = [...ui.container.querySelectorAll(".b4-item")];
    expect(rows[1].textContent).toContain(withSource(zh.cc.state.source_missing));
    expect(rows[1].textContent).toContain(zh.cc.unavailable);
  });

  it("略過：不打 apply，直接往下一頁", async () => {
    const onNext = vi.fn();
    const ui = renderCard({ onNext });
    await settled(ui);

    ui.getByText(zh.common.skip).click();

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(commonConfigApply).not.toHaveBeenCalled();
  });

  it("多個 target：每個帳號一組清單，各自標出帳號名", async () => {
    checkDir.mockResolvedValue("dir");
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ account: "personal", entry: "commands" }),
        op({ account: "extra", entry: "commands", target_path: "/Users/x/.claude-x/commands" }),
      ],
    });
    const ui = renderCard({
      accounts: { ...accounts, extra: { config_dir: "~/.claude-x", label: "額外" } },
    });
    await settled(ui);

    const groups = [...ui.container.querySelectorAll(".b4-sec-h")];
    expect(groups.map((g) => g.textContent)).toEqual(["personal", "extra"]);
    expect(ui.container.querySelectorAll(".b4-list")).toHaveLength(2);
  });
});

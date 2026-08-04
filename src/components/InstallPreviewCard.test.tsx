// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import type { InstallPreview } from "../lib/sidecar";
import { InstallPreviewCard } from "./InstallPreviewCard";

const installPlan = vi.fn<
  (port: number, dest: string, mapping: Record<string, string>) => Promise<InstallPreview>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  installPlan: (port: number, dest: string, mapping: Record<string, string>) =>
    installPlan(port, dest, mapping),
}));

const PREVIEW: InstallPreview = {
  targets: { work: "/Users/me/.claude" },     // personal 沒給落點
  extra_targets: {},                           // .agents 也沒給
  will_install: 12,
  will_skip: ["CLAUDE.md"],
  blocked: ["skills/x/a.md", "skills/x/b.md"],
  excluded: [".claude.json", ".agents"],       // 既有的混合欄位（install 路徑在用）
  excluded_files: [".claude.json"],            // 後端拆好的：逐檔的
  unconfirmed_extra: [".agents"],              // 後端拆好的：整包不搬的
  missing_accounts: ["personal"],              // 後端在**同一份快照**裡算的
  project_renames: { "-old-a": "-new-a" },
  unmapped_projects: [{ account: "work", encoded_dir: "-old-b", cwd: "/old/b" }],
};

const setup = (preview: InstallPreview = PREVIEW) => {
  installPlan.mockResolvedValue(preview);
  return render(
    <InstallPreviewCard port={1234} dest="/tmp/staging"
                        sourceGen={1} mapping={{ "/old/a": "/new/a" }}
                        onStatus={() => {}} />,
  );
};

describe("InstallPreviewCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("預覽以已確認的落點與這一頁帶來的對應算出來", async () => {
    setup();
    await waitFor(() => expect(installPlan)
      .toHaveBeenCalledWith(1234, "/tmp/staging", { "/old/a": "/new/a" }));
  });

  // 增補 spec 缺口 4：上游只寫四類，漏了 `blocked`。不獨立顯示的話預覽總數會無聲縮水，
  // 使用者確認的是一份「看起來完整、實際已知缺件」的移機
  it("五類都顯示，`blocked` 是獨立分類且說得出原因與補救方式", async () => {
    const ui = setup();
    await waitFor(() => expect(ui.getByText(zh.mig.install.blocked)).toBeTruthy());
    expect(ui.getByText(zh.mig.install.blockedNote)).toBeTruthy();
    expect(ui.getByText("skills/x/a.md")).toBeTruthy();      // 明細看得到
    expect(ui.getByText(zh.mig.install.willSkip)).toBeTruthy();
    expect(ui.getByText(zh.mig.install.renames)).toBeTruthy();
  });

  // 增補 spec §2.5.2：連結不在任何預覽數字裡，結果可能比預覽多——文案要留餘地
  it("數字說成「至少 N 項」並說明結果可能更多", async () => {
    const ui = setup();
    await waitFor(() => expect(
      ui.getByText(zh.mig.install.atLeast.replace("{{count}}", "12"))).toBeTruthy());
    expect(ui.getByText(zh.mig.install.atLeastNote)).toBeTruthy();
  });

  // 增補 spec §2.5.1：`excluded` 混了逐檔與整包兩種粒度，只顯示一個數字會讓使用者
  // 以為「不處理的 2 個檔案」，實際上 `.agents` 底下可能有幾百個檔案
  it("「不處理」拆成兩行：逐檔的與整包不搬的 extra", async () => {
    const ui = setup();
    await waitFor(() => expect(ui.getByText(zh.mig.install.excludedFiles)).toBeTruthy());
    // 逐檔的那一行是純資訊（使用者不需要行動）→ 預設收合，展開才看得到明細。
    // 用那一段自己的按鈕而不是「第 N 個」——後者會隨分類順序或預設展開與否而錯位
    const filesSection = ui.getByText(zh.mig.install.excludedFiles).closest(".ob-spot")!;
    (filesSection.querySelector("button") as HTMLButtonElement).click();
    await waitFor(() => expect(ui.getByText(".claude.json")).toBeTruthy());
    expect(ui.getByText(zh.mig.install.excludedExtra)).toBeTruthy();
    expect(ui.getByText(".agents")).toBeTruthy();
    expect(ui.getByText(zh.mig.install.excludedExtraNote)).toBeTruthy();
  });

  // Codex 票 05 R1 F2：`_safe_extra_name` 允許 `.claude.json` 當 extra name（它是合法的
  // 單一路徑元件）。用名稱從 `excluded` 反推粒度的話，名稱一碰撞就會把帳號裡真正被排除
  // 的那個檔一起濾掉——所以分類一律用後端拆好的欄位
  it("extra 名稱與排除檔同名時，兩者各自顯示不互相吃掉", async () => {
    const ui = setup({
      ...PREVIEW,
      excluded: [".claude.json", ".claude.json"],
      excluded_files: [".claude.json"],          // 帳號裡那個檔
      unconfirmed_extra: [".claude.json"],       // 同名的 extra
    });
    await waitFor(() => expect(ui.getByText(zh.mig.install.excludedExtra)).toBeTruthy());
    const filesSection = ui.getByText(zh.mig.install.excludedFiles).closest(".ob-spot")!;
    expect(filesSection.textContent).toContain("1");        // 逐檔的那一行沒被吃掉
    (filesSection.querySelector("button") as HTMLButtonElement).click();
    await waitFor(() => expect(filesSection.textContent).toContain(".claude.json"));
  });

  // 增補 spec §2.5.2：使用者在 targets 頁漏選一個帳號的落點，後端的預覽**完全不會提到它**
  // ——只有前端拿 manifest 的帳號清單與 plan.targets 取差集才擋得住「以為都搬了」
  it("漏選落點的帳號要自己比對出來並提醒", async () => {
    const ui = setup();
    await waitFor(() => expect(ui.getByText(zh.mig.install.missingAccounts)).toBeTruthy());
    expect(ui.getByText("personal")).toBeTruthy();
    expect(ui.getByText(zh.mig.install.missingAccountsNote)).toBeTruthy();
  });

  it("三種補救路徑分開講，不混成一句", async () => {
    const ui = setup();
    await waitFor(() => expect(ui.getByText(zh.mig.install.blockedNote)).toBeTruthy());
    // 去檔案系統排掉衝突 vs 回上一步補選落點——兩種說法都在，而且是分開的段落
    expect(ui.getByText(zh.mig.install.excludedExtraNote)).toBeTruthy();
    expect(ui.getByText(zh.mig.install.missingAccountsNote)).toBeTruthy();
  });

  it("沒有東西要搬時明說", async () => {
    const ui = setup({
      ...PREVIEW, will_install: 0, will_skip: [], blocked: [], excluded: [],
      excluded_files: [], unconfirmed_extra: [], missing_accounts: [],
      project_renames: {}, unmapped_projects: [],
    });
    await waitFor(() => expect(ui.getByText(zh.mig.install.none)).toBeTruthy());
  });

  // Codex 票 05 R1 F1：`nothing` 只看後端的預覽欄位的話，「選了一個空帳號、另一個含資料
  // 的帳號沒給落點」會讓所有欄位都是空的 → 畫面說「沒有東西要搬」，而安裝會漏掉一整個
  // 帳號。**這正是這張票要擋的無聲漏件**
  it("預覽全空但有帳號沒給落點 → 不得說「沒有東西要搬」", async () => {
    const ui = setup({
      ...PREVIEW, will_install: 0, will_skip: [], blocked: [], excluded: [],
      excluded_files: [], unconfirmed_extra: [], missing_accounts: ["personal"],
      project_renames: {}, unmapped_projects: [],
    });
    await waitFor(() => expect(ui.getByText(zh.mig.install.missingAccounts)).toBeTruthy());
    expect(ui.getByText("personal")).toBeTruthy();
    expect(ui.queryByText(zh.mig.install.none)).toBeNull();
  });

  it("算不出預覽 → 通用訊息，例外原文不進畫面", async () => {
    installPlan.mockRejectedValueOnce(new Error("PLAN-SENTINEL-500"));
    const ui = render(
      <InstallPreviewCard port={1234} dest="/tmp/staging"
                          sourceGen={1} mapping={{}} onStatus={() => {}} />,
    );
    await waitFor(() => expect(ui.getByText(zh.mig.install.errors.loadFailed)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("PLAN-SENTINEL-500");
  });

  // 與 paths 頁同一條（票 04 R1 F3）：算不出預覽就不該讓使用者按下不可逆的安裝
  it("載入狀態回報給精靈（它據此決定放不放行）", async () => {
    const onStatus = vi.fn<(s: string) => void>();
    installPlan.mockRejectedValueOnce(new Error("boom"));
    render(<InstallPreviewCard port={1234} dest="/tmp/staging"
                               sourceGen={1} mapping={{}} onStatus={onStatus} />);
    await waitFor(() => expect(onStatus.mock.calls.map((c) => c[0]))
      .toEqual(["loading", "error"]));
  });

  it("換來源（sourceGen 變）→ 重算，舊來源的慢回應不得覆蓋", async () => {
    let releaseOld: (p: InstallPreview) => void = () => {};
    installPlan.mockImplementationOnce(
      () => new Promise<InstallPreview>((resolve) => { releaseOld = resolve; }));
    const ui = render(
      <InstallPreviewCard port={1234} dest="/tmp/a"
                          sourceGen={1} mapping={{}} onStatus={() => {}} />);

    installPlan.mockResolvedValue({ ...PREVIEW, will_install: 99 });
    ui.rerender(
      <InstallPreviewCard port={1234} dest="/tmp/b"
                          sourceGen={2} mapping={{}} onStatus={() => {}} />);
    await waitFor(() => expect(
      ui.getByText(zh.mig.install.atLeast.replace("{{count}}", "99"))).toBeTruthy());

    releaseOld(PREVIEW);
    await waitFor(() => expect(
      ui.getByText(zh.mig.install.atLeast.replace("{{count}}", "99"))).toBeTruthy());
    expect(ui.queryByText(zh.mig.install.atLeast.replace("{{count}}", "12"))).toBeNull();
  });
});

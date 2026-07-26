// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import en from "../locales/en/onboarding.json";
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
    const before = [
      op({ entry: "commands", state: "missing", action: "create_link" }),
      op({ entry: "CLAUDE.md", state: "content_differs", action: "backup_and_copy", needs_overwrite: true }),
    ];
    commonConfigPlan
      .mockResolvedValueOnce({ source_dir: "/Users/x/.claude", operations: before })
      // 重新偵測：commands 已連上，CLAUDE.md 仍是我們刻意不碰的衝突項
      .mockResolvedValue({
        source_dir: "/Users/x/.claude",
        operations: [{ ...before[0], state: "ok", action: "skip" }, before[1]],
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
    // 剩下的只有精靈不會授權的 conflict 項 → 主按鈕讓位給「下一步」，不誘導使用者再按一次
    expect(ui.queryByText(zh.cc.apply)).toBeNull();
    expect(ui.getByText(zh.common.next)).toBeTruthy();
  });

  // 套用途中 sidecar 重啟：那批結果屬於上一個 sidecar，寫進新畫面就是張冠李戴。
  // 元件沒有 unmount（變的是它面對的 port），所以 mounted 擋不住，要靠 request generation
  it("套用途中 sidecar 重啟：舊結果不寫進新狀態，按鈕仍恢復可用", async () => {
    let settleApply!: (list: CommonConfigOpResult[]) => void;
    commonConfigApply.mockImplementationOnce(
      () => new Promise<CommonConfigOpResult[]>((r) => { settleApply = r; }),
    );
    const ui = renderCard();
    await settled(ui);

    ui.getByText(zh.cc.apply).click();
    await waitFor(() =>
      expect((ui.getByText(zh.cc.apply) as HTMLButtonElement).disabled).toBe(true));

    checkDir.mockClear();
    commonConfigPlan.mockClear();
    ui.rerender(<CommonConfigCard port={5678} accounts={accounts} onPrev={noop} onNext={noop} />);
    await act(async () => { settleApply([result({ outcome: "created" })]); });

    expect(ui.container.textContent).not.toContain(zh.results.created);
    // 作廢的那一輪仍要交還 busy，否則按鈕永久停用（票 25 R4）
    expect((ui.getByText(zh.cc.apply) as HTMLButtonElement).disabled).toBe(false);
    // 重測必須打到新 sidecar：apply 若用自己捕獲的舊 load closure，這裡會看到 1234
    await waitFor(() => expect(commonConfigPlan).toHaveBeenCalled());
    for (const [p] of [...checkDir.mock.calls, ...commonConfigPlan.mock.calls]) {
      expect(p).toBe(5678);
    }
  });

  // port 過渡期會經過 null（Rust 端重啟時 sidecar_port 短暫無值），那一段同樣是「換了世界」
  it("套用途中 port 過渡 null 再換新：舊結果一樣不寫回", async () => {
    let settleApply!: (list: CommonConfigOpResult[]) => void;
    commonConfigApply.mockImplementationOnce(
      () => new Promise<CommonConfigOpResult[]>((r) => { settleApply = r; }),
    );
    const ui = renderCard();
    await settled(ui);
    ui.getByText(zh.cc.apply).click();

    ui.rerender(<CommonConfigCard port={null} accounts={accounts} onPrev={noop} onNext={noop} />);
    await act(async () => { settleApply([result({ outcome: "created" })]); });

    expect(ui.container.textContent).not.toContain(zh.results.created);
  });

  // 上下文簽章不能用手寫分隔符拼：macOS 路徑允許 `|` 與 `=`，兩組不同帳號拼出同一個簽章時，
  // 換帳號後回來的 apply 結果會被當成「還在同一個世界」而寫進新畫面
  it("帳號目錄含分隔字元：換帳號後舊結果仍被判為過期", async () => {
    let settleApply!: (list: CommonConfigOpResult[]) => void;
    commonConfigApply.mockImplementationOnce(
      () => new Promise<CommonConfigOpResult[]>((r) => { settleApply = r; }),
    );
    // 這兩組帳號在 `k=dir` join `|` 的寫法下會拼出同一個字串（人為但可構造）：
    //   work=~/.claude|personal=~/a|b=c   ← 兩組都是這個
    const before = { work: accounts.work, personal: { config_dir: "~/a|b=c", label: "私人" } };
    const after = {
      work: accounts.work,
      personal: { config_dir: "~/a", label: "私人" },
      b: { config_dir: "c", label: "第三個" },
    };
    const ui = renderCard({ accounts: before });
    await settled(ui);
    ui.getByText(zh.cc.apply).click();

    ui.rerender(<CommonConfigCard port={1234} accounts={after} onPrev={noop} onNext={noop} />);
    await act(async () => { settleApply([result({ outcome: "created" })]); });

    expect(ui.container.textContent).not.toContain(zh.results.created);
  });

  // 語言切換會重建 load（deps 含 t）。那不是「換了世界」——results 不該被它清掉（Codex R2 ③）
  it("切換語言不清掉剛套用的逐項結果", async () => {
    const ui = renderCard();
    await settled(ui);
    ui.getByText(zh.cc.apply).click();
    await waitFor(() => expect(ui.container.textContent).toContain(zh.results.created));

    await act(async () => { await i18n.changeLanguage("en"); });

    expect(ui.container.textContent).toContain(en.results.created);
    await i18n.changeLanguage("zh-TW");
  });

  // apply 不得推進 load 的計數器：被它作廢的那個 load 的 `loading` 就沒人解除，
  // apply 再失敗畫面只剩一顆永遠停用的按鈕（Codex R2 ①，票 25 R4 同族）
  it("套用與偵測同時在途：套用失敗不影響那一輪偵測", async () => {
    let failApply!: () => void;
    commonConfigApply.mockImplementationOnce(
      () => new Promise<CommonConfigOpResult[]>((_, rej) => {
        failApply = () => rej(new SetupError("probe_failed", 500));
      }),
    );
    const ui = renderCard();
    await settled(ui);
    ui.getByText(zh.cc.apply).click();

    // apply 還沒回來時換帳號，開一輪新偵測並讓它停在途中
    let settlePlan!: (p: CommonConfigPlan) => void;
    commonConfigPlan.mockImplementationOnce(
      () => new Promise<CommonConfigPlan>((r) => { settlePlan = r; }),
    );
    ui.rerender(
      <CommonConfigCard
        port={1234}
        accounts={{ ...accounts, personal: { config_dir: "~/.claude-tc2", label: "私人" } }}
        onPrev={noop}
        onNext={noop}
      />,
    );
    await waitFor(() => expect(commonConfigPlan).toHaveBeenCalledTimes(2));

    await act(async () => { failApply(); });
    await act(async () => {
      settlePlan({
        source_dir: "/Users/x/.claude",
        operations: [op({ entry: "skills", state: "wrong_link", action: "relink" })],
      });
    });

    // 那一輪偵測必須照樣上畫面，按鈕也要恢復可用——apply 若作廢了它，兩者都不會發生
    expect(ui.container.textContent).toContain(zh.cc.willRelink);
    expect((ui.getByText(zh.cc.apply) as HTMLButtonElement).disabled).toBe(false);
  });

  // 逐項結果只描述「剛才那次套用做了什麼」；換 port／換帳號重測後還疊著它，
  // 就會用歷史 outcome 蓋住最新狀態
  it("換 sidecar 後重新偵測：結果失效，畫面來自新 sidecar 的回應", async () => {
    const ui = renderCard();
    await settled(ui);
    ui.getByText(zh.cc.apply).click();
    await waitFor(() => expect(ui.container.textContent).toContain(zh.results.created));

    commonConfigPlan.mockClear().mockResolvedValue({
      source_dir: "/Users/x/.claude",
      // 新回應給一個舊 plan 沒有的狀態，畫面出現它才證明重繪來自新請求而非只是清掉結果
      operations: [op({ entry: "skills", state: "wrong_link", action: "relink" })],
    });
    ui.rerender(<CommonConfigCard port={5678} accounts={accounts} onPrev={noop} onNext={noop} />);

    await waitFor(() => expect(ui.container.textContent).toContain(zh.cc.willRelink));
    expect(ui.container.textContent).not.toContain(zh.results.created);
    expect(commonConfigPlan).toHaveBeenCalledTimes(1);
    expect(commonConfigPlan.mock.calls[0][0]).toBe(5678);
  });

  // 按鈕反映「現在還做不做得到」而不是「按過了沒」：有項目沒做成時要能再按一次
  it("套用後仍有沒做成的項目：保留套用鍵可重試", async () => {
    commonConfigApply.mockResolvedValue([result({ outcome: "failed", error: "permission_denied" })]);
    const ui = renderCard();
    await settled(ui);

    ui.getByText(zh.cc.apply).click();

    await waitFor(() => expect(ui.container.textContent).toContain(zh.results.failed));
    expect(ui.getByText(zh.cc.apply)).toBeTruthy();
    // 判別碼不進畫面（只有「處理失敗」）——原因留在 console
    expect(ui.container.textContent).not.toContain("permission_denied");
  });

  // 只有 needs_overwrite 項時，精靈能做的事是零：主按鈕不該亮「套用」誘導使用者按下去
  it("只有保留不動的項目：主按鈕是下一步，但仍指路到設定頁", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ entry: "CLAUDE.md", state: "content_differs", action: "backup_and_copy", needs_overwrite: true }),
      ],
    });
    const ui = renderCard();
    await settled(ui);

    expect(ui.queryByText(zh.cc.apply)).toBeNull();
    expect(ui.getByText(zh.common.next)).toBeTruthy();
    expect(ui.container.querySelector(".b4-hint-warn")).toBeTruthy();
    expect(ui.queryByText(zh.cc.nothingToDo)).toBeNull(); // 有東西沒處理，不能說「沒事可做」
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
    // 探測失敗 ≠ 目錄不存在。同一張卡上寫「偵測到 X 不存在」又跳「無法確認 X」是自相矛盾
    expect(ui.container.textContent).toContain(firstLine(zh.cc.naDescBlocked).split("<code>")[0]);
    expect(ui.container.textContent).not.toContain("不存在");
  });

  // 目錄存在但讀不到（denied）或根本不是目錄（not_dir）：一樣排除（apply 會 mkdir），
  // 但不能沿用「不存在，你只用一個帳號」那套文案——那對這兩種狀態是假話
  it("目錄存在但不可用：用「無法確認」的文案，不說不存在", async () => {
    checkDir.mockResolvedValue("denied");
    const ui = renderCard();

    await waitFor(() => expect(ui.getByText(zh.cc.naTitle)).toBeTruthy());
    expect(commonConfigPlan).not.toHaveBeenCalled();
    expect(ui.container.textContent).toContain(firstLine(zh.cc.naDescBlocked).split("<code>")[0]);
    expect(ui.container.textContent).not.toContain("不存在");
  });

  it("全部已就緒：主按鈕直接是下一步，不打 apply", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ entry: "commands", state: "ok", action: "skip" }),
        op({ entry: "skills", state: "ok", action: "skip" }),
      ],
    });
    const ui = renderCard();
    await settled(ui);

    expect(ui.queryByText(zh.cc.apply)).toBeNull();
    expect(ui.getByText(zh.cc.nothingToDo)).toBeTruthy();
    expect(commonConfigApply).not.toHaveBeenCalled();
  });

  // source 側缺項也是後端的 skip，但那不是「已經是你要的狀態」——逐列與卡底文案都不能說謊
  it("source 沒有這一項：標無法處理，且不說「沒事可做」", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ entry: "commands", state: "ok", action: "skip" }),
        op({ entry: "CLAUDE.md", state: "source_missing", action: "skip" }),
      ],
    });
    const ui = renderCard();
    await settled(ui);

    const rows = [...ui.container.querySelectorAll(".b4-item")];
    expect(rows[1].textContent).toContain(withSource(zh.cc.state.source_missing));
    expect(rows[1].textContent).toContain(zh.cc.unavailable);
    expect(rows[1].textContent).not.toContain(zh.cc.ready);
    expect(ui.queryByText(zh.cc.nothingToDo)).toBeNull();
    expect(ui.queryByText(zh.cc.apply)).toBeNull(); // 精靈對這一項無事可做
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

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
    // port 為 null 時 load() 一開頭就 return，若舊快照沒被丟掉，那張卡會無限期留著、
    // 按鈕還看起來能按（Codex R4 ①）
    expect(ui.container.querySelector(".b4-item")).toBeNull();
    expect(ui.queryByText(zh.cc.apply)).toBeNull();
  });

  // 偵測的三個欄位要嘛整包換、要嘛整包丟。上一輪是「不適用」、這一輪 plan 失敗時若只清掉
  // plan，畫面會同時掛著錯誤訊息與一張說「目錄不存在」的卡——而該目錄這輪明明探到了（R3 ⑤）
  it("預覽失敗：不留上一輪的不適用卡", async () => {
    checkDir.mockResolvedValue("missing");
    const ui = renderCard();
    await waitFor(() => expect(ui.getByText(zh.cc.naTitle)).toBeTruthy());

    checkDir.mockResolvedValue("dir");
    commonConfigPlan.mockRejectedValue(new SetupError("probe_failed", 500));
    ui.rerender(
      <CommonConfigCard
        port={1234}
        accounts={{ work: accounts.work, personal: { config_dir: "~/.claude-tc3", label: "私人" } }}
        onPrev={noop}
        onNext={noop}
      />,
    );

    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy());
    expect(ui.queryByText(zh.cc.naTitle)).toBeNull();
    expect(ui.container.querySelector(".is-na")).toBeNull();
  });

  // `ctx` 只是身分值、不帶時間——離開再回到同一個上下文（帳號改掉又改回來）時，
  // 光比對相等會讓上一輪的 outcome 復活、疊在最新 plan 上（Codex R3 ②）
  it("離開上下文再回來：舊的逐項結果不復活", async () => {
    const other = { work: accounts.work, personal: { config_dir: "~/.claude-other", label: "私人" } };
    const ui = renderCard();
    await settled(ui);
    ui.getByText(zh.cc.apply).click();
    await waitFor(() => expect(ui.container.textContent).toContain(zh.results.created));

    ui.rerender(<CommonConfigCard port={1234} accounts={other} onPrev={noop} onNext={noop} />);
    await waitFor(() => expect(ui.container.textContent).not.toContain(zh.results.created));
    ui.rerender(<CommonConfigCard port={1234} accounts={accounts} onPrev={noop} onNext={noop} />);

    await waitFor(() => expect(ui.container.textContent).toContain(zh.cc.willLink));
    expect(ui.container.textContent).not.toContain(zh.results.created);
  });

  // 卸載後不只是「不要 setState」——那一次 refresh 的 checkDir／plan 是真的會發出去的
  it("套用回來時元件已卸載：不再發出重新偵測的請求", async () => {
    let settleApply!: (list: CommonConfigOpResult[]) => void;
    commonConfigApply.mockImplementationOnce(
      () => new Promise<CommonConfigOpResult[]>((r) => { settleApply = r; }),
    );
    const ui = renderCard();
    await settled(ui);
    ui.getByText(zh.cc.apply).click();

    cleanup();
    checkDir.mockClear();
    commonConfigPlan.mockClear();
    await act(async () => { settleApply([result({ outcome: "created" })]); });

    expect(checkDir).not.toHaveBeenCalled();
    expect(commonConfigPlan).not.toHaveBeenCalled();
    void ui;
  });

  // chip 長在「現況」欄。上次做成了、現在卻又需要授權，代表 apply 之後有別的東西動過那個檔案
  // ——這時說「已建立」會讓使用者以為還好好的（Codex R3 ⑥）
  it("套用後該項被外部改動：chip 說現況，不說上次的成功結果", async () => {
    const conflicted = op({
      entry: "commands", state: "real_file", action: "backup_and_link", needs_overwrite: true,
    });
    commonConfigPlan
      .mockResolvedValueOnce({ source_dir: "/Users/x/.claude", operations: [op()] })
      .mockResolvedValue({ source_dir: "/Users/x/.claude", operations: [conflicted] });
    const ui = renderCard();
    await settled(ui);

    ui.getByText(zh.cc.apply).click();

    await waitFor(() => expect(ui.container.textContent).toContain(zh.cc.state.real_file));
    expect(ui.container.textContent).toContain(zh.cc.keep);
    expect(ui.container.textContent).not.toContain(zh.results.created);
  });

  // 反面：失敗類 outcome 與「現在需要授權」並不衝突——「剛才沒能處理」本來就是它要說的事
  it("保留不動的項目：仍看得到上一次的 conflict 結果", async () => {
    const conflicted = op({
      entry: "CLAUDE.md", state: "content_differs", action: "backup_and_copy", needs_overwrite: true,
    });
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [op(), conflicted],
    });
    commonConfigApply.mockResolvedValue([
      result({ entry: "commands", outcome: "created" }),
      result({ entry: "CLAUDE.md", outcome: "conflict" }),
    ]);
    const ui = renderCard();
    await settled(ui);

    ui.getByText(zh.cc.apply).click();

    // 結果要落在它自己那一列——整頁搜字串的話，顯示到錯的列也會通過
    await waitFor(() => {
      const rows = [...ui.container.querySelectorAll(".b4-item")];
      expect(rows[1].textContent).toContain(zh.results.conflict);
    });
    const rows = [...ui.container.querySelectorAll(".b4-item")];
    expect(rows[0].textContent).toContain(zh.results.created);
    expect(rows[0].textContent).not.toContain(zh.results.conflict);
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
    // 判別碼不進畫面（只有「處理失敗」）——原因留在 console
    expect(ui.container.textContent).not.toContain("permission_denied");

    // 「留著按鈕」要真的能再跑一次，不是只有按鈕還在
    commonConfigApply.mockClear().mockResolvedValue([result({ outcome: "created" })]);
    ui.getByText(zh.cc.apply).click();
    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ui.container.textContent).toContain(zh.results.created));
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
    expect(ui.getByRole("alert").textContent).toBe(zh.errors.check_dir_failed);
    expect(ui.container.textContent).not.toContain("Failed to fetch"); // 例外原文只進 console
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

    // 標題要能對出「這一組是哪個帳號的哪個目錄」——只列 key 的話畫面上沒有第二處可以對照。
    // 帳號名與目錄分開查（吃整段 textContent 會斷言成 `personal~/.claude-tc` 這種黏在一起的
    // 字串，看不出是兩個元素，改了排版就得跟著改斷言，Codex 票 29 R4 Low）
    const groups = [...ui.container.querySelectorAll(".b4-group-head")];
    expect(groups.map((g) => g.firstChild?.textContent)).toEqual(["personal", "extra"]);
    expect(groups.map((g) => g.querySelector(".b4-group-path")?.textContent)).toEqual([
      "~/.claude-tc",
      "~/.claude-x",
    ]);
    const lists = [...ui.container.querySelectorAll(".b4-list")];
    expect(lists).toHaveLength(2);
    // 每組只能有自己那個帳號的項目——只數清單數量的話，兩組都塞全部 operation 也會通過
    for (const list of lists) {
      expect(list.querySelectorAll(".b4-item")).toHaveLength(1);
    }
    expect(lists[0].textContent).toContain("commands");
  });

  // 只有一組的人同樣需要知道那一組是誰——分組標題若只在多 target 時才出現，單帳號使用者
  // 就看不到自己在同步哪個目錄（元件註解已寫明會照顯示，但先前沒有測試守住）
  it("單一 target：分組標題照樣列出帳號名與目錄", async () => {
    const ui = renderCard();
    await settled(ui);

    const groups = [...ui.container.querySelectorAll(".b4-group-head")];
    expect(groups).toHaveLength(1);
    expect(groups[0].firstChild?.textContent).toBe("personal");
    expect(groups[0].querySelector(".b4-group-path")?.textContent).toBe("~/.claude-tc");
  });

  // 部分帳號可用時仍會照常顯示卡片；被排除的那些不能就這樣消失，否則畫面看起來像
  // 「所有登記帳號都同步好了」（Codex R4 ④）
  it("多帳號中有一個目錄不可用：明說這次不會處理它", async () => {
    checkDir.mockImplementation(async (_port, path) => (path === "~/.claude-x" ? "missing" : "dir"));
    const ui = renderCard({
      accounts: { ...accounts, extra: { config_dir: "~/.claude-x", label: "額外" } },
    });
    await settled(ui);

    const hints = [...ui.container.querySelectorAll(".b4-hint-warn")];
    expect(hints.some((h) => h.textContent?.includes("extra"))).toBe(true);
  });
});

// ── 設定頁版（票 29）：同一個元件，多了逐項授權、少了精靈的導覽列 ──
describe("CommonConfigCard 設定頁版（allowOverwrite）", () => {
  const conflictOp = (over: Partial<CommonConfigOperation> = {}) =>
    op({ entry: "CLAUDE.md", state: "content_differs", action: "backup_and_copy", needs_overwrite: true, ...over });

  const renderSettings = (props: Partial<Parameters<typeof CommonConfigCard>[0]> = {}) =>
    render(<CommonConfigCard port={1234} accounts={accounts} allowOverwrite {...props} />);

  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    checkDir.mockReset().mockResolvedValue("dir");
    commonConfigPlan.mockReset().mockResolvedValue({ source_dir: "/Users/x/.claude", operations: [conflictOp()] });
    commonConfigApply.mockReset().mockResolvedValue([result({ entry: "CLAUDE.md", outcome: "copied" })]);
  });
  afterEach(cleanup);

  // 精靈刻意不給破壞性授權（spec-b4 定案 8），設定頁才給——這是兩處掛載唯一的行為差異
  it("需授權的項目給勾選框；勾了才把該 (account, entry) 送進 overwrite", async () => {
    const ui = renderSettings();
    await settled(ui);

    expect(ui.queryByText(zh.cc.keep)).toBeNull(); // 不再是「保留不動」
    const box = ui.container.querySelector<HTMLInputElement>(".st-check input")!;
    expect(box.checked).toBe(false);
    expect(ui.container.textContent).toContain(zh.st.replaceWith.replace("{{source}}", "work"));

    // 沒勾就套用＝維持非破壞性
    fireEvent.click(ui.getByText(zh.st.apply));
    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(1));
    expect(commonConfigApply.mock.calls[0][1].overwrite).toEqual([]);

    fireEvent.click(box);
    fireEvent.click(ui.getByText(zh.st.apply));
    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(2));
    expect(commonConfigApply.mock.calls[1][1].overwrite).toEqual([{ account: "personal", entry: "CLAUDE.md" }]);
  });

  // ADR-0002 落點：授權以 (account, entry) 為單位而非裸 entry 名——多 target 時裸名會讓
  // 「授權 A 帳號覆蓋 CLAUDE.md」連帶炸掉 B 帳號的
  it("多 target：勾一個帳號的項目不會連帶授權另一個帳號的同名項", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [conflictOp({ account: "personal" }), conflictOp({ account: "extra" })],
    });
    const ui = renderSettings({
      accounts: { ...accounts, extra: { config_dir: "~/.claude-x", label: "額外" } },
    });
    await settled(ui);

    const boxes = ui.container.querySelectorAll<HTMLInputElement>(".st-check input");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1]); // 只授權第二個帳號
    fireEvent.click(ui.getByText(zh.st.apply));

    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(1));
    expect(commonConfigApply.mock.calls[0][1].overwrite).toEqual([{ account: "extra", entry: "CLAUDE.md" }]);
  });

  it("勾選時明示會先改名備份成什麼，並且沒有精靈的導覽列", async () => {
    const ui = renderSettings();
    await settled(ui);

    expect(ui.container.textContent).toContain(zh.st.backupHint.split("<code>")[0]);
    expect(ui.container.textContent).toContain(".fledge-backup-"); // 備份檔名樣式如實顯示
    expect(ui.queryByText(zh.common.prev)).toBeNull();
    expect(ui.queryByText(zh.common.next)).toBeNull();
    expect(ui.queryByText(zh.common.skip)).toBeNull();
  });

  // 設定頁沒有換頁動作可以觸發重新偵測，卡片自己要有入口
  it("「重新檢查」重新偵測", async () => {
    const ui = renderSettings();
    await settled(ui);
    expect(commonConfigPlan).toHaveBeenCalledTimes(1);

    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [op({ entry: "commands", state: "ok", action: "skip" })],
    });
    fireEvent.click(ui.getByText(zh.env.recheck));

    await waitFor(() => expect(ui.container.textContent).toContain(zh.cc.ready));
    expect(commonConfigPlan).toHaveBeenCalledTimes(2);
  });

  // 摺疊起來時，標題上的數字是使用者唯一看得到的訊號
  it("回報未就緒的項目數給呼叫端（摺疊標題的待處理數）", async () => {
    const onPendingChange = vi.fn<(n: number) => void>();
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        op({ entry: "commands", state: "ok", action: "skip" }),
        op({ entry: "plugins", state: "missing", action: "create_link" }),
        conflictOp(),
      ],
    });
    const ui = renderSettings({ onPendingChange });
    await settled(ui);

    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(2)); // ok 的那項不算
  });

  // 授權的有效期綁在「這一次的衝突」上。少了這條，「衝突 → 被改成一致 → 內容又被改成不同」
  // 的來回會讓畫面以舊授權預先打勾，使用者在沒重新看過內容的情況下授權了覆蓋（Codex R1 High）
  it("衝突消失又再出現：不沿用舊授權，勾選歸零且不送出", async () => {
    const okOp = op({ entry: "CLAUDE.md", state: "ok", action: "skip" });
    const ui = renderSettings();
    await settled(ui);

    fireEvent.click(ui.container.querySelector<HTMLInputElement>(".st-check input")!);
    expect(ui.container.querySelector<HTMLInputElement>(".st-check input")!.checked).toBe(true);

    // 第二輪：那項已經一致了 → 勾選框消失
    commonConfigPlan.mockResolvedValue({ source_dir: "/Users/x/.claude", operations: [okOp] });
    fireEvent.click(ui.getByText(zh.env.recheck));
    await waitFor(() => expect(ui.container.querySelector(".st-check input")).toBeNull());

    // 第三輪：內容又被改成不同 → 這是**新的**衝突，不是剛才那一次
    commonConfigPlan.mockResolvedValue({ source_dir: "/Users/x/.claude", operations: [conflictOp()] });
    fireEvent.click(ui.getByText(zh.env.recheck));
    await waitFor(() => expect(ui.container.querySelector(".st-check input")).toBeTruthy());

    expect(ui.container.querySelector<HTMLInputElement>(".st-check input")!.checked).toBe(false);
    fireEvent.click(ui.getByText(zh.st.apply));
    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(1));
    expect(commonConfigApply.mock.calls[0][1].overwrite).toEqual([]);
  });

  // 授權是一次性的：`stale`＝寫入前發現內容又變了，留著勾選就是讓下一次沿用對舊內容的授權
  it("套用過就用掉授權：同一項仍衝突時要重新勾才會再送", async () => {
    commonConfigApply.mockResolvedValue([result({ entry: "CLAUDE.md", outcome: "stale" })]);
    const ui = renderSettings();
    await settled(ui);

    fireEvent.click(ui.container.querySelector<HTMLInputElement>(".st-check input")!);
    fireEvent.click(ui.getByText(zh.st.apply));
    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(1));
    expect(commonConfigApply.mock.calls[0][1].overwrite).toEqual([
      { account: "personal", entry: "CLAUDE.md" },
    ]);

    // 重測後那項仍是衝突（內容還是不一樣），但授權已經用掉了
    await waitFor(() => expect(commonConfigPlan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ui.container.querySelector<HTMLInputElement>(".st-check input")?.checked).toBe(false));

    fireEvent.click(ui.getByText(zh.st.apply));
    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(2));
    expect(commonConfigApply.mock.calls[1][1].overwrite).toEqual([]);
  });

  // 連線錯誤時請求可能已經到了後端，一樣視為用掉
  it("套用連線失敗：授權同樣用掉，不會在下一次自動沿用", async () => {
    commonConfigApply.mockRejectedValue(new Error("Failed to fetch"));
    const ui = renderSettings();
    await settled(ui);

    fireEvent.click(ui.container.querySelector<HTMLInputElement>(".st-check input")!);
    fireEvent.click(ui.getByText(zh.st.apply));

    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy());
    expect(ui.container.querySelector<HTMLInputElement>(".st-check input")!.checked).toBe(false);
  });

  // 這條驗的是**第二道防線（state 層不變式）**，不是使用者可達的流程：apply 在途時勾選框是
  // disabled，真的使用者沒辦法在舊請求回來前於新上下文勾選。RTL 的 `fireEvent` 會繞過 disabled，
  // 這裡**刻意**借它把 state 推到待驗位置，確認舊請求的 finally 不會刪掉屬於新上下文的授權
  // （Codex R2 Medium）。留這道防線的理由：哪天把「送出途中可勾選」放開，它就會變成可達的。
  it("舊上下文的套用回應不清掉新上下文的授權（UI 另有 disabled 擋在前面）", async () => {
    let releaseApply = (_r: CommonConfigOpResult[]) => {};
    commonConfigApply.mockImplementation(
      () => new Promise<CommonConfigOpResult[]>((resolve) => { releaseApply = resolve; }),
    );
    const ui = renderSettings();
    await settled(ui);

    fireEvent.click(ui.container.querySelector<HTMLInputElement>(".st-check input")!);
    fireEvent.click(ui.getByText(zh.st.apply));
    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(1));

    // 換一組帳號（新的 ctx）→ 授權清空、卡片重新偵測
    ui.rerender(
      <CommonConfigCard
        port={1234}
        accounts={{ ...accounts, personal: { config_dir: "~/.claude-other", label: "私人" } }}
        allowOverwrite
      />,
    );
    await waitFor(() => expect(ui.container.querySelector<HTMLInputElement>(".st-check input")?.checked).toBe(false));
    // UI 的第一道閘：送出途中真的按不動（下一行靠 fireEvent 繞過它，見上面的註解）
    expect(ui.container.querySelector<HTMLInputElement>(".st-check input")!.disabled).toBe(true);
    fireEvent.click(ui.container.querySelector<HTMLInputElement>(".st-check input")!);

    // 舊上下文的回應這才回來——它只能作廢自己那一輪，不能碰新上下文的勾選
    commonConfigApply.mockResolvedValue([result({ entry: "CLAUDE.md", outcome: "copied" })]);
    await act(async () => { releaseApply([result({ entry: "CLAUDE.md", outcome: "copied" })]); });

    expect(ui.container.querySelector<HTMLInputElement>(".st-check input")!.checked).toBe(true);
    fireEvent.click(ui.getByText(zh.st.apply));
    await waitFor(() => expect(commonConfigApply).toHaveBeenCalledTimes(2));
    expect(commonConfigApply.mock.calls[1][1].overwrite).toEqual([
      { account: "personal", entry: "CLAUDE.md" },
    ]);
  });

  // 不適用態沒有 plan，授權也就沒有依附的對象
  it("卡片轉為不適用（沒有 plan）：授權一併失效", async () => {
    const ui = renderSettings();
    await settled(ui);
    fireEvent.click(ui.container.querySelector<HTMLInputElement>(".st-check input")!);

    checkDir.mockResolvedValue("missing"); // 帳號目錄不見了
    fireEvent.click(ui.getByText(zh.env.recheck));
    await waitFor(() => expect(ui.getByText(zh.cc.naTitle)).toBeTruthy());

    // 不適用的卡也要有重新檢查入口——使用者補建目錄後，不然只能關掉設定頁再開一次
    checkDir.mockResolvedValue("dir");
    fireEvent.click(ui.getByText(zh.env.recheck));

    // 目錄回來、內容仍不同 → 新的一次衝突，不該沿用剛才那次授權
    await waitFor(() => expect(ui.container.querySelector(".st-check input")).toBeTruthy());
    expect(ui.container.querySelector<HTMLInputElement>(".st-check input")!.checked).toBe(false);
  });

  it("不適用時回報 0（單帳號使用者的設定頁不該掛著待處理數字）", async () => {
    const onPendingChange = vi.fn<(n: number) => void>();
    const ui = renderSettings({ accounts: { work: accounts.work }, onPendingChange });

    await waitFor(() => expect(ui.getByText(zh.cc.naTitle)).toBeTruthy());
    expect(onPendingChange).toHaveBeenLastCalledWith(0);
  });
});

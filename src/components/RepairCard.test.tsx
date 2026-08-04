// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/restore.json";
import { SetupError, type CommonConfigOpResult, type CommonConfigPlan } from "../lib/sidecar";
import { RepairCard } from "./RepairCard";

const commonConfigPlan = vi.fn<(port: number, req: unknown) => Promise<CommonConfigPlan>>();
const commonConfigRepair =
  vi.fn<(port: number, req: unknown) => Promise<CommonConfigOpResult[]>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  commonConfigPlan: (port: number, req: unknown) => commonConfigPlan(port, req),
  commonConfigRepair: (port: number, req: unknown) => commonConfigRepair(port, req),
}));

const ACCOUNTS = {
  work: { config_dir: "/Users/me/.claude", label: "" },
  personal: { config_dir: "/Users/me/.claude-tc", label: "" },
};

/** plan 的最小形狀：`operations` 的 state 決定畫面說有幾條斷鏈。 */
const planWith = (states: string[]): CommonConfigPlan => ({
  source_dir: "/Users/me/.claude",
  operations: states.map((state, i) => ({
    account: "personal",
    entry: `entry${i}`,
    target_path: `/Users/me/.claude-tc/entry${i}`,
    state: state as CommonConfigPlan["operations"][number]["state"],
    action: "skip",
    needs_overwrite: false,
  })),
});

describe("RepairCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    commonConfigPlan.mockResolvedValue(planWith([]));
    commonConfigRepair.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it("掛載就掃：沒有斷鏈時說清楚，且不給修復按鈕", async () => {
    render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    await screen.findByText(zh.links.none);
    expect(screen.queryByRole("button", { name: zh.links.repair })).toBeNull();
  });

  it("有斷鏈時說有幾條，並給修復按鈕", async () => {
    commonConfigPlan.mockResolvedValue(planWith(["broken_link", "ok", "broken_link"]));
    render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    // 數的是 `broken_link`，不是 operations 總數——只數總數的話這裡會說 3 條
    await screen.findByText(zh.links.found.replace("{{count}}", "2"));
    await screen.findByRole("button", { name: zh.links.repair });
  });

  it("送的是修復專用的 entry 清單（含進階項 projects）", async () => {
    render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    await waitFor(() => expect(commonConfigPlan).toHaveBeenCalled());
    const req = commonConfigPlan.mock.calls[0][1] as { source: string; targets: string[];
                                                       entries: string[] };
    // source＝第一個登記帳號（`repairScope` 的同一慣例）；`projects` 不在清單裡的話，
    // 移機後那條斷鏈就永遠修不回來
    expect(req.source).toBe("work");
    expect(req.targets).toEqual(["personal"]);
    expect(req.entries).toContain("projects");
  });

  it("修復後重測一次——畫面顯示的是修完的現況，不是按下去之前的", async () => {
    commonConfigPlan
      .mockResolvedValueOnce(planWith(["broken_link"]))
      .mockResolvedValue(planWith([]));
    commonConfigRepair.mockResolvedValue([
      { account: "personal", entry: "skills", outcome: "relinked",
        backup_path: null, error: null },
      { account: "personal", entry: "plugins", outcome: "skipped",
        backup_path: null, error: null },
    ]);
    render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.links.repair }));

    await screen.findByText(zh.repair.result.relinked);
    // 「沒事做」的那幾筆不列——一次修復會回每個 (帳號, 項目) 一筆，全列會把真正動到的淹沒
    expect(screen.queryByText(zh.repair.result.skipped)).toBeNull();
    await screen.findByText(zh.links.none);              // 重測後的現況
    expect(commonConfigPlan).toHaveBeenCalledTimes(2);
  });

  it("只登記一個帳號 → 不適用，一個請求都不發", async () => {
    render(<RepairCard port={1234} accounts={{ work: ACCOUNTS.work }} />);
    await screen.findByText(zh.links.notApplicable);
    expect(commonConfigPlan).not.toHaveBeenCalled();
  });

  it("掃描失敗 → 說失敗，不假裝沒有斷鏈", async () => {
    commonConfigPlan.mockRejectedValue(new SetupError("boom", 500));
    render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    await screen.findByText(zh.errors.scanFailed);
    // 「掃不出來」與「沒有斷鏈」是兩件事，說成後者會讓使用者以為不必修
    expect(screen.queryByText(zh.links.none)).toBeNull();
  });

  it("修復失敗 → 說失敗，且按鈕解鎖可重試", async () => {
    commonConfigPlan.mockResolvedValue(planWith(["broken_link"]));
    commonConfigRepair.mockRejectedValue(new SetupError("boom", 500));
    render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.links.repair }));

    await screen.findByText(zh.errors.repairFailed);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: zh.links.repair })).toBeTruthy());
  });

  it("給了 rescanToken 也不會在掛載時多掃一次", async () => {
    // 「掛載就掃」與「呼叫端要求重測」是兩支 effect，後者在初次掛載也會跑——不比對前一個
    // 值就是每次掛載都多打一次端點（RestoreCard 的既有測試抓到的）
    render(<RepairCard port={1234} accounts={ACCOUNTS} rescanToken={0} />);
    await screen.findByText(zh.links.none);
    expect(commonConfigPlan).toHaveBeenCalledTimes(1);
  });

  // ── 遲到的回應不得覆蓋當下的狀態（Codex 票 08 R1 F2）─────────────────────────
  //
  // latest-request-wins 的序號原本只在**真的送出請求**時才遞增，於是「還沒送出就返回」的
  // 兩條前提分支（port 為 null、只剩一個帳號）不會作廢在飛的那一輪——舊回應抵達時序號
  // 仍然相等，就把畫面覆寫回舊帳號組合的結果，連修復按鈕都會重新出現。

  /** 可以由測試決定何時 resolve 的 promise。 */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("掃描在飛時帳號變成只剩一個 → 舊回應不得把畫面覆寫回去", async () => {
    const first = deferred<CommonConfigPlan>();
    commonConfigPlan.mockReturnValueOnce(first.promise);
    const ui = render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    await screen.findByText(zh.links.scanning);

    ui.rerender(<RepairCard port={1234} accounts={{ work: ACCOUNTS.work }} />);
    await screen.findByText(zh.links.notApplicable);

    first.resolve(planWith(["broken_link"]));       // 舊帳號組合的回應遲到
    await waitFor(() => expect(screen.getByText(zh.links.notApplicable)).toBeTruthy());
    expect(screen.queryByRole("button", { name: zh.links.repair })).toBeNull();
  });

  it("掃描在飛時 port 斷了 → 舊回應不得覆寫", async () => {
    const first = deferred<CommonConfigPlan>();
    commonConfigPlan.mockReturnValueOnce(first.promise);
    const ui = render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    await screen.findByText(zh.links.scanning);

    ui.rerender(<RepairCard port={null} accounts={ACCOUNTS} />);
    // **正向斷言＋確實 flush**：第一版寫成 `waitFor(queryByRole(...)).toBeNull()`，那在
    // 舊回應被處理**之前**就成立，waitFor 立刻返回——測試名稱說的事沒真的驗（把作廢
    // 邏輯整個拿掉也照樣綠）。改成「畫面必須仍停在檢查中」，被覆寫就會紅。
    await act(async () => {
      first.resolve(planWith(["broken_link"]));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(zh.links.scanning)).toBeTruthy();
  });

  it("修復在飛時帳號換了 → 舊結果不得寫進畫面", async () => {
    // 同一族的第三處（掃同族時找到的，Codex 只點名掃描那兩條）：`onRepair` 沒有任何
    // 上下文比對，回應遲到就會把**別組帳號**的修復結果顯示成當下的
    commonConfigPlan.mockResolvedValue(planWith(["broken_link"]));
    const job = deferred<CommonConfigOpResult[]>();
    commonConfigRepair.mockReturnValueOnce(job.promise);
    const ui = render(<RepairCard port={1234} accounts={ACCOUNTS} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.links.repair }));

    ui.rerender(<RepairCard port={1234} accounts={{ work: ACCOUNTS.work }} />);
    await screen.findByText(zh.links.notApplicable);

    job.resolve([{ account: "personal", entry: "skills", outcome: "relinked",
                   backup_path: null, error: null }]);
    await waitFor(() => expect(screen.getByText(zh.links.notApplicable)).toBeTruthy());
    expect(screen.queryByText(zh.repair.result.relinked)).toBeNull();
  });

  it("rescanToken 一變就重測並清掉上一輪結果", async () => {
    commonConfigPlan.mockResolvedValue(planWith(["broken_link"]));
    commonConfigRepair.mockResolvedValue([
      { account: "personal", entry: "skills", outcome: "relinked",
        backup_path: null, error: null },
    ]);
    const ui = render(<RepairCard port={1234} accounts={ACCOUNTS} rescanToken={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.links.repair }));
    await screen.findByText(zh.repair.result.relinked);

    // 還原卡在「開始展開／展開結束」時推進它：那之後現役目錄可能被動過，
    // 上一輪的結果不再描述現況
    ui.rerender(<RepairCard port={1234} accounts={ACCOUNTS} rescanToken={2} />);
    await waitFor(() => expect(screen.queryByText(zh.repair.result.relinked)).toBeNull());
    expect(commonConfigPlan).toHaveBeenCalledTimes(3);   // 掛載、修復後重測、token 變
  });
});

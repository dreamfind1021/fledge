// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import i18n from "../i18n";
import Dashboard from "./Dashboard";
import { fetchUsageDashboard, fetchCodexUsage, type UsageDashboard } from "../lib/sidecar";
import { POLL_INTERVAL_MS } from "../lib/usagePoll";

// 整頁 render：sidecar 換成假的，字串用真的 en／zh-TW catalog（票 46，spec §6）。
// Dashboard.test.tsx 用回傳 key 的假 t 測「選了哪個 key」；這裡測插值真的帶出數字、資料真的接到元件上
vi.mock("../lib/sidecar", () => ({ fetchUsageDashboard: vi.fn(), fetchCodexUsage: vi.fn() }));

const payload = (meta: Partial<UsageDashboard["scan_meta"]> = {}): UsageDashboard => ({
  kpi: { month_value: 1, week_value: 1, today_value: 1, claude_cache_hit_rate: 0.5, codex_cache_hit_rate: null,
         net_roi: 1, subscriptions_total: 0 },
  daily: [{ date: "2026-10-18", by_model: { "m-a": 3 }, total: 3 }],
  models: [{ model: "m-a", source: "claude", input: 0, output: 0, cache_read: 0, cache_create: 0, cost: 3 }],
  projects: [{ path: "/Users/u/proj", claude_cost: 3, codex_cost: 0, total: 3, last_active: 0 }],
  hourly: Array.from({ length: 7 }, () => Array(24).fill(0)),
  scan_meta: { state: "ok", missing_pricing: [], ...meta },
});

// 等資料畫出來（專案名出現）再斷言：找不到時要紅在 expect（AssertionError），不是紅在 findBy 的逾時
const shown = async (lang: string, data: UsageDashboard) => {
  await i18n.changeLanguage(lang);
  vi.mocked(fetchUsageDashboard).mockResolvedValue(data);
  const ui = render(<Dashboard port={1} isActive />);
  await ui.findByText("proj");
  return ui;
};

describe("Dashboard 整頁：標題的期間（票 46，spec §4.2）", () => {
  afterEach(cleanup);   // vitest 未開 globals → testing-library 不會自動 cleanup
  beforeEach(() => {
    vi.mocked(fetchUsageDashboard).mockReset();
    vi.mocked(fetchCodexUsage).mockReset().mockResolvedValue({ source: "unavailable", failure_reason: "network", observed_at: null });
  });

  it("請求 30 天；標題的天數來自 scan_meta.days（掃描中拿到 7 天的舊資料就寫 7）", async () => {
    const ui = await shown("zh-TW", payload({ days: 7 }));
    expect(ui.queryByText("每日成本（7 天）")).not.toBeNull();
    expect(ui.queryByText("模型分布（7 天）")).not.toBeNull();
    expect(ui.queryByText("時段活動（7 天）")).not.toBeNull();
    expect(ui.queryByText("專案用量（7 天）")).not.toBeNull();
    expect(ui.queryByText("Cache 命中率（7 天）")).not.toBeNull();
    expect(vi.mocked(fetchUsageDashboard).mock.calls[0]).toEqual([1, 30]);
  });

  it("scan_meta.days 沒有值時退回請求的天數", async () => {
    const ui = await shown("zh-TW", payload());
    expect(ui.queryByText("模型分布（30 天）")).not.toBeNull();
  });

  it("英文：天數接在原標題後面", async () => {
    const ui = await shown("en", payload({ days: 7 }));
    expect(ui.queryByText("Model breakdown (7 days)")).not.toBeNull();
    expect(ui.queryByText("Activity by hour (7 days)")).not.toBeNull();
    expect(ui.queryByText("Project usage (7 days)")).not.toBeNull();
    expect(ui.queryByText("Cache hit rate (7 days)")).not.toBeNull();
  });
});

describe("Dashboard 整頁：暫存資料夾合併列的字（票 46，spec §4.1）", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(fetchUsageDashboard).mockReset();
    vi.mocked(fetchCodexUsage).mockReset().mockResolvedValue({ source: "unavailable", failure_reason: "network", observed_at: null });
  });
  const withTemp = () => {
    const p = payload();
    p.projects.push({ path: "/private/tmp/x", claude_cost: 1, codex_cost: 0, total: 1, last_active: 0 },
                    { path: "/tmp/y", claude_cost: 1, codex_cost: 0, total: 1, last_active: 0 });
    return p;
  };

  it("中文：暫存資料夾、2 個資料夾", async () => {
    const ui = await shown("zh-TW", withTemp());
    expect(ui.queryByText("暫存資料夾")).not.toBeNull();
    expect(ui.queryByText("2 個資料夾")).not.toBeNull();
  });

  it("英文：Temporary folders、2 folder(s)", async () => {
    const ui = await shown("en", withTemp());
    expect(ui.queryByText("Temporary folders")).not.toBeNull();
    expect(ui.queryByText("2 folder(s)")).not.toBeNull();
  });
});

describe("Dashboard 整頁：Codex 一整條（票 46，spec §4.3）", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => { vi.mocked(fetchUsageDashboard).mockReset(); });

  it("版面由上而下：數字卡、Codex 一整條、每日成本（獨佔一整排）、模型＋時段那一列、專案表", async () => {
    vi.mocked(fetchCodexUsage).mockReset().mockResolvedValue({ source: "unavailable", failure_reason: "network", observed_at: null });
    const ui = await shown("zh-TW", payload());
    const root = ui.container.querySelector(".dash-root")!;
    expect([...root.children].map((e) => e.className)).toEqual(
      ["dash-head", "dash-kpi", "dash-win-card dash-cx-strip", "dash-panel dash-daily-panel", "dash-row", "dash-panel"]);
  });

  it("進度線的提示字：時間已過 50%", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000 * 1000);
    vi.mocked(fetchCodexUsage).mockReset().mockResolvedValue({ source: "live", observed_at: 1, plan_type: "prolite",
      primary: { used_percent: 1, window_minutes: 10080, resets_at: 1_800_000_000 + 5040 * 60 } });
    const ui = await shown("zh-TW", payload());
    // Codex 額度是另一個 effect 抓的，專案名出現時它不一定到了：等線畫出來，再斷言字
    const pace = await waitFor(() => {
      const e = ui.container.querySelector(".dash-pace");
      if (!e) throw new Error("還沒畫出進度線");
      return e;
    });
    expect(pace.getAttribute("title")).toBe("時間已過 50%");
  });
});

describe("Dashboard 整頁：模型分布「其他 N 個」與每日成本圖例的「其他」（票 46，spec §4.4、§4.5）", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(fetchUsageDashboard).mockReset();
    vi.mocked(fetchCodexUsage).mockReset().mockResolvedValue({ source: "unavailable", failure_reason: "network", observed_at: null });
  });
  const sixModels = () => {
    const p = payload();
    p.models = ["m-a", "m-b", "m-c", "m-d", "m-e", "m-f"].map((model, i) =>
      ({ model, source: "claude", input: 0, output: 0, cache_read: 0, cache_create: 0, cost: 6 - i }));
    return p;
  };

  it("中文：其他 2 個、其他", async () => {
    const ui = await shown("zh-TW", sixModels());
    expect(ui.queryByText("其他 2 個")).not.toBeNull();
    expect(ui.queryByText("其他")).not.toBeNull();
  });

  it("英文：Other (2)、Other", async () => {
    const ui = await shown("en", sixModels());
    expect(ui.queryByText("Other (2)")).not.toBeNull();
    expect(ui.queryByText("Other")).not.toBeNull();
  });
});

describe("Dashboard 整頁：模型分布與每日成本用同一份排名（票 46，spec §4.5，Codex plan R1）", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(fetchUsageDashboard).mockReset();
    vi.mocked(fetchCodexUsage).mockReset().mockResolvedValue({ source: "unavailable", failure_reason: "network", observed_at: null });
  });
  const model = (name: string, source: string, cost: number) =>
    ({ model: name, source, input: 0, output: 0, cache_read: 0, cache_create: 0, cost });

  // y 在兩個來源各有一筆、合起來第一名；只看 claude 那一筆的話 x 比較多。整頁畫出來，兩張圖的名次、顏色、圖例要一致
  it("同名跨來源先合併：兩張圖的名次、色塊、色段、圖例都是 y 第一", async () => {
    const p = payload();
    p.models = [model("x", "claude", 10), model("y", "claude", 7), model("y", "codex", 6)];
    p.daily = [{ date: "2026-10-18", by_model: { x: 10, y: 13 }, total: 23 }];
    const c = (await shown("zh-TW", p)).container;
    const bg = (sel: string) => [...c.querySelectorAll<HTMLElement>(sel)].map((e) => e.style.background);
    expect({
      bars: [...c.querySelectorAll(".dash-mbar-name")].map((e) => e.textContent), swatches: bg(".dash-mbar-name > i"),
      legend: [...c.querySelectorAll(".dash-legend > span")].map((e) => e.textContent), segs: bg(".dash-daily-col > i"),
    }).toEqual({
      bars: ["y", "x"], swatches: ["var(--primary)", "var(--ai)"],
      legend: ["y", "x"], segs: ["var(--primary)", "var(--ai)"],
    });
  });
});

describe("Dashboard 整頁：每日成本最後一欄的「今天」（票 46，spec §4.4）", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.mocked(fetchUsageDashboard).mockReset();
    vi.mocked(fetchCodexUsage).mockReset().mockResolvedValue({ source: "unavailable", failure_reason: "network", observed_at: null });
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 18, 12, 0).getTime());   // payload 的日期是 2026-10-18
  });

  it("中文：今天", async () => {
    const ui = await shown("zh-TW", payload());
    expect(ui.container.querySelector(".dash-daily-axis .is-today")?.textContent).toBe("今天");
  });

  it("英文：Today", async () => {
    const ui = await shown("en", payload());
    expect(ui.container.querySelector(".dash-daily-axis .is-today")?.textContent).toBe("Today");
  });
});

describe("Dashboard 整頁：成本 API 連續失敗時，時間相關的顯示仍照輪詢節奏更新（票 46，Codex 合併前審查）", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.mocked(fetchUsageDashboard).mockReset();
    vi.mocked(fetchCodexUsage).mockReset();
    // 只假輪詢用的 setInterval：testing-library 的等待用 setTimeout，不受影響
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });
  // 第一次成功、之後每次都回同一個錯誤。setError 拿到同一個字串不會重畫，畫面要靠輪詢本身重畫才跟得上時間
  const failingAfterFirst = async () => {
    await i18n.changeLanguage("zh-TW");
    vi.mocked(fetchUsageDashboard).mockResolvedValueOnce(payload()).mockRejectedValue(new Error("HTTP 500"));
    const ui = render(<Dashboard port={1} isActive />);
    await ui.findByText("proj");
    await waitFor(() => { if (!ui.container.querySelector(".dash-stale")) throw new Error("還沒收到第二次的錯誤"); });
    return ui;
  };
  const poll = () => act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS); });

  it("跨過 Codex 重置時間：下一輪輪詢（仍失敗）後，進度線與黃色消失", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000 * 1000);
    vi.mocked(fetchCodexUsage).mockResolvedValue({ source: "live", observed_at: 1, plan_type: "prolite",
      primary: { used_percent: 80, window_minutes: 10080, resets_at: 1_800_000_000 + 5040 * 60 } });
    const ui = await failingAfterFirst();
    const c = ui.container;
    await waitFor(() => { if (!c.querySelector(".dash-bar.is-ahead")) throw new Error("還沒畫出變黃的額度條"); });
    now.mockReturnValue((1_800_000_000 + 5041 * 60) * 1000);
    await poll();
    expect({ pace: c.querySelector(".dash-pace"), ahead: c.querySelector(".is-ahead") }).toEqual({ pace: null, ahead: null });
  });

  it("跨過午夜：下一輪輪詢（仍失敗）後，最後一欄從「今天」換成日期", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 18, 23, 59).getTime());   // payload 的日期是 2026-10-18
    vi.mocked(fetchCodexUsage).mockResolvedValue({ source: "unavailable", failure_reason: "network", observed_at: null });
    const c = (await failingAfterFirst()).container;
    expect(c.querySelector(".dash-daily-axis .is-today")?.textContent).toBe("今天");
    now.mockReturnValue(new Date(2026, 9, 19, 0, 1).getTime());
    await poll();
    expect([...c.querySelectorAll(".dash-daily-axis > span")].map((e) => e.textContent)).toEqual(["10/18"]);
  });
});

// spec 5.5、§6-11：未歸屬用量那一行的真字串（中英文各一），即時額度失敗時照樣出現
describe("Dashboard 整頁：Codex 未歸屬用量", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(fetchUsageDashboard).mockReset();
    vi.mocked(fetchCodexUsage).mockReset().mockResolvedValue({ source: "unavailable", failure_reason: "network", observed_at: null });
  });
  const withUa = (cost: number | null = 140.23): UsageDashboard => ({ ...payload(), codex_unattributed: {
    tokens: 414_123_456, account_tokens: 491_095_848, share: 0.84, days: 10,
    start_date: "2026-10-12", end_date: "2026-10-21", price_model: "gpt-6.1-sol", cost } });
  // 最後一個 .dash-cx-label 所在那一行；沒有任何一行時回 null（讓斷言紅在 expect，不是紅在 TypeError）
  const row = (c: HTMLElement) => {
    const label = [...c.querySelectorAll<HTMLElement>(".dash-cx-label")].pop();
    return label ? { label: label.textContent, meta: label.parentElement!.lastElementChild!.textContent, tip: label.title } : null;
  };

  it("中文：百分比 · 億 token ≈ 金額；tooltip 寫期間、估價模型與資料來源", async () => {
    const ui = await shown("zh-TW", withUa());
    await waitFor(() => { if (!ui.queryByText("實時額度暫時無法取得")) throw new Error("即時額度還沒回來"); });
    expect(row(ui.container)).toEqual({
      label: "未歸屬用量", meta: "84% · 4.1億 token ≈ $140.23",
      tip: "近 10 天（10/12–10/21）帳號總用量扣掉本機紀錄，包含審查、其他裝置與雲端。金額以 gpt-6.1-sol 估算。" });
  });

  it("英文：M tokens；tooltip 英文版", async () => {
    const ui = await shown("en", withUa());
    expect(row(ui.container)).toEqual({
      label: "Unattributed", meta: "84% · 414.1M tokens ≈ $140.23",
      tip: "10-day span (10/12–10/21): account total minus local records — includes reviews, other devices and cloud. Cost estimated at gpt-6.1-sol prices." });
  });

  it("金額估不出來：數字寫「—」、tooltip 說無法估算", async () => {
    const ui = await shown("zh-TW", withUa(null));
    expect(row(ui.container)).toEqual({ label: "未歸屬用量", meta: "84% · 4.1億 token ≈ —",
      tip: "近 10 天（10/12–10/21）帳號總用量扣掉本機紀錄，包含審查、其他裝置與雲端。無法估算金額。" });
  });

  it("沒有（null）→ 整頁照常、沒有這一行", async () => {
    const ui = await shown("zh-TW", { ...payload(), codex_unattributed: null });
    expect(ui.queryByText("未歸屬用量")).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import Dashboard from "./Dashboard";
import { fetchUsageDashboard, fetchCodexUsage, type UsageDashboard } from "../lib/sidecar";

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

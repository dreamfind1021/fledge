// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CodexPanel, ProjectsTable } from "./Dashboard";
import type { CodexUsage, CodexUsageWindow, UsageDashboard } from "../lib/sidecar";

// fake t：回傳 key 本身（帶插值時附上 :n）——測「選了哪個角色 key」，翻譯文案由 parity 測試把關
const t = (key: string, opts?: Record<string, unknown>) =>
  opts && "n" in opts ? `${key}:${String(opts.n)}` : key;

const win = (minutes: number | null): CodexUsageWindow =>
  ({ used_percent: 42, window_minutes: minutes, resets_at: null });

const live = (primary: CodexUsageWindow, secondary?: CodexUsageWindow): CodexUsage =>
  ({ source: "live", observed_at: 1, plan_type: "plus", primary,
     ...(secondary ? { secondary } : {}) });

describe("CodexPanel", () => {
  afterEach(cleanup);   // vitest 未開 globals → testing-library 不會自動 cleanup，殘留 DOM 會跨測試誤判
  it("單一 10080 分鐘 primary（2026-07 API 改版形狀）→ 恰一條額度條且標 weekly", () => {
    const { container, getByText, queryByText } = render(
      <CodexPanel codex={live(win(10080))} t={t} />);
    expect(container.querySelectorAll(".dash-cx-bar")).toHaveLength(1);
    expect(getByText("windows.weekly")).toBeTruthy();
    expect(queryByText("windows.fiveHour")).toBeNull();   // regression：不得再按位置貼 5hr
  });

  it("舊雙窗形狀（300 primary + 10080 secondary）→ 兩條額度條各標 fiveHour/weekly", () => {
    const { container, getByText } = render(
      <CodexPanel codex={live(win(300), win(10080))} t={t} />);
    expect(container.querySelectorAll(".dash-cx-bar")).toHaveLength(2);
    expect(getByText("windows.fiveHour")).toBeTruthy();
    expect(getByText("windows.weekly")).toBeTruthy();
  });

  it("unavailable → 沒有額度條、顯示不可用訊息", () => {
    const { container, getByText } = render(
      <CodexPanel codex={{ source: "unavailable", failure_reason: "network", observed_at: null }} t={t} />);
    expect(container.querySelectorAll(".dash-cx-bar")).toHaveLength(0);
    expect(getByText("windows.codexUnavailable")).toBeTruthy();
  });

  it("還沒抓到（null）→ 顯示讀取中，不得顯示不可用訊息", () => {
    const { container, getByText, queryByText } = render(<CodexPanel codex={null} t={t} />);
    expect(container.querySelectorAll(".dash-cx-bar")).toHaveLength(0);
    expect(getByText("windows.codexLoading")).toBeTruthy();
    expect(queryByText("windows.codexUnavailable")).toBeNull();   // regression：讀取中被當成失敗
  });

  it("需重新登入（unauthorized）→ 顯示重新登入訊息", () => {
    const { queryByText } = render(
      <CodexPanel codex={{ source: "unavailable", failure_reason: "unauthorized", observed_at: null }} t={t} />);
    expect(queryByText("windows.codexReauth")).not.toBeNull();
  });
});

// 票 46，spec §4.3、§8：條上的時間進度線、用量比時間多 10 點以上變黃。時鐘固定在 NOW（epoch 秒）
const NOW = 1_800_000_000;
const WEEK = 10080;
const at = (used: number, resetsIn: number | null, minutes: number | null = WEEK): CodexUsageWindow =>
  ({ used_percent: used, window_minutes: minutes, resets_at: resetsIn == null ? null : NOW + resetsIn });

describe("CodexPanel：時間進度線與用太快變黃", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  const shown = (w: CodexUsageWindow) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    return render(<CodexPanel codex={live(w)} t={t} />).container;
  };

  it("週窗口過了一半 → 線畫在 50%，滑過寫時間已過 50%", () => {
    const pace = shown(at(20, WEEK * 60 / 2)).querySelector<HTMLElement>(".dash-pace");
    expect(pace?.style.left).toBe("50%");
    expect(pace?.getAttribute("title")).toBe("windows.pace:50");
  });

  it("沒有重置時間 → 不畫線、不變黃", () => {
    const c = shown(at(90, null));
    expect(c.querySelector(".dash-pace")).toBeNull();
    expect(c.querySelector(".is-ahead")).toBeNull();
  });

  it("已過重置時間（資料是重置前抓的）→ 不畫線、不變黃", () => {
    const c = shown(at(90, -60));
    expect(c.querySelector(".dash-pace")).toBeNull();
    expect(c.querySelector(".is-ahead")).toBeNull();
  });

  it("用量比時間多 10 點 → 條變黃；多 9 點 → 不變黃", () => {
    expect(shown(at(60, WEEK * 60 / 2)).querySelector(".dash-bar.is-ahead")).not.toBeNull();
    cleanup();
    expect(shown(at(59, WEEK * 60 / 2)).querySelector(".dash-bar")?.classList.contains("is-ahead")).toBe(false);
  });
});

// 票 46，spec §4.1：暫存資料夾合併成一列、全部列出（拿掉前 30 名上限）
const proj = (path: string, total: number): UsageDashboard["projects"][number] =>
  ({ path, claude_cost: total, codex_cost: 0, total, last_active: 0 });

describe("ProjectsTable", () => {
  afterEach(cleanup);
  it("暫存資料夾合併成一列、照合計排；名稱與路徑那一行換成合併列的字，滑過看得到每個路徑", () => {
    const { container } = render(<ProjectsTable t={t} days={30} projects={[
      proj("/Users/u/big", 100), proj("/private/tmp/a/scratchpad", 3), proj("/Users/u/small", 1), proj("/tmp/b", 4)]} />);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.querySelector(".dash-proj-name")!.textContent))
      .toEqual(["big", "projects.tempName", "small"]);
    expect(rows[1].querySelector(".dash-proj-path")!.textContent).toBe("projects.tempCount:2");
    expect(rows[1].querySelector("td")!.getAttribute("title")).toBe("/private/tmp/a/scratchpad\n/tmp/b");
  });

  it("全部列出：35 個真專案＋2 個暫存資料夾 → 36 列（不再只取前 30 名）", () => {
    const many = Array.from({ length: 35 }, (_, i) => proj(`/Users/u/p${i}`, 100 - i));
    const { container } = render(<ProjectsTable t={t} days={30} projects={[...many, proj("/tmp/a", 1), proj("/tmp/b", 1)]} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(36);
  });
});

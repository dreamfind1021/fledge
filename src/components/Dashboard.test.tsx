// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CodexPanel } from "./Dashboard";
import type { CodexUsage, CodexUsageWindow } from "../lib/sidecar";

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
  it("單一 10080 分鐘 primary（2026-07 API 改版形狀）→ 恰一條 gauge 且標 weekly", () => {
    const { container, getByText, queryByText } = render(
      <CodexPanel codex={live(win(10080))} t={t} />);
    expect(container.querySelectorAll(".dash-gauge")).toHaveLength(1);
    expect(getByText("windows.weekly")).toBeTruthy();
    expect(queryByText("windows.fiveHour")).toBeNull();   // regression：不得再按位置貼 5hr
  });

  it("舊雙窗形狀（300 primary + 10080 secondary）→ 兩條 gauge 各標 fiveHour/weekly", () => {
    const { container, getByText } = render(
      <CodexPanel codex={live(win(300), win(10080))} t={t} />);
    expect(container.querySelectorAll(".dash-gauge")).toHaveLength(2);
    expect(getByText("windows.fiveHour")).toBeTruthy();
    expect(getByText("windows.weekly")).toBeTruthy();
  });

  it("unavailable → 無 gauge、顯示不可用訊息", () => {
    const { container, getByText } = render(
      <CodexPanel codex={{ source: "unavailable", failure_reason: "network", observed_at: null }} t={t} />);
    expect(container.querySelectorAll(".dash-gauge")).toHaveLength(0);
    expect(getByText("windows.codexUnavailable")).toBeTruthy();
  });
});

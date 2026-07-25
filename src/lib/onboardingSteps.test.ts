import { describe, it, expect } from "vitest";
import { wizardSteps, clampStepIndex, progressCells } from "./onboardingSteps";

describe("wizardSteps", () => {
  it("雙帳號走完整七頁（spec-b4 定案 9）", () => {
    expect(wizardSteps(2)).toEqual([
      "welcome",
      "roots",
      "env",
      "login",
      "common",
      "system",
      "done",
    ]);
  });

  it("單帳號整個共通設置頁不出現（六頁）", () => {
    expect(wizardSteps(1)).toEqual(["welcome", "roots", "env", "login", "system", "done"]);
  });
});

describe("clampStepIndex", () => {
  it("範圍內原樣通過", () => {
    expect(clampStepIndex(3, 7)).toBe(3);
  });

  it("超過末頁夾在末頁（完成頁再按下一步不繞回歡迎）", () => {
    expect(clampStepIndex(7, 7)).toBe(6);
  });

  it("小於首頁夾在首頁（歡迎頁按上一步不掉到負數）", () => {
    expect(clampStepIndex(-1, 7)).toBe(0);
  });

  it("序列縮短時把過大的索引拉回末頁（雙帳號→單帳號少一頁）", () => {
    expect(clampStepIndex(6, 6)).toBe(5);
  });
});

describe("progressCells", () => {
  it("格數跟著實際頁數走：單帳號六格、雙帳號七格", () => {
    expect(progressCells(0, wizardSteps(1).length)).toHaveLength(6);
    expect(progressCells(0, wizardSteps(2).length)).toHaveLength(7);
  });

  it("首頁只填第一格（目前頁本身算已到達）", () => {
    expect(progressCells(0, 7)).toEqual([true, false, false, false, false, false, false]);
  });

  it("填到目前頁為止", () => {
    expect(progressCells(2, 7)).toEqual([true, true, true, false, false, false, false]);
  });

  it("末頁全填", () => {
    expect(progressCells(6, 7)).toEqual([true, true, true, true, true, true, true]);
  });
});

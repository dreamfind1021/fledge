import { describe, it, expect } from "vitest";
import { fmtUSD, fmtPct, fmtTokens, fmtClock, fmtDayClock, codexWindowLabel } from "./usageFormat";

describe("usageFormat", () => {
  it("fmtUSD：常規/小額/零/負數", () => {
    expect(fmtUSD(1234.567)).toBe("$1,234.57");
    expect(fmtUSD(0.004)).toBe("<$0.01");
    expect(fmtUSD(0)).toBe("$0.00");
    expect(fmtUSD(-50)).toBe("-$50.00");
  });
  it("fmtPct 與 fmtTokens", () => {
    expect(fmtPct(0.8234)).toBe("82%");
    expect(fmtPct(null)).toBe("—");   // 該源無資料時回破折號
    expect(fmtTokens(1_234_567)).toBe("1.2M");
    expect(fmtTokens(12_345)).toBe("12.3K");
    expect(fmtTokens(999)).toBe("999");
  });
  it("fmtClock：epoch → HH:mm（固定時區斷言用 UTC 注入）", () => {
    // 1780304700 = 2026-06-01T09:05:00Z（2026-01-01T00:00:00Z=1767225600 + 151d + 9h05m）
    expect(fmtClock(1780304700, "UTC")).toBe("09:05");
  });
  it("fmtDayClock：今天/昨天/更早", () => {
    const now = 1780304700; // 2026-06-01T09:05:00Z
    expect(fmtDayClock(now - 3600, "昨天", now, "UTC")).toBe("08:05");
    expect(fmtDayClock(now - 86400, "昨天", now, "UTC")).toBe("昨天 09:05");
    expect(fmtDayClock(now - 3 * 86400, "昨天", now, "UTC")).toBe("5/29 09:05");
  });
  it("codexWindowLabel：依實際分鐘數判定角色，不按位置", () => {
    // 症狀 2 regression：2026-07 API 改版後唯一 primary 就是週窗，不得標成 5 小時
    expect(codexWindowLabel(10080, "fiveHour")).toEqual({ key: "weekly" });
    expect(codexWindowLabel(300, "weekly")).toEqual({ key: "fiveHour" });
  });
  it("codexWindowLabel：非標準分鐘數依整除規則→天/小時/分鐘", () => {
    expect(codexWindowLabel(2880, "fiveHour")).toEqual({ key: "days", n: 2 });
    expect(codexWindowLabel(720, "fiveHour")).toEqual({ key: "hours", n: 12 });
    expect(codexWindowLabel(90, "fiveHour")).toEqual({ key: "minutes", n: 90 });
  });
  it("codexWindowLabel：無效值退回 fallback 角色", () => {
    expect(codexWindowLabel(null, "weekly")).toEqual({ key: "weekly" });
    expect(codexWindowLabel(0, "fiveHour")).toEqual({ key: "fiveHour" });
    expect(codexWindowLabel(-60, "weekly")).toEqual({ key: "weekly" });
    expect(codexWindowLabel(NaN, "fiveHour")).toEqual({ key: "fiveHour" });
  });
});

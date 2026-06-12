import { describe, it, expect } from "vitest";
import { fmtUSD, fmtPct, fmtTokens, fmtClock } from "./usageFormat";

describe("usageFormat", () => {
  it("fmtUSD：常規/小額/零", () => {
    expect(fmtUSD(1234.567)).toBe("$1,234.57");
    expect(fmtUSD(0.004)).toBe("<$0.01");
    expect(fmtUSD(0)).toBe("$0.00");
  });
  it("fmtPct 與 fmtTokens", () => {
    expect(fmtPct(0.8234)).toBe("82%");
    expect(fmtTokens(1_234_567)).toBe("1.2M");
    expect(fmtTokens(12_345)).toBe("12.3K");
    expect(fmtTokens(999)).toBe("999");
  });
  it("fmtClock：epoch → HH:mm（固定時區斷言用 UTC 注入）", () => {
    // 1780304700 = 2026-06-01T09:05:00Z（2026-01-01T00:00:00Z=1767225600 + 151d + 9h05m）
    expect(fmtClock(1780304700, "UTC")).toBe("09:05");
  });
});

import { describe, it, expect } from "vitest";
import { donutParts, blockEta } from "./dashboardLogic";

describe("dashboardLogic", () => {
  it("donutParts：取前 4 名＋其餘合併為 rest，角度總和 360", () => {
    const models = [5, 4, 3, 2, 1, 0.5].map((cost, i) => ({ model: `m${i}`, cost }));
    const parts = donutParts(models);
    expect(parts).toHaveLength(5);
    expect(parts[4].label).toBe("…");
    expect(Math.abs(parts.reduce((s, p) => s + (p.toDeg - p.fromDeg), 0) - 360)).toBeLessThan(1e-6);
  });
  it("donutParts：空清單回空", () => {
    expect(donutParts([])).toEqual([]);
  });
  it("blockEta：依 burn rate 外推達 P90 的時刻；超限或無 rate 回 null", () => {
    const now = 1_780_000_000;
    expect(blockEta({ totalTokens: 1000, limitP90: 2200, burnRateTpm: 200,
                      endTs: now + 3600, now })).toBeCloseTo(now + 360, 0);
    expect(blockEta({ totalTokens: 3000, limitP90: 2200, burnRateTpm: 200,
                      endTs: now + 3600, now })).toBeNull();   // 已超限
    expect(blockEta({ totalTokens: 1000, limitP90: 2200, burnRateTpm: 0,
                      endTs: now + 3600, now })).toBeNull();   // 無 rate
    expect(blockEta({ totalTokens: 1000, limitP90: 2200, burnRateTpm: 1,
                      endTs: now + 60, now })).toBeNull();     // 達限晚於 block 結束 → 不顯示
  });
});

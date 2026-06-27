import { describe, it, expect } from "vitest";
import { donutParts } from "./dashboardLogic";

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
});

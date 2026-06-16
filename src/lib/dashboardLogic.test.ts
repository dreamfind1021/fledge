import { describe, it, expect } from "vitest";
import { donutParts, claudeAccountRow } from "./dashboardLogic";

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

describe("claudeAccountRow", () => {
  const base = { account_key: "work", label: "工作", recent: [], partial: false,
    active: { start_ts: 0, end_ts: 1000, is_gap: false, is_active: true,
              total_tokens: 1000, cost: 0, burn_rate_tpm: 50, projection: null } };

  it("有 limit_p90 → showBar + pct", () => {
    const r = claudeAccountRow({ ...base, limit_p90: 4000 }, 500);
    expect(r.showBar).toBe(true);
    expect(r.pct).toBeCloseTo(0.25);
    expect(r.used).toBe(1000);
    expect(r.limit).toBe(4000);
  });

  it("limit_p90 null → 不畫條、仍有 used/burn/reset", () => {
    const r = claudeAccountRow({ ...base, limit_p90: null }, 500);
    expect(r.showBar).toBe(false);
    expect(r.pct).toBeNull();
    expect(r.used).toBe(1000);
    expect(r.burnRate).toBe(50);
    expect(r.endTs).toBe(1000);
  });

  it("無 active block → 空狀態", () => {
    const r = claudeAccountRow({ ...base, active: null, limit_p90: null }, 500);
    expect(r.empty).toBe(true);
  });

  it("partial 透出（含 fallback 的帳號）", () => {
    const r = claudeAccountRow({ ...base, limit_p90: null, partial: true }, 500);
    expect(r.partial).toBe(true);
  });

  it("partial 預設透出 false", () => {
    const r = claudeAccountRow({ ...base, limit_p90: 4000 }, 500);
    expect(r.partial).toBe(false);
  });

  it("無 active block（empty）仍透出 partial", () => {
    const r = claudeAccountRow({ ...base, active: null, limit_p90: null, partial: true }, 500);
    expect(r.empty).toBe(true);
    expect(r.partial).toBe(true);
  });
});

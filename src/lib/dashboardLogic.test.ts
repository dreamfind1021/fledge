import { describe, it, expect } from "vitest";
import { donutParts, isAheadOfPace, isTempPath, mergeTempProjects, windowElapsedPct } from "./dashboardLogic";

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

// 票 46，spec §4.1
const proj = (path: string, claude: number, codex: number, last: number) =>
  ({ path, claude_cost: claude, codex_cost: codex, total: claude + codex, last_active: last });

describe("暫存資料夾合併成一列", () => {
  it("isTempPath：四個系統暫存根目錄底下算，其他不算（含開頭字樣相似的）", () => {
    expect(["/private/tmp/a", "/tmp/a", "/private/var/folders/x/a", "/var/folders/x/a"].map(isTempPath))
      .toEqual([true, true, true, true]);
    expect(["/Users/u/tmp/a", "/tmpdir/a", "/private/tmpx/a", "/var/foldersx/a"].map(isTempPath))
      .toEqual([false, false, false, false]);
  });

  it("三欄加總守恆、最後活動取最晚、照合計排進中間、路徑全部留著", () => {
    const rows = mergeTempProjects([
      proj("/Users/u/big", 100, 0, 5), proj("/private/tmp/a", 3, 4, 9), proj("/Users/u/mid", 10, 0, 1),
      proj("/var/folders/x/b", 0, 1, 20), proj("/Users/u/small", 1, 0, 2),
    ]);
    expect(rows.map((r) => r.tempPaths ? "TEMP" : r.path)).toEqual(["/Users/u/big", "/Users/u/mid", "TEMP", "/Users/u/small"]);
    const merged = rows[2];
    expect([merged.claude_cost, merged.codex_cost, merged.total, merged.last_active]).toEqual([3, 5, 8, 20]);
    expect(merged.tempPaths).toEqual(["/private/tmp/a", "/var/folders/x/b"]);
  });

  it("只有 1 個暫存資料夾也合併", () => {
    const rows = mergeTempProjects([proj("/Users/u/a", 5, 0, 1), proj("/tmp/x", 1, 0, 1)]);
    expect(rows[1].tempPaths).toEqual(["/tmp/x"]);
  });

  it("沒有暫存資料夾就原樣回傳，不多出合併列", () => {
    const input = [proj("/Users/u/a", 5, 0, 1), proj("/Users/u/b", 1, 0, 1)];
    expect(mergeTempProjects(input)).toEqual(input);
  });
});

// 票 46，spec §4.3、§8
describe("Codex 額度的時間進度", () => {
  const now = 1_000_000;
  const w = (minutes: number | null, resetsAt: number | null) => ({ window_minutes: minutes, resets_at: resetsAt });

  it("全部用 epoch 秒：窗口剛開始 0、過一半 50、5 小時窗口只剩 1 分鐘約 99.67", () => {
    expect(windowElapsedPct(w(10080, now + 10080 * 60), now)).toBe(0);
    expect(windowElapsedPct(w(10080, now + 5040 * 60), now)).toBe(50);
    expect(windowElapsedPct(w(300, now + 60), now)).toBeCloseTo(99.667, 2);
  });

  it("剩餘時間比窗口還長（時鐘偏差）→ 夾在 0", () => {
    expect(windowElapsedPct(w(300, now + 400 * 60), now)).toBe(0);
  });

  it("重置當下與已過重置時間 → null（資料是重置前抓的，不畫）", () => {
    expect(windowElapsedPct(w(300, now), now)).toBeNull();
    expect(windowElapsedPct(w(300, now - 1), now)).toBeNull();
  });

  it("缺資料或不是有限正數 → null", () => {
    expect([w(null, now + 60), w(300, null), w(0, now + 60), w(-5, now + 60), w(NaN, now + 60), w(300, NaN), w(Infinity, now + 60)]
      .map((x) => windowElapsedPct(x, now))).toEqual([null, null, null, null, null, null, null]);
  });

  it("用太快：用量比時間多 10 點以上（未四捨五入）才算；沒有時間進度就不算", () => {
    expect(isAheadOfPace(60, 50)).toBe(true);
    expect(isAheadOfPace(59.99, 50)).toBe(false);
    expect(isAheadOfPace(100, null)).toBe(false);
  });
});

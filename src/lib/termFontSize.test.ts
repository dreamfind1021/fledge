// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 工作區終端機的字級（票 50，spec docs/superpowers/specs/2026-11-02-terminal-font-zoom-design.md §4.1）。
// 模組層有狀態（目前的字級、訂閱者），每條測試重新載入一份乾淨的模組（同 theme.test.ts）。
// 存的鍵寫成字面值：改鍵名＝使用者調過的字級全部消失，要讓測試紅
const KEY = "fledge-term-font-size";

const load = async () => {
  vi.resetModules();
  return import("./termFontSize");
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getTermFontSize：讀存過的字級", () => {
  it("沒存過 → 13", async () => {
    const { getTermFontSize } = await load();
    expect(getTermFontSize()).toBe(13);
  });

  it("存了範圍內的整數 → 用它", async () => {
    localStorage.setItem(KEY, "18");
    const { getTermFontSize } = await load();
    expect(getTermFontSize()).toBe(18);
  });

  it.each([
    ["下限", "10", 10],
    ["上限", "24", 24],
  ])("存了%s本身 → 用它", async (_label, stored, size) => {
    localStorage.setItem(KEY, stored);
    const { getTermFontSize } = await load();
    expect(getTermFontSize()).toBe(size);
  });

  it.each([
    ["小數", "13.5"],
    ["低於下限", "9"],
    ["高於上限", "25"],
    ["看不懂的值", "12px"],   // Number 讀成 NaN；換成 parseInt 會讀成 12
    ["空字串", ""],
  ])("存了%s → 13", async (_label, stored) => {
    localStorage.setItem(KEY, stored);
    const { getTermFontSize } = await load();
    expect(getTermFontSize()).toBe(13);
  });

  it("localStorage 讀取丟例外 → 13，不讓終端機開不起來", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} });
    const { getTermFontSize } = await load();
    expect(() => getTermFontSize()).not.toThrow();
    expect(getTermFontSize()).toBe(13);
  });
});

describe("applyTermFontAction：放大、縮小、重設", () => {
  it("in：13 → 14", async () => {
    const { applyTermFontAction, getTermFontSize } = await load();
    applyTermFontAction("in");
    expect(getTermFontSize()).toBe(14);
  });

  it("out：13 → 12", async () => {
    const { applyTermFontAction, getTermFontSize } = await load();
    applyTermFontAction("out");
    expect(getTermFontSize()).toBe(12);
  });

  it("reset：18 → 13", async () => {
    localStorage.setItem(KEY, "18");
    const { applyTermFontAction, getTermFontSize } = await load();
    applyTermFontAction("reset");
    expect(getTermFontSize()).toBe(13);
  });

  it("字級變了記進 localStorage，重開讀得到", async () => {
    const first = await load();
    first.applyTermFontAction("in");
    first.applyTermFontAction("in");
    const reopened = await load();
    expect(reopened.getTermFontSize()).toBe(15);
  });

  it("在上限再放大：不變、不通知", async () => {
    localStorage.setItem(KEY, "24");
    const { applyTermFontAction, getTermFontSize, onTermFontSizeChange } = await load();
    const fn = vi.fn();
    onTermFontSizeChange(fn);
    applyTermFontAction("in");
    expect(getTermFontSize()).toBe(24);
    expect(fn).not.toHaveBeenCalled();
  });

  it("在下限再縮小：不變、不通知", async () => {
    localStorage.setItem(KEY, "10");
    const { applyTermFontAction, getTermFontSize, onTermFontSizeChange } = await load();
    const fn = vi.fn();
    onTermFontSizeChange(fn);
    applyTermFontAction("out");
    expect(getTermFontSize()).toBe(10);
    expect(fn).not.toHaveBeenCalled();
  });

  it("本來就是 13 時重設：不通知", async () => {
    const { applyTermFontAction, onTermFontSizeChange } = await load();
    const fn = vi.fn();
    onTermFontSizeChange(fn);
    applyTermFontAction("reset");
    expect(fn).not.toHaveBeenCalled();
  });

  it("字級變了會通知訂閱者", async () => {
    const { applyTermFontAction, onTermFontSizeChange } = await load();
    const fn = vi.fn();
    onTermFontSizeChange(fn);
    applyTermFontAction("in");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("退訂之後不再收到通知", async () => {
    const { applyTermFontAction, onTermFontSizeChange } = await load();
    const fn = vi.fn();
    const off = onTermFontSizeChange(fn);
    off();
    applyTermFontAction("in");
    expect(fn).not.toHaveBeenCalled();
  });

  it("寫 localStorage 失敗：這次照樣生效，不丟例外", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { applyTermFontAction, getTermFontSize } = await load();
    expect(() => applyTermFontAction("in")).not.toThrow();
    expect(getTermFontSize()).toBe(14);
  });
});

describe("termFontActionForKey：Cmd 加哪個鍵是字級動作", () => {
  it.each([
    ["=", "in"],
    ["+", "in"],   // Cmd+Shift+=
    ["-", "out"],
    ["0", "reset"],
  ])("%s → %s", async (key, action) => {
    const { termFontActionForKey } = await load();
    expect(termFontActionForKey(key)).toBe(action);
  });

  it.each(["1", "w", "_"])("%s → null（不是字級鍵）", async (key) => {
    const { termFontActionForKey } = await load();
    expect(termFontActionForKey(key)).toBeNull();
  });
});

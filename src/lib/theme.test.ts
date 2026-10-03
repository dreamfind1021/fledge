// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEMES, type ThemeId } from "./themeIds";

// 主題切換（票 07，spec docs/planning/daylight-themes-design.md §4.3）。
// 模組層有狀態（目前的主題、訂閱者），每條測試重新載入一份乾淨的模組。
// Tauri 的原生視窗外觀用 mock 觀察：vitest 不在 Tauri 裡，真的 getCurrentWindow() 會丟例外。
// getWindow 可以改成丟例外，模擬瀏覽器直接開 vite 的情況（票 38）
const setWindowTheme = vi.fn((_t: "dark" | "light" | null) => Promise.resolve());
const getWindow = vi.fn(() => ({ setTheme: setWindowTheme }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => getWindow() }));

const load = async () => {
  vi.resetModules();
  return import("./theme");
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "nightfall";
  setWindowTheme.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("initTheme：啟動時套用存過的主題", () => {
  it("存過合法的值：套用它、同步原生視窗外觀、不寫回儲存", async () => {
    localStorage.setItem("fledge-theme", "daylight-warm");
    // 監看 localStorage 本身：測試環境的 localStorage 是 vitest.setup.ts 換上的普通物件，監看 Storage.prototype 接不到（會假綠）
    const setItem = vi.spyOn(localStorage, "setItem");
    const { initTheme, currentTheme } = await load();
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("daylight-warm");
    expect(currentTheme()).toBe("daylight-warm");
    expect(setWindowTheme).toHaveBeenCalledWith("light");
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([
    ["沒存過", null],
    ["存了看不懂的值", "daylight"],
    ["存了空字串", ""],
  ])("%s → 午夜藍", async (_label, stored) => {
    if (stored !== null) localStorage.setItem("fledge-theme", stored);
    document.documentElement.dataset.theme = "daylight";   // 啟動腳本寫進去的壞值，要被修正
    const { initTheme, currentTheme } = await load();
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("nightfall");
    expect(currentTheme()).toBe("nightfall");
    expect(setWindowTheme).toHaveBeenCalledWith("dark");
  });

  it("localStorage 讀取丟例外 → 午夜藍，不讓 app 開不起來", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} });
    const { initTheme, currentTheme } = await load();
    expect(() => initTheme()).not.toThrow();
    expect(currentTheme()).toBe("nightfall");
  });

  // 不在 Tauri 裡（瀏覽器直接開 vite、README 截圖 rig）時 getCurrentWindow() 會同步丟例外（票 38）。
  // 其他測試都 mock 成正常回傳，拿掉 apply() 裡那段 try/catch 照樣全綠——只有這條看得到
  it("getCurrentWindow() 同步丟例外：照樣套用、照樣通知、留下警告，不讓 app 開不起來", async () => {
    getWindow.mockImplementationOnce(() => { throw new Error("window.__TAURI_INTERNALS__ is undefined"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("fledge-theme", "daylight-cool");
    const { initTheme, onThemeChange } = await load();
    const notified = vi.fn();
    onThemeChange(notified);
    expect(() => initTheme()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("daylight-cool");
    expect(notified).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe("setTheme：切換並記住", () => {
  it("換畫面、換原生視窗外觀、寫進儲存", async () => {
    const { setTheme, currentTheme } = await load();
    setTheme("daylight-cool");
    expect(document.documentElement.dataset.theme).toBe("daylight-cool");
    expect(currentTheme()).toBe("daylight-cool");
    expect(setWindowTheme).toHaveBeenLastCalledWith("light");
    expect(localStorage.getItem("fledge-theme")).toBe("daylight-cool");
    setTheme("nightfall");
    expect(setWindowTheme).toHaveBeenLastCalledWith("dark");
    expect(localStorage.getItem("fledge-theme")).toBe("nightfall");
  });

  // 原生視窗外觀照每個主題自己的深淺（票 40，spec §4.1）。期望值寫字面、不從 THEME_SCHEME 推：
  // 這條守的是「theme.ts 有沒有照表設」；期望值若也從表推，表寫錯時兩邊一起錯而假綠（那個錯由 index.contrast.test.ts 的 color-scheme 一致性抓）
  const NATIVE: Record<ThemeId, "dark" | "light"> = {
    nightfall: "dark", "nightfall-cocoa": "dark", "nightfall-iron": "dark", "daylight-cool": "light", "daylight-warm": "light", "daylight-cherry": "light",
  };
  it.each(THEMES)("%s：原生視窗外觀照深淺設定", async (id) => {
    const { setTheme } = await load();
    setTheme(id);
    expect(setWindowTheme).toHaveBeenLastCalledWith(NATIVE[id]);
  });

  // 先套用再寫（同 LangSwitch.tsx 的理由）：寫失敗時這次仍是使用者要的畫面，只是重開會忘記
  it("寫進儲存失敗：畫面照樣換、不丟例外", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setTheme, currentTheme } = await load();
    expect(() => setTheme("daylight-warm")).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("daylight-warm");
    expect(currentTheme()).toBe("daylight-warm");
    expect(warn).toHaveBeenCalled();
  });

  it("原生視窗外觀切換失敗（非同步拒絕）：畫面照樣換、有寫進儲存", async () => {
    setWindowTheme.mockImplementationOnce(() => Promise.reject(new Error("not allowed")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setTheme } = await load();
    setTheme("daylight-cool");
    await Promise.resolve();
    expect(document.documentElement.dataset.theme).toBe("daylight-cool");
    expect(localStorage.getItem("fledge-theme")).toBe("daylight-cool");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});

describe("onThemeChange：給不在 React 渲染週期裡的地方（終端機）", () => {
  it("每次切換都通知；取消訂閱後不再通知", async () => {
    const { setTheme, onThemeChange } = await load();
    const fn = vi.fn();
    const off = onThemeChange(fn);
    setTheme("daylight-cool");
    setTheme("daylight-warm");
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    setTheme("nightfall");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // 終端機收到通知時會讀 CSS 變數組 xterm 主題：data-theme 必須已經換好，否則讀到的是舊主題的值（spec §4.5）
  it("通知的當下 data-theme 已經換好", async () => {
    const { setTheme, onThemeChange } = await load();
    let seen = "";
    onThemeChange(() => { seen = document.documentElement.dataset.theme ?? ""; });
    setTheme("daylight-warm");
    expect(seen).toBe("daylight-warm");
  });
});

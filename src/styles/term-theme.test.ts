// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ITheme } from "@xterm/xterm";
import { followTheme, readTermTheme } from "./term-theme";
import { setTheme } from "../lib/theme";

// 終端機的顏色（票 07，spec docs/planning/daylight-themes-design.md §3.5、§4.5）。
// jsdom 讀得到寫在 <html> 上的 CSS 變數：用它模擬「切主題之後 CSS 變數變了」，不必載入整份 index.css
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: () => Promise.resolve() }) }));
const root = document.documentElement;
const setVars = (vars: Record<string, string>) => { for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--${k}`, v); };

beforeEach(() => {
  root.removeAttribute("style");
  setVars({ "term-bg": "#080B12", "term-text": "#E2E6EE", "term-cursor": "#67D5C0", session: "#999999" });
});
afterEach(() => root.removeAttribute("style"));

describe("readTermTheme", () => {
  it("游標讀 --term-cursor，不是 --session（淺色主題的 --session 在淺底上只有約 1.5）", () => {
    expect(readTermTheme().cursor).toBe("#67D5C0");
  });

  // 午夜藍不定義 --term-selection：讀到空字串就不傳 → xterm 用預設的半透明白，畫面跟改之前一樣
  it("沒定義 --term-selection：不傳 selectionBackground", () => {
    expect("selectionBackground" in readTermTheme()).toBe(false);
  });

  it("有定義 --term-selection：傳給 xterm", () => {
    setVars({ "term-selection": "#296EBF" });
    expect(readTermTheme().selectionBackground).toBe("#296EBF");
  });
});

describe("followTheme：已開著的終端機跟著主題換色", () => {
  const fakeTerm = () => ({ options: {} as { theme?: ITheme } });

  it("切主題時每一個終端機都換色，輸入法草稿的顏色一起換", () => {
    const [a, b] = [fakeTerm(), fakeTerm()];
    const [ga, gb] = [document.createElement("div"), document.createElement("div")];
    const offA = followTheme(a, ga);
    const offB = followTheme(b, gb);
    setVars({ "term-bg": "#EDF0F6", "term-text": "#0F1724", "term-cursor": "#056D5F", "term-selection": "#296EBF" });
    setTheme("daylight-cool");
    for (const [t, g] of [[a, ga], [b, gb]] as const) {
      expect(t.options.theme?.background).toBe("#EDF0F6");
      expect(t.options.theme?.cursor).toBe("#056D5F");
      expect(t.options.theme?.selectionBackground).toBe("#296EBF");
      expect(g.style.color).toBe("rgb(15, 23, 36)");
    }
    offA();
    offB();
  });

  // 淺→深：選取色要回到 xterm 預設。新的 theme 物件裡沒有 selectionBackground，xterm 就用預設值
  it("淺→深：新的 theme 物件不帶選取色", () => {
    const t = fakeTerm();
    const off = followTheme(t, document.createElement("div"));
    setVars({ "term-selection": "#296EBF" });
    setTheme("daylight-warm");
    expect(t.options.theme?.selectionBackground).toBe("#296EBF");
    root.style.removeProperty("--term-selection");
    setTheme("nightfall");
    expect(t.options.theme && "selectionBackground" in t.options.theme).toBe(false);
    off();
  });

  it("取消訂閱之後不再碰這個終端機（已卸載的 xterm）", () => {
    const t = fakeTerm();
    const off = followTheme(t, document.createElement("div"));
    off();
    setVars({ "term-bg": "#F5EFE7" });
    setTheme("daylight-warm");
    expect(t.options.theme).toBeUndefined();
  });
});

// Terminal.tsx 的接線：在 jsdom 裡 render 真的 xterm 太重，改讀原始碼確認「建立時訂閱、清理時取消」。
// 取消那一行被刪掉的話，切主題時會去碰已經 dispose 的 xterm——只有這條測試看得到
describe("Terminal.tsx 的接線", () => {
  const SRC = import.meta.glob("/src/components/Terminal.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const src = SRC["/src/components/Terminal.tsx"];
  it("建立 xterm 時用 followTheme 訂閱", () => {
    expect(typeof src).toBe("string");
    expect(src).toMatch(/const stopFollowingTheme = followTheme\(term, imeGhost\);/);
  });
  it("同一個 effect 的清理函式裡取消訂閱", () => {
    const cleanup = src.slice(src.indexOf("const stopFollowingTheme"));
    const body = cleanup.slice(cleanup.indexOf("return () => {"), cleanup.indexOf("}, [port, sessionId, tabId, setTabStatus]);"));
    expect(body).toContain("stopFollowingTheme();");
  });
});

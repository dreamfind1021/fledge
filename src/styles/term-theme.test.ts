// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ITheme } from "@xterm/xterm";
import { createImeGhost, followTheme, readTermMinContrast, readTermTheme } from "./term-theme";
import { setTheme } from "../lib/theme";
import { THEMES } from "../lib/themeIds";
import { contrast, resolveColor, token } from "../testing/cssRules";

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

  // 沒傳的話 xterm 用 #000000：淺色主題的方塊游標底下那個字只有 3.36（spec §12.6）
  it("游標格的字讀 --term-cursor-accent", () => {
    setVars({ "term-cursor-accent": "#EDF0F6" });
    expect(readTermTheme().cursorAccent).toBe("#EDF0F6");
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

// 淺色主題開 xterm 的 minimumContrastRatio（spec §12.5）：xterm 的選項是數字，CSS 變數讀出來是字串
describe("readTermMinContrast", () => {
  it("讀 --term-min-contrast", () => {
    setVars({ "term-min-contrast": "4.5" });
    expect(readTermMinContrast()).toBe(4.5);
  });

  // 退回 1＝xterm 預設、不調色。讀到 NaN 或 0 直接傳給 xterm 的話，它的對比計算會壞掉
  it("沒定義或看不懂：1（xterm 預設，不調色）", () => {
    expect(readTermMinContrast()).toBe(1);
    setVars({ "term-min-contrast": "abc" });
    expect(readTermMinContrast()).toBe(1);
  });
});

// 輸入法懸置草稿（票 38）：DOM 元素、不是 xterm 畫的字，minimumContrastRatio 管不到，CSS 的對比測試也掃不到 inline style。
// 直接建一個出來，讀它最後的字色與 opacity 算（Codex plan R2：讀原始碼得列舉各種覆寫寫法，改讀實際的元素）
describe("createImeGhost：輸入法懸置草稿", () => {
  const rgbOf = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  it.each(THEMES)("%s：終端機前景色打淡化，對終端機底至少 4.5:1", (theme) => {
    setVars({ "term-text": token("term-text", theme), "term-bg": token("term-bg", theme) });
    const ghost = createImeGhost();
    expect(ghost.style.color).toBe(rgbOf(token("term-text", theme)));
    const opacity = Number(ghost.style.opacity);
    expect(opacity).toBeGreaterThan(0);   // 沒寫淡化的話讀到 ""，Number("") 是 0
    expect(opacity).toBeLessThan(1);      // 要比已送出的字淡，看得出還沒送出
    const ink = resolveColor(`color-mix(in srgb, var(--term-text) ${opacity * 100}%, var(--term-bg))`, theme);
    expect(contrast(ink, token("term-bg", theme))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("followTheme：已開著的終端機跟著主題換色", () => {
  const fakeTerm = () => ({ options: {} as { theme?: ITheme; minimumContrastRatio?: number } });

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

  it("切主題時最低對比跟著換（淺→深回到 1）", () => {
    const t = fakeTerm();
    const off = followTheme(t, document.createElement("div"));
    setVars({ "term-min-contrast": "4.5" });
    setTheme("daylight-cool");
    expect(t.options.minimumContrastRatio).toBe(4.5);
    setVars({ "term-min-contrast": "1" });
    setTheme("nightfall");
    expect(t.options.minimumContrastRatio).toBe(1);
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
  // 草稿另外在這裡手寫一份的話，上面 createImeGhost 的對比測試就驗不到實際畫出來的那個（票 38）
  it("輸入法懸置草稿用 createImeGhost() 建立", () => {
    expect(src).toContain("const imeGhost = createImeGhost();");
  });
  it("建立 xterm 時用 followTheme 訂閱", () => {
    expect(typeof src).toBe("string");
    expect(src).toMatch(/const stopFollowingTheme = followTheme\(term, imeGhost\);/);
  });
  // 只在切主題時設的話，淺色使用者新開的終端機要等到下一次切主題才有最低對比
  it("建立 xterm 時傳最低對比", () => {
    const ctor = src.slice(src.indexOf("new XTerm({"), src.indexOf("termRef.current = term;"));
    expect(ctor).toContain("minimumContrastRatio: readTermMinContrast(),");
  });
  it("同一個 effect 的清理函式裡取消訂閱", () => {
    const cleanup = src.slice(src.indexOf("const stopFollowingTheme"));
    const body = cleanup.slice(cleanup.indexOf("return () => {"), cleanup.indexOf("}, [port, sessionId, tabId, setTabStatus]);"));
    expect(body).toContain("stopFollowingTheme();");
  });
});

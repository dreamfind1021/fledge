// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "./lib/themeIds";

// index.html 的主題啟動腳本（票 07，spec docs/planning/daylight-themes-design.md §4.2）。
// 它在所有模組之前執行，只負責把存過的值搬進 <html data-theme>；看不懂的值由 index.css 的 :root 退回午夜藍
// （index.contrast.test.ts 驗），src/lib/theme.ts 的 initTheme() 再修正。這裡把腳本從 index.html 取出來真的執行一次
const HTML = import.meta.glob("/index.html", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const script = (() => {
  const html = HTML["/index.html"];
  if (typeof html !== "string") throw new Error("glob 沒讀到 index.html");   // 讀不到要炸，不能靜默跳過
  // 沒有 src 的 <script> 只有這一段（另一段是 type="module" src="/src/main.tsx"）
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (inline.length !== 1) throw new Error(`index.html 應該剛好一段內聯腳本，找到 ${inline.length} 段`);
  return inline[0];
})();
const run = () => new Function(script)();

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "nightfall";
});
afterEach(() => vi.unstubAllGlobals());

describe("index.html 的主題啟動腳本", () => {
  it("用的儲存鍵跟 themeIds.ts 一致", () => {
    expect(script).toContain(`localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})`);
  });

  it("存過主題：搬進 <html data-theme>", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "daylight-warm");
    run();
    expect(document.documentElement.dataset.theme).toBe("daylight-warm");
  });

  it("沒存過：不動（維持 index.html 寫死的午夜藍）", () => {
    run();
    expect(document.documentElement.dataset.theme).toBe("nightfall");
  });

  it("localStorage 讀取丟例外：不丟出去、不動", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError"); } });
    expect(() => run()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("nightfall");
  });

  it("index.html 預設是午夜藍", () => {
    expect(HTML["/index.html"]).toMatch(/<html[^>]*\sdata-theme="nightfall"/);
  });
});

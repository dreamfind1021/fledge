import { describe, expect, it } from "vitest";

// 顏色一律走 token 的防線（票 18）。
//
// index.contrast.test.ts 守的是「token 的值夠不夠亮」，守不到三種「根本沒走 token」的形狀：
//
//   1. 引用一個不存在的 token：`var(--text-2, #c8c8cc)` 在 CSS 裡完全合法，
//      fallback 會安靜地渲染出來，而它不跟著主題走。2026-09-09 掃出兩條，
//      其中 `--accent` 的 #7aa2f7 是 Nightfall 之前舊配色的殘留。
//   2. 已定義的 token 還給 fallback：那個 fallback 永遠不會生效，卻長得像安全網。
//      舊值與真值只差 1.02~1.07，token 真的掉了畫面也只會悄悄換一套灰，沒人會發現。
//   3. 直接寫 hex：切主題時不會跟著換。
//
// 三種都是人眼看不出來的，只能用測試守。
const RAW = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const indexCss = (() => {
  const t = RAW["/src/index.css"];
  if (typeof t !== "string") throw new Error("glob 沒讀到 index.css");   // 讀不到要炸，不能靜默跳過
  return t;
})();
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// index.css 是 token 的唯一定義處（元件 CSS 目前一個區域變數都沒有）
const DEFINED = new Set([...stripComments(indexCss).matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));

const eachRule = function* () {
  for (const [path, css] of Object.entries(RAW)) yield [path, stripComments(css)] as const;
};

describe("每個 var(--x) 都要有定義", () => {
  it("CSS 引用的 token 都在 index.css 定義過", () => {
    const orphans: string[] = [];
    let scanned = 0;
    for (const [path, css] of eachRule()) {
      for (const m of css.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
        scanned += 1;
        if (!DEFINED.has(m[1])) orphans.push(`${path} → var(--${m[1]})`);
      }
    }
    // 掃到 0 條會讓迴圈空轉而測試全綠——先確認 regex 真的有命中
    expect(scanned).toBeGreaterThan(200);
    expect(orphans).toEqual([]);
  });
});

describe("已定義的 token 不得再給 fallback", () => {
  it("var(--x, 值) 只准出現在 token 尚未定義的地方", () => {
    const dead: string[] = [];
    for (const [path, css] of eachRule()) {
      for (const m of css.matchAll(/var\(\s*--([a-z0-9-]+)\s*,([^)]*)\)/g)) {
        if (DEFINED.has(m[1])) dead.push(`${path} → var(--${m[1]}, ${m[2].trim()})`);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe("顏色不得寫死在元件 CSS", () => {
  // rgba() 不在此列：陰影用半透明黑是跨主題通用的，不是配色決定
  it("index.css 以外的 CSS 不得出現 hex 色碼", () => {
    const hardcoded: string[] = [];
    for (const [path, css] of eachRule()) {
      if (path === "/src/index.css") continue;
      for (const m of css.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) hardcoded.push(`${path} → ${m[0]}`);
    }
    expect(hardcoded).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { nightfallBlock, splitTop } from "./testing/cssRules";

// 外殼（側欄、分頁列、浮層）的樣式防線——票 28 第一批，spec docs/planning/soft-tiles-app-wide-design.md §2.6。
// jsdom 不做版面計算、不套 CSS，這裡只能讀 CSS 原始碼驗宣告；畫面由 headless 截圖與真機驗收看。

// spec G5：弱柔光直接併進三個陰影 token（使用者全是浮起來的東西）。整串比對（Codex spec R1）：
// 只驗第一層的話，把整個 token 換成只剩柔光也會全綠，而原本負責把浮層托起來的深色陰影就沒了
describe("三個陰影 token 帶弱柔光（spec G5、§2.6-3）", () => {
  const GLOW = "0 0 8px 0 color-mix(in srgb, var(--text) 6%, transparent)";
  const layers = (name: string) => {
    // `--shadow:` 後面緊接冒號，不會誤抓 `--shadow-sm:`
    const m = nightfallBlock.match(new RegExp(`--${name}:\\s*([^;]+);`));
    if (!m) throw new Error(`nightfall 區塊找不到 --${name}`);
    return splitTop(m[1]).map((s) => s.replace(/\s+/g, " "));
  };
  // 兩個參數型別不同（名稱是字串、期望是陣列）——不寫泛型的話 TS 會把兩個參數都推成 string | string[]，tsc 報錯
  it.each<[string, string[]]>([
    ["shadow", [GLOW, "0 1px 2px rgba(0,0,0,.4)", "0 18px 46px rgba(0,0,0,.5)"]],
    ["shadow-sm", [GLOW, "0 4px 18px rgba(0,0,0,.35)"]],
    ["modal-shadow", [GLOW, "0 24px 70px rgba(0,0,0,.6)"]],
  ])("--%s ＝ 柔光層＋原本的每一層", (name, expected) => {
    expect(layers(name)).toEqual(expected);
  });
});

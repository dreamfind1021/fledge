import { describe, expect, it } from "vitest";

// 待辦總覽的窄視窗版面防線。
//
// 為什麼不用 scrollWidth/clientWidth：jsdom 不做版面計算，兩者恆為 0，
// `expect(scrollWidth).toBeLessThanOrEqual(clientWidth)` 變成 0 <= 0，
// 不管 CSS 怎麼改都綠——那是假綠，不是防線。
//
// 所以這裡驗的是 CSS 裡的**數值預算**與**規則存在性**，
// 真正的版面由 headless Chrome 實測（2026-09-02 量到：側邊欄展開時
// 視窗 626px 下一步整欄消失、576px 出現水平捲軸）。
const RAW = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const tasksCss = (() => {
  const text = RAW["/src/components/Tasks.css"];
  if (typeof text !== "string") throw new Error("glob 沒讀到 Tasks.css");   // 讀不到要炸，不能靜默跳過
  return text;
})();
const stripped = tasksCss.replace(/\/\*[\s\S]*?\*\//g, "");

// 取 @container 區塊的內容。找不到就炸——靜默跳過等於這條防線沒上場。
// 刻意做成函式而不是模組層級的常數：模組層級丟例外會讓整個檔案收集失敗（vitest 報
// "no tests"），三條斷言變成一個看不出是哪條壞掉的錯誤。
const narrowBlock = () => {
  const m = stripped.match(/@container[^{]*\{([\s\S]*)\n\}/);
  if (!m) throw new Error("Tasks.css 找不到 @container 區塊");
  return m[1];
};
// 從一段 CSS 文字裡取某個選擇器某個屬性的值
const decl = (css: string, selector: string, prop: string) => {
  const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .find((m) => m[1].split(",").map((x) => x.trim()).includes(selector));
  if (!rule) throw new Error(`找不到規則 ${selector}`);
  const m = rule[2].match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  if (!m) throw new Error(`${selector} 沒有宣告 ${prop}`);
  return m[1].trim();
};
const px = (v: string) => {
  const m = v.match(/(\d+(?:\.\d+)?)px/);
  if (!m) throw new Error(`取不出 px：${v}`);
  return parseFloat(m[1]);
};

describe("待辦總覽的窄視窗版面", () => {
  // 用 container query 不是 media query：側邊欄收合會讓同一個視窗寬度多出 184px
  // （240 → 56），viewport 斷點會在錯的時機觸發
  it(".tasks-root 是 container query 的容器", () => {
    expect(decl(stripped, ".tasks-root", "container-type")).toBe("inline-size");
  });

  it("窄的時候下一步換到第二行，名稱改成可縮", () => {
    expect(decl(narrowBlock(), ".tov-row", "flex-wrap")).toBe("wrap");
    expect(decl(narrowBlock(), ".tov-next", "flex-basis")).toBe("100%");
    // 名稱在寬模式是 width:180px + flex-shrink:0，窄模式必須讓得出空間
    expect(px(decl(narrowBlock(), ".tov-name", "min-width"))).toBeLessThanOrEqual(100);
  });

  // 窄模式第一行 = 名稱(min) + gap + 計數。這個和決定水平捲軸何時出現，
  // 有人把任何一個數字調大都應該被擋下來
  it("窄模式第一行的最小寬度在預算內", () => {
    const nameMin = px(decl(narrowBlock(), ".tov-name", "min-width"));
    const count = px(decl(stripped, ".tov-count", "width"));
    const gap = px(decl(stripped, ".tov-row", "gap"));
    const rowPad = px(decl(stripped, ".tov-row", "padding")) * 2;
    expect(nameMin + gap + count + rowPad).toBeLessThanOrEqual(240);
  });
});

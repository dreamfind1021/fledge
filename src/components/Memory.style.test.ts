import { describe, expect, it } from "vitest";
import { baseOf, cssRules, decl, hasDecl, lastDecl, resolveColor, token, worst } from "../testing/cssRules";

// 記憶面板的樣式防線——票 28 第二批，spec docs/planning/soft-tiles-app-wide-design.md §3.6。
// jsdom 不套 CSS，這裡只能讀 CSS 原始碼驗宣告；畫面由 headless 截圖與真機驗收看。
// div／span／pre 類斷言「沒有這個宣告」（hasDecl：規則本身必須存在，規則不見就炸）；
// <input>／<button> 類斷言 border 存在而且是 none（lastDecl：刪掉這行會冒出瀏覽器預設外框，spec G9）
const mem = baseOf("/src/components/Memory.css");
const { paintToken } = cssRules(mem);
// 半透明底色（color-mix(…, transparent)）疊在不透明底色上，等於直接跟那個底色在 sRGB 混——
// 所以把 transparent 換成它實際坐落的那層底色（從 CSS 讀）再算（spec §3.6）
const over = (expr: string, backdrop: string) => resolveColor(expr.replace("transparent", backdrop));

describe("搜尋框：拿掉外框，焦點改成 2px 環（spec M1、M2）", () => {
  it("<input> 寫 border: none（G9）", () => {
    expect(lastDecl(mem, ".mi-search", "border")).toBe("none");
  });

  it("焦點：outline: none＋2px 環，不再靠外框變色（G7）", () => {
    expect(decl(mem, ".mi-search:focus", "outline")).toBe("none");
    expect(decl(mem, ".mi-search:focus", "box-shadow")).toBe("0 0 0 2px var(--focus)");
    expect(hasDecl(mem, ".mi-search:focus", "border-color")).toBe(false);
  });
});

describe("篩選小籤：拿掉外框，選中改成淡橘底橘字（spec M4）", () => {
  it("<button> 寫 border: none（G9）", () => {
    expect(lastDecl(mem, ".fchip", "border")).toBe("none");
  });

  it("選中：淡橘底、橘字，不再用外框帶顏色", () => {
    expect(decl(mem, ".fchip.on", "background")).toBe("color-mix(in srgb, var(--primary) 18%, transparent)");
    expect(decl(mem, ".fchip.on", "color")).toBe("var(--primary)");
    expect(hasDecl(mem, ".fchip.on", "border-color")).toBe(false);
  });

  // spec §3.5 第一列：底是半透明，疊在面板底色（.mem-root 的 background）上算
  it("選中的橘字對淡橘底至少 4.5:1", () => {
    const bg = over(decl(mem, ".fchip.on", "background"), decl(mem, ".mem-root", "background"));
    expect(worst(token(paintToken(".fchip.on", "color")), bg)).toBeGreaterThanOrEqual(4.5);
  });
});

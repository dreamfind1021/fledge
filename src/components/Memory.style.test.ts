import { describe, expect, it } from "vitest";
import { baseOf, cssRules, decl, hasDecl, lastDecl, resolveColor, token, worst } from "../testing/cssRules";

// 記憶面板的樣式防線——票 28 第二批，spec docs/planning/soft-tiles-app-wide-design.md §3.6。
// jsdom 不套 CSS，這裡只能讀 CSS 原始碼驗宣告；畫面由 headless 截圖與真機驗收看。
// div／span／pre 類斷言「沒有這個宣告」（hasDecl：規則本身必須存在，規則不見就炸）；
// <input>／<button> 類斷言 border 存在而且是 none（lastDecl：刪掉這行會冒出瀏覽器預設外框，spec G9）
const mem = baseOf("/src/components/Memory.css");
const { paintToken, paintColor } = cssRules(mem);
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

describe("兩欄：右欄浮起成卡片，兩條分隔線拿掉（spec M3）", () => {
  it("兩欄之間與左欄標題下沒有分隔線", () => {
    expect(hasDecl(mem, ".mem-index", "border-right")).toBe(false);
    expect(hasDecl(mem, ".mem-index", "border")).toBe(false);
    expect(hasDecl(mem, ".mi-head", "border-bottom")).toBe(false);
    expect(hasDecl(mem, ".mi-head", "border")).toBe(false);
  });

  // 與待辦抽屜 .tasks-col-detail 同值，但各自寫死、不跨檔比對（spec §3.7，Codex spec R1）
  it("右欄是浮起的圓角卡片", () => {
    expect(decl(mem, ".mem-detail", "margin")).toBe("12px 12px 12px 6px");
    expect(decl(mem, ".mem-detail", "background")).toBe("var(--surface)");
    expect(decl(mem, ".mem-detail", "border-radius")).toBe("18px");
    expect(decl(mem, ".mem-detail", "box-shadow")).toBe("var(--shadow)");
  });
});

describe("全文框、相關小籤、出錯的紅框（spec M5、M6）", () => {
  it("全文框與相關小籤是凹進卡片的暗磚，沒有外框", () => {
    expect(decl(mem, ".md-body", "background")).toBe("var(--bg)");
    expect(hasDecl(mem, ".md-body", "border")).toBe(false);
    expect(decl(mem, ".relchip", "background")).toBe("var(--bg)");
    expect(hasDecl(mem, ".relchip", "border")).toBe(false);
  });

  it("出錯的紅框改畫內側一圈，混色寫法照舊（M6）", () => {
    // 用 lastDecl：驗紅會把這行刪掉，decl 會紅在「沒有宣告」的例外、不是紅在斷言（Codex spec R1）
    expect(lastDecl(mem, ".relchip.sug.err", "box-shadow")).toBe("inset 0 0 0 1px color-mix(in srgb, var(--error) 45%, var(--border))");
    expect(hasDecl(mem, ".relchip.sug.err", "border-color")).toBe(false);
    expect(hasDecl(mem, ".relchip.sug.err", "border")).toBe(false);
  });
});

// spec §3.5：卡片與暗磚上的字。前景從 CSS 的 color 讀、背景從 CSS 的 background 讀，不在測試裡寫死用哪個 token
describe("卡片與暗磚上的字（spec §3.5）", () => {
  it.each([
    ["麵包屑", ".md-crumb", ".mem-detail"],
    ["小標", ".md-h", ".mem-detail"],
    ["空狀態", ".md-empty", ".mem-detail"],
    ["摘要", ".md-meta", ".mem-detail"],
    ["全文", ".md-body", ".md-body"],
    ["相關小籤的字", ".relchip", ".relchip"],
    ["建議小籤的 ✓✕", ".relchip.sug .yn button", ".relchip"],
    ["小籤的 ◈", ".relchip .ic", ".relchip"],
    ["「建議」字樣", ".relchip .sg", ".relchip"],
    ["「儲存失敗：」", ".relchip .cerr", ".relchip"],
  ])("%s 對背景至少 4.5:1", (_label, fgSelector, bgSelector) => {
    expect(worst(token(paintToken(fgSelector, "color")), paintColor(bgSelector, "background"))).toBeGreaterThanOrEqual(4.5);
  });

  // 徽章的底是半透明，疊在卡片（.mem-detail 的 background）上算
  it.each([
    ["native 徽章", ".md-crumb .badge.b-native"],
    ["KMS 徽章", ".md-crumb .badge.b-kms"],
  ])("%s：字對半透明底至少 4.5:1", (_label, selector) => {
    const bg = over(decl(mem, selector, "background"), decl(mem, ".mem-detail", "background"));
    expect(worst(token(paintToken(selector, "color")), bg)).toBeGreaterThanOrEqual(4.5);
  });
});

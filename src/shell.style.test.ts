import { describe, expect, it } from "vitest";
import { baseLevel, decl, decls, hasDecl, nightfallBlock, readCss, splitTop, stripComments } from "./testing/cssRules";

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

// 讀某份 CSS 的基礎等級（去註解、拿掉 @media／@container／@keyframes）
const baseOf = (path: string) => baseLevel(stripComments(readCss(path)));
// <button> 類用這個斷言「border 存在而且是 none」：宣告被刪掉時回 undefined，紅在斷言、不是紅在例外（spec G9）
const lastDecl = (text: string, selector: string, prop: string) => decls(text, selector, prop).slice(-1)[0];

// spec §2.2 前半。div 類斷言「沒有這個宣告」（hasDecl：規則本身必須存在，規則不見就炸）；
// <button> 類斷言 border 存在而且是 none（G9：刪掉這行會冒出瀏覽器預設外框，Codex spec R3）
describe("外殼：側欄浮起、主區與分頁列（spec §2.2、S1–S4、S7）", () => {
  const app = baseOf("/src/App.css");
  const sidebar = baseOf("/src/components/Sidebar.css");
  const workspace = baseOf("/src/components/Workspace.css");
  const tabbar = baseOf("/src/components/TabBar.css");

  it("視窗與主區的底色是終端機的顏色，主區左邊 5px 縫", () => {
    expect(decl(app, ".app-root", "background")).toBe("var(--term-bg)");
    expect(decl(workspace, ".ws-main", "background")).toBe("var(--term-bg)");
    expect(decl(workspace, ".ws-main", "padding-left")).toBe("5px");
  });

  it("側欄是浮起的圓角卡片，沒有分隔線", () => {
    expect(decl(sidebar, ".sidebar", "margin")).toBe("5px 0 5px 5px");
    expect(decl(sidebar, ".sidebar", "border-radius")).toBe("16px");
    expect(decl(sidebar, ".sidebar", "box-shadow")).toBe("var(--shadow)");
    expect(decl(sidebar, ".sidebar", "height")).toBe("auto");
    expect(hasDecl(sidebar, ".sidebar", "border-right")).toBe(false);
    expect(hasDecl(sidebar, ".sidebar", "border")).toBe(false);
  });

  // Review Focus 2：收合的細條沿用同一張卡片——.is-collapsed 只改寬度與對齊
  it("收合的細條不覆寫卡片的縫、圓角、陰影、高度", () => {
    for (const prop of ["margin", "border-radius", "box-shadow", "height"]) {
      expect(hasDecl(sidebar, ".sidebar.is-collapsed", prop)).toBe(false);
    }
  });

  it("側欄內部的橫線與外框拿掉；按鈕寫 border: none", () => {
    expect(hasDecl(sidebar, ".sidebar-foot", "border-top")).toBe(false);
    expect(hasDecl(sidebar, ".sidebar-rail-foot", "border-top")).toBe(false);
    expect(hasDecl(sidebar, ".sidebar-search .kbd", "border")).toBe(false);
    expect(lastDecl(sidebar, ".sidebar-search", "border")).toBe("none");
    expect(lastDecl(sidebar, ".sidebar-dash-btn", "border")).toBe("none");
  });

  // Review Focus 1：拿掉常態外框不能連焦點框一起拿掉（G7）
  it("拿掉外框的側欄按鈕仍有鍵盤焦點框", () => {
    expect(decl(sidebar, ".sidebar-search:focus-visible", "outline")).toBe("2px solid var(--focus)");
    expect(decl(sidebar, ".sidebar-dash-btn:focus-visible", "outline")).toBe("2px solid var(--focus)");
  });

  it("沒作用的 .sidebar-openbtn--ghost 整段刪掉（S7）", () => {
    expect(stripComments(readCss("/src/components/Sidebar.css"))).not.toContain(".sidebar-openbtn--ghost");
  });

  it("分頁列：左邊留白 0、選中分頁只靠琥珀底、分頁之間沒有分隔線", () => {
    expect(decl(tabbar, ".workspace .tabbar", "padding")).toBe("8px 12px 0 0");
    expect(decl(tabbar, ".workspace .tabbar-tab.is-active", "border")).toBe("1px solid transparent");
    expect(hasDecl(tabbar, ".workspace .tabbar-tab.is-active", "border-bottom")).toBe(false);
    expect(hasDecl(tabbar, ".tabbar-tab", "border-right")).toBe(false);
  });
});

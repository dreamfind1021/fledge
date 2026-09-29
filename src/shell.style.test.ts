import { describe, expect, it } from "vitest";
import { baseOf, cssRules, decl, hasDecl, lastDecl, lineTokenHits, nightfallBlock, readCss, splitTop, stripComments, token, worst } from "./testing/cssRules";

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

// spec §2.2 後半：浮層（蓋在畫面上的東西）不用外框，靠底色＋陰影＋弱柔光浮起來（G4）
describe("浮層拿掉外框（spec G4、G6、S5、S8）", () => {
  const app = baseOf("/src/App.css");
  const related = baseOf("/src/components/RelatedFloat.css");
  const menu = baseOf("/src/components/ContextMenu.css");

  it("選單、對話框、通知、相關面板與連結列沒有外框", () => {
    expect(hasDecl(menu, ".ctx-menu", "border")).toBe(false);
    expect(hasDecl(app, ".confirm-modal", "border")).toBe(false);
    expect(hasDecl(app, ".app-toast", "border")).toBe(false);
    expect(hasDecl(related, ".rf-panel", "border")).toBe(false);
    expect(hasDecl(related, ".rf-link", "border")).toBe(false);
  });

  it("確認框按鈕列上方不用橫線，改靠間距", () => {
    expect(hasDecl(app, ".confirm-foot", "border-top")).toBe(false);
    expect(decl(app, ".confirm-foot", "padding")).toBe("4px 20px 14px");
  });

  it("「相關」浮鈕：<button> 寫 border: none，滑過改換底色", () => {
    expect(lastDecl(related, ".rf-fab", "border")).toBe("none");
    expect(hasDecl(related, ".rf-fab:hover", "border-color")).toBe(false);
    expect(decl(related, ".rf-fab:hover", "background")).toBe("var(--hover)");
  });

  it("「取消」是實心次要鍵：--surface-2 底、--text 字、border: none，滑過 --active，焦點框照舊（G6、G7）", () => {
    expect(lastDecl(app, ".confirm-btn-ghost", "border")).toBe("none");
    expect(decl(app, ".confirm-btn-ghost", "background")).toBe("var(--surface-2)");
    expect(decl(app, ".confirm-btn-ghost", "color")).toBe("var(--text)");
    expect(decl(app, ".confirm-btn-ghost:hover", "background")).toBe("var(--active)");
    expect(decl(app, ".confirm-btn-ghost:focus-visible", "outline")).toBe("2px solid var(--focus)");
  });

  // spec §2.5：背景從 CSS 讀（paintColor），不在測試裡寫死用哪個 token
  it.each([
    ["「取消」文字", "/src/App.css", ".confirm-btn-ghost", ".confirm-btn-ghost"],
    ["「取消」文字（滑過）", "/src/App.css", ".confirm-btn-ghost", ".confirm-btn-ghost:hover"],
    ["「相關」浮鈕文字（滑過）", "/src/components/RelatedFloat.css", ".rf-fab", ".rf-fab:hover"],
  ])("%s 對背景至少 4.5:1", (_label, path, fgSelector, bgSelector) => {
    const { paintToken, paintColor } = cssRules(baseOf(path));
    expect(worst(token(paintToken(fgSelector, "color")), paintColor(bgSelector, "background"))).toBeGreaterThanOrEqual(4.5);
  });
});

// spec §1.5／§2.6-1：防的是「以後不小心把線加回來」——最可能的形狀是新增元件時照抄舊寫法
// `border: 1px solid var(--border)`。定點斷言只看得到既有的選擇器，這條連新增的選擇器也看得到。
// 不防刻意繞過（寫死顏色另有 index.tokens.test.ts 擋；TSX inline style 靠審查）。
describe("第一批的 CSS 不再引用分隔線 token（spec §1.5、§2.6）", () => {
  const FILES = [
    "/src/App.css",
    "/src/components/Sidebar.css",
    "/src/components/FileTree.css",
    "/src/components/TabBar.css",
    "/src/components/Workspace.css",
    "/src/components/Terminal.css",
    "/src/components/RelatedFloat.css",
    "/src/components/ContextMenu.css",
  ];
  it("--divider／--term-divider 零次；--border 只剩側欄捲軸的顏色", () => {
    const { hits } = lineTokenHits(FILES);
    // 不另斷言 scanned：期望的 hits 本身非空，掃描空轉時這條 toEqual 就會紅（票 34，同 Memory.style.test.ts）
    expect(hits).toEqual(["/src/components/Sidebar.css .sidebar-scroll::-webkit-scrollbar-thumb → background: var(--border)"]);
  });
});

import { describe, expect, it } from "vitest";
import { baseLevel, containerBlock, decl, readCss, stripComments } from "../testing/cssRules";

// 觀測面板窄窗口的版面防線（票 35，設計見 docs/planning/demos/2026-09-29-dashboard-narrow/README.md）。
// 同 Tasks.layout.test.ts 的理由：jsdom 不做版面計算，這裡只驗 CSS 的規則存在性與值；
// 真正的版面由 headless Chrome 量（數字記在 Dashboard.css 檔尾寬版區塊的註解）與真機驗收看。
// mobile-first：基礎等級＝窄（預設窗口 800 落在這裡），@container dash (min-width: 720px) 還原寬版
const full = stripComments(readCss("/src/components/Dashboard.css"));
const css = baseLevel(full);
const wide = () => containerBlock(full, "dash", 720);

describe("觀測面板窄窗口：數字卡、兩欄的列、專案表（票 35 第 1、2、4 題）", () => {
  it(".dash-root 是 container query 的容器（側欄可收合，不能用 viewport 斷點）", () => {
    expect(decl(css, ".dash-root", "container-type")).toBe("inline-size");
    expect(decl(css, ".dash-root", "container-name")).toBe("dash");
  });

  it("窄（預設）：數字卡三張一排、兩欄的列上下疊、專案表不顯示路徑", () => {
    expect(decl(css, ".dash-kpi", "grid-template-columns")).toBe("repeat(3, 1fr)");
    expect(decl(css, ".dash-row", "grid-template-columns")).toBe("1fr");
    expect(decl(css, ".dash-proj-path", "display")).toBe("none");
  });

  it("寬（≥720）：一排五張、模型分布＋時段活動 1:1.3 並排、顯示路徑", () => {
    const b = wide();
    expect(decl(b, ".dash-kpi", "grid-template-columns")).toBe("repeat(5, 1fr)");
    expect(decl(b, ".dash-row", "grid-template-columns")).toBe("1fr 1.3fr");
    expect(decl(b, ".dash-proj-path", "display")).toBe("block");
  });

  it("專案表：表頭、金額、時間不斷行；專案名可以從任何字元折行（窗口比 800 更窄時表格不伸出卡片）", () => {
    expect(decl(css, ".dash-table th", "white-space")).toBe("nowrap");
    expect(decl(css, ".dash-table td", "white-space")).toBe("nowrap");
    expect(decl(css, ".dash-table td:first-child", "white-space")).toBe("normal");
    expect(decl(css, ".dash-proj-name", "overflow-wrap")).toBe("anywhere");
  });
});

describe("Codex 一整條：多個窗口共用一組欄寬（票 46，spec §4.3）", () => {
  // 取代票 35 第 3 題的兩行排法：一整條佔整排寬，名稱｜進度條｜百分比共用同一組欄寬，每條進度條一樣長
  it("窗口清單是 auto 1fr auto 的 grid；放不下一行時標題自己一行（flex-wrap、清單最少 240px）", () => {
    expect(decl(css, ".dash-cx-rows", "grid-template-columns")).toBe("auto 1fr auto");
    expect(decl(css, ".dash-cx-strip", "flex-wrap")).toBe("wrap");
    expect(decl(css, ".dash-cx-rows", "min-width")).toBe("240px");
  });

  // 標題跟清單同一行時，英文「未歸屬用量」那一行的數字把條擠到 35px（正式 CSS、面板 546px＝預設窗口 800 量；
  // spec 5.5，demo docs/planning/demos/2026-10-23-codex-unattributed-stale 放法 3）。標題自己一行後是 194px
  it("窄（預設窗口 800）：標題自己一行、清單用整張卡寬；寬（≥720）還原成同一行", () => {
    expect(decl(css, ".dash-cx-strip > .dash-win-title", "flex-basis")).toBe("100%");
    expect(decl(wide(), ".dash-cx-strip > .dash-win-title", "flex-basis")).toBe("auto");
  });
});

describe("模型分布的排名長條（票 46，spec §4.5）", () => {
  // 名稱一欄寬＝最長的名稱、軌道吃剩下的：各列軌道左緣對齊、一樣長（取代圓餅與票 35 第 5 題的中間總額字級）
  it("名稱欄 max-content、軌道 1fr", () => {
    expect(decl(css, ".dash-mbars", "grid-template-columns")).toBe("max-content 1fr");
  });
});

describe("每日成本的最高金額與頭尾日期（票 46，spec §4.4）", () => {
  // 位置由 TSX 給 left: x%＋translateX(-x%)：這裡守的是「它們是疊在圖上的絕對定位、不斷行」，
  // 圖上方留 16px 給最高金額。標籤彼此不相交、不越界由 headless Chrome 量
  it("圖上方留 16px；最高金額與日期都是絕對定位、不斷行", () => {
    expect(decl(css, ".dash-daily-wrap", "padding-top")).toBe("16px");
    expect(decl(css, ".dash-daily-wrap", "position")).toBe("relative");
    expect(decl(css, ".dash-daily-peak", "position")).toBe("absolute");
    expect(decl(css, ".dash-daily-peak", "white-space")).toBe("nowrap");
    expect(decl(css, ".dash-daily-axis", "position")).toBe("relative");
    expect(decl(css, ".dash-daily-axis > span", "position")).toBe("absolute");
    expect(decl(css, ".dash-daily-axis > span", "white-space")).toBe("nowrap");
  });
});

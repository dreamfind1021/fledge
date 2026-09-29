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

  it("窄（預設）：數字卡三張一排、兩列上下疊（含每日成本＋Codex 那一列）、專案表不顯示路徑", () => {
    expect(decl(css, ".dash-kpi", "grid-template-columns")).toBe("repeat(3, 1fr)");
    expect(decl(css, ".dash-row", "grid-template-columns")).toBe("1fr");
    // .dash-row-usage 跟 .dash-row 權重相同、寫在後面：窄的時候真正生效的是它在基礎等級的欄寬
    expect(decl(css, ".dash-row-usage", "grid-template-columns")).toBe("1fr");
    expect(decl(css, ".dash-proj-path", "display")).toBe("none");
  });

  it("寬（≥720）：一排五張、兩列並排（每日成本＋Codex 1.5:1、圓餅＋時段 1:1.3）、顯示路徑", () => {
    const b = wide();
    expect(decl(b, ".dash-kpi", "grid-template-columns")).toBe("repeat(5, 1fr)");
    expect(decl(b, ".dash-row", "grid-template-columns")).toBe("1fr 1.3fr");
    expect(decl(b, ".dash-row-usage", "grid-template-columns")).toBe("1.5fr 1fr");
    expect(decl(b, ".dash-proj-path", "display")).toBe("block");
  });

  it("專案表：表頭、金額、時間不斷行；專案名可以從任何字元折行（窗口比 800 更窄時表格不伸出卡片）", () => {
    expect(decl(css, ".dash-table th", "white-space")).toBe("nowrap");
    expect(decl(css, ".dash-table td", "white-space")).toBe("nowrap");
    expect(decl(css, ".dash-table td:first-child", "white-space")).toBe("normal");
    expect(decl(css, ".dash-proj-name", "overflow-wrap")).toBe("anywhere");
  });
});

describe("Codex 額度條任何寬度都兩行（票 35 第 3 題）", () => {
  // 一行排法時條寬＝卡寬扣掉右邊的百分比與重置時間：重置時間長短不同，兩條就不一樣長，窗口 800 時還會被擠到 0
  it("上面一行名稱在左、百分比與重置時間在右，下面一行整條進度條", () => {
    expect(decl(css, ".dash-gauge", "grid-template-columns")).toBe("1fr auto");
    expect(decl(css, ".dash-gauge", "grid-template-areas")).toBe('"label meta" "bar bar"');
    expect(decl(css, ".dash-gauge-label", "grid-area")).toBe("label");
    expect(decl(css, ".dash-gauge > .dash-bar", "grid-area")).toBe("bar");
    expect(decl(css, ".dash-gauge-meta", "grid-area")).toBe("meta");
  });
});

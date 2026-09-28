import { describe, expect, it } from "vitest";
import { baseOf, cssRules, hasDecl, token, worst } from "../testing/cssRules";

// 觀測面板的樣式防線——票 28 第三批，spec docs/planning/soft-tiles-app-wide-design.md §4.6。
// jsdom 不套 CSS，這裡只能讀 CSS 原始碼驗宣告；畫面由 headless 截圖與真機驗收看。
// 觀測面板沒有 <button>／<input>，拿掉的線全在 div／span／th／td／li 上：一律斷言「沒有這個宣告」
// （hasDecl：規則本身必須存在，規則不見就炸）。縫、陰影、底色、圓角這些值不斷言——它們不防線被加回來（spec §4.6）
const dash = baseOf("/src/components/Dashboard.css");
const { paintToken, paintColor } = cssRules(dash);

describe("卡片與「資料更新中」小籤拿掉外框（spec D1、D4）", () => {
  it("數字卡、額度卡、面板沒有外框", () => {
    expect(hasDecl(dash, ".dash-kpi-card", "border")).toBe(false);
    expect(hasDecl(dash, ".dash-win-card", "border")).toBe(false);
    expect(hasDecl(dash, ".dash-panel", "border")).toBe(false);
  });

  it("「資料更新中」小籤沒有外框", () => {
    expect(hasDecl(dash, ".dash-stale", "border")).toBe(false);
  });

  // spec §4.5 第一列。底色從 CSS 讀：宣告被刪掉時讀不到而紅——小籤底色的間接防線（spec §4.6）
  it("小籤的灰字對自己的底至少 4.5:1", () => {
    expect(worst(token(paintToken(".dash-stale", "color")), paintColor(".dash-stale", "background"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("專案表每列一塊暗磚、圖例與長條滑過不畫線（spec D3、D5）", () => {
  it("表頭與每一列沒有列線", () => {
    expect(hasDecl(dash, ".dash-table th", "border-bottom")).toBe(false);
    expect(hasDecl(dash, ".dash-table th", "border")).toBe(false);
    expect(hasDecl(dash, ".dash-table td", "border-bottom")).toBe(false);
    expect(hasDecl(dash, ".dash-table td", "border")).toBe(false);
  });

  it("圓餅圖旁的圖例沒有行線", () => {
    expect(hasDecl(dash, ".dash-donut-legend li", "border-bottom")).toBe(false);
    expect(hasDecl(dash, ".dash-donut-legend li", "border")).toBe(false);
  });

  it("每日成本長條滑過不畫細框", () => {
    expect(hasDecl(dash, ".dash-daily-col:hover", "outline")).toBe(false);
  });

  // spec §4.5 第二、三列：字坐在每一列的暗磚上，底色從 .dash-table td 的 background 讀（暗磚底色的間接防線）。
  // 其他格沒有自己的 color、繼承 body 的 --text，跟專案名稱同一組，不另驗
  const row = () => paintColor(".dash-table td", "background");
  it("專案名稱對暗磚至少 4.5:1", () => {
    expect(worst(token(paintToken(".dash-proj-name", "color")), row())).toBeGreaterThanOrEqual(4.5);
  });

  it("合計對暗磚至少 4.5:1", () => {
    expect(worst(token(paintToken(".dash-td-total", "color")), row())).toBeGreaterThanOrEqual(4.5);
  });

  it("路徑對暗磚至少 4.5:1", () => {
    expect(worst(token(paintToken(".dash-proj-path", "color")), row())).toBeGreaterThanOrEqual(4.5);
  });
});

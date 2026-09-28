import { describe, expect, it } from "vitest";
import { baseOf, cssRules, decl, hasDecl, lastDecl, token, worst } from "../testing/cssRules";

// 待辦編輯器、⌘T、啟動錯誤框的樣式防線——票 28 第四批 4b，spec docs/planning/soft-tiles-app-wide-design.md §6.6。
// 涵蓋三個 CSS 檔：Tasks.css（整頁編輯器、提示條與刪除確認框的小按鈕、票內文的程式碼區塊）、ProjectPicker.css、Splash.css。
// Tasks.css 的對比放在 Tasks.contrast.test.ts（待辦面板的對比都在那裡），這裡只放 ⌘T 的對比。
// jsdom 不套 CSS，這裡只能讀 CSS 原始碼驗宣告；畫面由 demo 的樣式簽名比對與真機驗收看。
// div／pre／kbd 類斷言「沒有這個宣告」（hasDecl：規則本身必須存在，規則不見就炸）；
// <button> 類斷言 border 存在而且是 none（lastDecl：刪掉這行會冒出瀏覽器預設外框，spec G9）。
// 底色、滑過、opacity、換行這些值不斷言（spec §6.6）；唯一的例外是「儲存」的滑過（D8，守 cascade 的 bug）
const tasks = baseOf("/src/components/Tasks.css");
const pp = baseOf("/src/components/ProjectPicker.css");
const P = cssRules(pp);
const splash = baseOf("/src/components/Splash.css");

describe("待辦編輯器：外框與分隔線（spec §6 D1、D2）", () => {
  it("編輯器沒有外框", () => {
    expect(hasDecl(tasks, ".full-editor", "border")).toBe(false);
  });

  it("標題、工具列、底部列之間沒有線", () => {
    expect(hasDecl(tasks, ".ed-title", "border-bottom")).toBe(false);
    expect(hasDecl(tasks, ".ed-bar", "border-bottom")).toBe(false);
    expect(hasDecl(tasks, ".ed-foot", "border-top")).toBe(false);
  });
});

describe("待辦編輯器：按鈕（spec §6 D3、D7、D8）", () => {
  it("底部按鈕寫 border: none（G9）", () => {
    expect(lastDecl(tasks, ".btn", "border")).toBe("none");
  });

  it("工具鈕停用時不畫框（停用照 4a 半透明）", () => {
    expect(hasDecl(tasks, ".ed-btn:disabled", "border")).toBe(false);
  });

  // D8：.btn:hover:not(:disabled) 的權重 (0,3,0) 高於 .btn.is-primary (0,2,0)——少了這條同樣具體的滑過規則，
  // 滑過「儲存」橘底會被蓋成 --hover。唯一的值斷言：jsdom 模擬不了滑過，只能從宣告驗（spec §6.6）
  it("滑過「儲存」維持跟平常一樣的橘底", () => {
    expect(decl(tasks, ".btn.is-primary:hover:not(:disabled)", "background")).toBe(decl(tasks, ".btn.is-primary", "background"));
  });
});

describe("提示條與刪除確認框的小按鈕（spec §6 D6、D7）", () => {
  it("小按鈕寫 border: none（G9）", () => {
    expect(lastDecl(tasks, ".tk-confirm button", "border")).toBe("none");
    expect(lastDecl(tasks, ".tk-banner .bbtn", "border")).toBe("none");
  });
});

describe("票內文的程式碼區塊（spec §6 D4）", () => {
  it("程式碼區塊沒有外框", () => {
    expect(hasDecl(tasks, ".tk-md pre", "border")).toBe(false);
  });
});

describe("⌘T 專案切換與啟動錯誤框（spec §6 D5、D9）", () => {
  it("⌘T 卡片與底部小鍵帽沒有外框", () => {
    expect(hasDecl(pp, ".pal-card", "border")).toBe(false);
    expect(hasDecl(pp, ".pal-foot kbd", "border")).toBe(false);
  });

  it("⌘T 搜尋列下、底部列上沒有線", () => {
    expect(hasDecl(pp, ".pal-search", "border-bottom")).toBe(false);
    expect(hasDecl(pp, ".pal-foot", "border-top")).toBe(false);
  });

  it("啟動失敗的「詳細資訊」沒有外框", () => {
    expect(hasDecl(splash, ".splash-err-detail", "border")).toBe(false);
  });

  // spec §6.5：提示字與輸入的字坐在搜尋列的暗帶上，兩個顏色都從 CSS 讀
  it("⌘T 的提示字對搜尋列至少 4.5:1", () => {
    expect(worst(token(P.paintToken(".pal-search input::placeholder", "color")), P.paintColor(".pal-search", "background"))).toBeGreaterThanOrEqual(4.5);
  });

  it("⌘T 輸入的字對搜尋列至少 4.5:1", () => {
    expect(worst(token(P.paintToken(".pal-search input", "color")), P.paintColor(".pal-search", "background"))).toBeGreaterThanOrEqual(4.5);
  });
});

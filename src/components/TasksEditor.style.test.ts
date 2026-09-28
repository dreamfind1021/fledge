import { describe, expect, it } from "vitest";
import { baseOf, hasDecl } from "../testing/cssRules";

// 待辦編輯器、⌘T、啟動錯誤框的樣式防線——票 28 第四批 4b，spec docs/planning/soft-tiles-app-wide-design.md §6.6。
// 涵蓋三個 CSS 檔：Tasks.css（整頁編輯器、提示條與刪除確認框的小按鈕、票內文的程式碼區塊）、ProjectPicker.css、Splash.css。
// Tasks.css 的對比放在 Tasks.contrast.test.ts（待辦面板的對比都在那裡），這裡只放 ⌘T 的對比。
// jsdom 不套 CSS，這裡只能讀 CSS 原始碼驗宣告；畫面由 demo 的樣式簽名比對與真機驗收看。
// div／pre／kbd 類斷言「沒有這個宣告」（hasDecl：規則本身必須存在，規則不見就炸）；
// <button> 類斷言 border 存在而且是 none（lastDecl：刪掉這行會冒出瀏覽器預設外框，spec G9）。
// 底色、滑過、opacity、換行這些值不斷言（spec §6.6）；唯一的例外是「儲存」的滑過（D8，守 cascade 的 bug）
const tasks = baseOf("/src/components/Tasks.css");

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

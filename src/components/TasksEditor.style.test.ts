import { describe, expect, it } from "vitest";
import { THEMES } from "../lib/themeIds";
import { baseOf, cssRules, decl, hasDecl, lastDecl, lineTokenHits, token, worst } from "../testing/cssRules";

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
  it.each(THEMES)("%s：⌘T 的提示字對搜尋列至少 4.5:1", (theme) => {
    expect(worst(token(P.paintToken(".pal-search input::placeholder", "color"), theme), cssRules(pp, theme).paintColor(".pal-search", "background"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)("%s：⌘T 輸入的字對搜尋列至少 4.5:1", (theme) => {
    expect(worst(token(P.paintToken(".pal-search input", "color"), theme), cssRules(pp, theme).paintColor(".pal-search", "background"))).toBeGreaterThanOrEqual(4.5);
  });
});

// spec §1.5／§6.6：防的是「以後不小心把線加回來」——最可能的形狀是新增元件時照抄舊寫法
// `border: 1px solid var(--border)`。定點斷言只看得到既有的選擇器，這條連新增的選擇器也看得到；
// Tasks.css 掃整份，連同清單的部分一起守。不防刻意繞過（寫死顏色另有 index.tokens.test.ts 擋；TSX inline style 靠審查）。
describe("待辦、⌘T、啟動畫面的 CSS 不再引用分隔線 token（spec §1.5、§6.6）", () => {
  it("--border／--divider／--term-divider 只剩狀態訊號、停用虛線與捲軸七處，都不是分隔線", () => {
    const { hits } = lineTokenHits([
      "/src/components/Tasks.css",
      "/src/components/ProjectPicker.css",
      "/src/components/Splash.css",
    ]);
    // 期望清單非空：掃描迴圈失效時 hits 變空、toEqual 會紅，不另外斷言 scanned（spec §6.6）
    expect(hits).toEqual([
      "/src/components/Tasks.css .tk-flagbody → border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border))",
      "/src/components/Tasks.css .tk-md blockquote → border-left: 2px solid var(--border)",
      "/src/components/Tasks.css .tasks-new-input:disabled → outline: 1px dashed var(--border)",
      "/src/components/Tasks.css .tk-confirm → border: 1px solid color-mix(in srgb, var(--error) 40%, var(--border))",
      "/src/components/Tasks.css .tk-banner.is-draft → border: 1px solid color-mix(in srgb, var(--warning) 32%, var(--border))",
      "/src/components/Tasks.css .tk-banner.is-conflict → border: 1px solid color-mix(in srgb, var(--error) 38%, var(--border))",
      "/src/components/ProjectPicker.css .pal-list::-webkit-scrollbar-thumb → background: var(--border)",
    ]);
  });
});

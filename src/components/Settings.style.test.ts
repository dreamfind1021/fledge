import { describe, expect, it } from "vitest";
import { baseOf, cssRules, decl, hasDecl, lastDecl, lineTokenHits, over, token, worst } from "../testing/cssRules";

// 設定視窗與引導精靈的樣式防線——票 28 第四批 4a，spec docs/planning/soft-tiles-app-wide-design.md §5.6。
// 涵蓋六個 CSS 檔：Settings.css、AccountsEditor.css、BackupCard.css、RestoreCard.css、LangSwitch.css、Onboarding.css
// （Onboarding.css 的 b4-* 設定視窗的開發環境、備份、還原卡片也在用）。
// jsdom 不套 CSS，這裡只能讀 CSS 原始碼驗宣告；畫面由 demo 的樣式簽名比對與真機驗收看。
// div／span／code／p 類斷言「沒有這個宣告」（hasDecl：規則本身必須存在，規則不見就炸）；
// <button>／<input>／<select> 類斷言 border 存在而且是 none（lastDecl：刪掉這行會冒出瀏覽器預設外框，spec G9）。
// 底色、滑過、提示字顏色、opacity 這些值不斷言——它們不防線被加回來（spec §5.6）；
// 提示字、方塊、語言鈕的底色由對比測試從 CSS 讀，宣告被刪掉時讀不到而紅
const set = baseOf("/src/components/Settings.css");
const S = cssRules(set);
const acc = baseOf("/src/components/AccountsEditor.css");
const A = cssRules(acc);
const bk = baseOf("/src/components/BackupCard.css");
const rs = baseOf("/src/components/RestoreCard.css");
const ob = baseOf("/src/components/Onboarding.css");
const O = cssRules(ob);
const lang = baseOf("/src/components/LangSwitch.css");
const L = cssRules(lang);

describe("設定視窗：大卡片與分隔線（spec D1、D2）", () => {
  it("設定視窗沒有外框", () => {
    expect(hasDecl(set, ".settings-modal", "border")).toBe(false);
  });

  it("標題列、底部列、開發環境摺疊區沒有線", () => {
    expect(hasDecl(set, ".settings-head", "border-bottom")).toBe(false);
    expect(hasDecl(set, ".settings-foot", "border-top")).toBe(false);
    expect(hasDecl(set, ".st-fold", "border")).toBe(false);
    expect(hasDecl(set, ".st-fold-body", "border-top")).toBe(false);
  });
});

describe("設定視窗：方塊、輸入框、按鈕（spec D3、D4、D5）", () => {
  it("根目錄／手動專案／訂閱的每一列沒有外框", () => {
    expect(hasDecl(set, ".settings-rrow", "border")).toBe(false);
  });

  it("下拉選單、輸入框、次要按鈕寫 border: none（G9）", () => {
    expect(lastDecl(set, ".settings-rrow-select", "border")).toBe("none");
    expect(lastDecl(set, ".settings-input", "border")).toBe("none");
    expect(lastDecl(set, ".settings-add-select", "border")).toBe("none");
    expect(lastDecl(set, ".settings-btn-ghost", "border")).toBe("none");
  });

  // spec §5.5：提示字坐在輸入框自己的底上，兩個顏色都從 CSS 讀
  it("輸入框的提示字對輸入框底至少 4.5:1", () => {
    expect(worst(token(S.paintToken(".settings-input::placeholder", "color")), S.paintColor(".settings-input", "background"))).toBeGreaterThanOrEqual(4.5);
  });

  it("手動專案列的帳號名對暗磚至少 4.5:1", () => {
    expect(worst(token(S.paintToken(".settings-rrow-acct", "color")), S.paintColor(".settings-rrow", "background"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("帳號、備份、還原：方塊、輸入框、按鈕、分隔線（spec D2、D3、D4、D5）", () => {
  it("帳號列與轉移面板沒有外框", () => {
    expect(hasDecl(acc, ".ae-row", "border")).toBe(false);
    expect(hasDecl(acc, ".ae-reassign", "border")).toBe(false);
  });

  it("輸入框、下拉選單、次要按鈕寫 border: none（G9）", () => {
    expect(lastDecl(acc, ".ae-input", "border")).toBe("none");
    expect(lastDecl(acc, ".ae-reassign-select", "border")).toBe("none");
    expect(lastDecl(acc, ".ae-btn-ghost", "border")).toBe("none");
  });

  it("帳號輸入框的提示字對輸入框底至少 4.5:1", () => {
    expect(worst(token(A.paintToken(".ae-input::placeholder", "color")), A.paintColor(".ae-input", "background"))).toBeGreaterThanOrEqual(4.5);
  });

  it("路徑框與清單上緣沒有線", () => {
    expect(hasDecl(bk, ".bk-path", "border")).toBe(false);
    expect(hasDecl(bk, ".bk-bundles", "border-top")).toBe(false);
    expect(hasDecl(rs, ".rs-path", "border")).toBe(false);
    expect(hasDecl(rs, ".rs-bundles", "border-top")).toBe(false);
    expect(hasDecl(rs, ".rs-links", "border-top")).toBe(false);
  });
});

describe("引導精靈與 b4 卡片（spec D1、D2、D3、D4、D5、D7）", () => {
  it("精靈卡片、清單卡、移機區塊沒有外框", () => {
    expect(hasDecl(ob, ".ob-card", "border")).toBe(false);
    expect(hasDecl(ob, ".b4-card", "border")).toBe(false);
    expect(hasDecl(ob, ".ob-spot", "border")).toBe(false);
  });

  it("清單每一列之間沒有線", () => {
    expect(hasDecl(ob, ".b4-item", "border-bottom")).toBe(false);
  });

  it("紫色說明框與嵌入的終端機沒有外框（黃色確認框保留，不在這裡驗）", () => {
    expect(hasDecl(ob, ".ob-note", "border")).toBe(false);
    expect(hasDecl(ob, ".b4-note", "border")).toBe(false);
    expect(hasDecl(ob, ".b4-term", "border")).toBe(false);
    expect(hasDecl(ob, ".b4-term-head", "border-bottom")).toBe(false);
  });

  it("下拉選單、輸入框、卡內小按鈕寫 border: none（G9）", () => {
    expect(lastDecl(ob, ".ob-sel", "border")).toBe("none");
    expect(lastDecl(ob, ".ob-input", "border")).toBe("none");
    expect(lastDecl(ob, ".b4-btn-sm", "border")).toBe("none");
  });

  it("精靈輸入框的提示字對輸入框底至少 4.5:1", () => {
    expect(worst(token(O.paintToken(".ob-input::placeholder", "color")), O.paintColor(".ob-input", "background"))).toBeGreaterThanOrEqual(4.5);
  });

  it("清單卡裡最淡的字（工具版本）對暗磚至少 4.5:1", () => {
    expect(worst(token(O.paintToken(".b4-item-meta", "color")), O.paintColor(".b4-card", "background"))).toBeGreaterThanOrEqual(4.5);
  });

  it("移機區塊的「舊機位置」對暗磚至少 4.5:1", () => {
    expect(worst(token(O.paintToken(".ob-spot-old", "color")), O.paintColor(".ob-spot", "background"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("語言切換鈕（spec D8）", () => {
  it("<button> 寫 border: none（G9）", () => {
    expect(lastDecl(lang, ".lang-switch-btn", "border")).toBe("none");
  });

  // spec §5.5：選中的底是半透明，疊在它實際坐落的那層底上算——設定視窗標題列（.settings-modal）與精靈頁（.ob-overlay），
  // 兩個底都從 CSS 讀
  it.each([
    ["設定視窗", () => decl(set, ".settings-modal", "background")],
    ["引導精靈", () => decl(ob, ".ob-overlay", "background")],
  ])("選中的橘字對疊在%s上的淡橘底至少 4.5:1", (_label, backdrop) => {
    const bg = over(decl(lang, ".lang-switch-btn.is-on", "background"), backdrop());
    expect(worst(token(L.paintToken(".lang-switch-btn.is-on", "color")), bg)).toBeGreaterThanOrEqual(4.5);
  });
});

// spec §1.5／§5.6：防的是「以後不小心把線加回來」——最可能的形狀是新增元件時照抄舊寫法
// `border: 1px solid var(--border)`。定點斷言只看得到既有的選擇器，這條連新增的選擇器也看得到。
// 不防刻意繞過（寫死顏色另有 index.tokens.test.ts 擋；TSX inline style 靠審查）。
describe("設定與精靈的 CSS 不再引用分隔線 token（spec §1.5、§5.6）", () => {
  it("--border／--divider／--term-divider 只剩捲軸與精靈進度格兩處，都不是線", () => {
    const { hits } = lineTokenHits([
      "/src/components/Settings.css",
      "/src/components/AccountsEditor.css",
      "/src/components/BackupCard.css",
      "/src/components/RestoreCard.css",
      "/src/components/LangSwitch.css",
      "/src/components/Onboarding.css",
    ]);
    // 期望清單非空：掃描迴圈失效時 hits 變空、toEqual 會紅，不另外斷言 scanned（spec §5.6）
    expect(hits).toEqual([
      "/src/components/Settings.css .settings-body::-webkit-scrollbar-thumb → background: var(--border)",
      "/src/components/Onboarding.css .ob-step-bar → background: var(--border)",
    ]);
  });
});

import { describe, expect, it } from "vitest";

// 待辦面板的顏色對比防線。
//
// 為什麼需要這個檔：Tasks.test.tsx 只斷言「done 的記號有一個 svg」，
// 那條測試對「這個 svg 在畫面上根本看不清楚」完全無感——Codex 第二輪就是抓到
// done 記號被 opacity: .65 打到 2.13:1（門檻 3:1）而測試全綠。
//
// 這裡守兩件事：
//   ① 記號與已完成列**實際用的**顏色 token 對比度要過門檻
//   ② 這些規則不准用 opacity 做淡化——opacity 把顏色往底色拉，
//      對比度是無聲被打掉的，從 token 值算不出來（①）也就守不住
//
// 用 vite 的 import.meta.glob 而非 node:fs——本專案沒有 @types/node，
// 與 lib/sourceHygiene.test.ts 同一個理由與同一種寫法。
const RAW = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const read = (path: string) => {
  const text = RAW[path];
  if (typeof text !== "string") throw new Error(`glob 沒讀到 ${path}`);   // 讀不到要炸，不能靜默跳過
  return text;
};

// 從 index.css 的 nightfall 區塊取 token。取不到就炸——靜默跳過等於這條防線沒上場
const nightfall = (() => {
  const all = read("/src/index.css");
  const from = all.indexOf('[data-theme="nightfall"]');
  const to = all.indexOf('[data-theme="daylight"]');
  if (from < 0 || to <= from) throw new Error("index.css 找不到 nightfall 區塊");
  return all.slice(from, to);
})();
const token = (name: string) => {
  const m = nightfall.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`token --${name} 不在 nightfall 區塊裡`);
  return m[1];
};

// WCAG 相對亮度與對比度
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// 從 Tasks.css 讀出某條規則實際用的顏色 token。
// 不可以在測試裡自己寫死「done 標題用 --dim」——那樣有人把 CSS 改回 --faint 測試照樣全綠，
// 斷言就落在一個不會發生的情境上。要驗的是「CSS 現在用的那個 token 夠不夠」。
const tasksCss = read("/src/components/Tasks.css");
// 同一個選擇器可能出現在多條規則裡（例如 .tk-mark.is-doing::before 既在合併的
// content 規則裡、也有自己那條），所以要掃過全部、挑真的宣告了那個屬性的那條。
const stripped = tasksCss.replace(/\/\*[\s\S]*?\*\//g, "");
const bodiesFor = (selector: string) => {
  const out = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].split(",").map((x: string) => x.trim()).includes(selector))
    .map((m) => m[2]);
  if (out.length === 0) throw new Error(`Tasks.css 裡找不到規則 ${selector}`);
  return out;
};
const paintToken = (selector: string, prop: string) => {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:[^;]*?var\\(--([a-z0-9-]+)\\)`);
  for (const body of bodiesFor(selector)) {
    const m = body.match(re);
    if (m) return m[1];
  }
  throw new Error(`${selector} 的 ${prop} 沒有用 var(--token)`);
};

describe("待辦面板的顏色對比", () => {
  const bg = token("bg");
  // 編輯器（spec §6.2）的文字實際坐落在 .full-editor 的 --surface 上，不是 --bg——
  // --surface 比 --bg 亮，拿 --bg 當底算出來的對比度會偏高、掩蓋掉真的不夠的情況，
  // 所以這裡另外備一個底色，各選擇器依實際坐落的容器各自指定（task 10 review）
  const surface = token("surface");
  // 票 21 指令區塊的 <pre> 有自己的 --surface-2 底，比 --surface 再亮一階，同一個理由要另備一個底色
  const surface2 = token("surface-2");
  // 專案樹（票 19）反白列的底是 --active，不是 --bg——同一個選擇器坐落在兩種底色上，
  // 各自要驗一次（.tree-item 平常在 --bg，選到 .active 後底色換成 --active、文字色不變）
  const active = token("active");

  // 記號是可操作的 UI 元件，非文字門檻 3:1（WCAG 1.4.11）
  it.each([
    ["todo 空心框", ".tk-mark.is-todo::before", "border", bg],
    ["doing 實心方", ".tk-mark.is-doing::before", "background", bg],
    ["done 打勾（繼承 .tk-mark 的 color）", ".tk-mark", "color", bg],
    // 整頁編輯器（spec §6.2／§6.4）停用態的邊框：平常文字已經是 --dim，改文字色沒有用，
    // 訊號改放邊框上（task 10 review FIX 2）——都坐落在 .full-editor 的 --surface 上
    [".ed-btn 停用邊框", ".ed-btn:disabled", "border", surface],
    ["Preview／Cancel 停用邊框", ".btn.is-quiet:disabled", "border-color", surface],
    ["Save 停用邊框", ".btn.is-primary:disabled", "border-color", surface],
    // 票 21 指令框尾的複製圖示（lucide svg 吃 currentColor）與已複製的勾，坐落在框的 --surface-2 上
    ["指令複製圖示", ".tasks-cmd-act", "color", surface2],
    ["指令已複製的勾", ".tasks-cmd-act.is-done", "color", surface2],
    // 專案樹（票 19，spec §5.2）進行中橘點：非文字元件，門檻同記號 3:1
    ["樹的進行中橘點", ".tree-n i", "background", bg],
    // 票 19 清單（spec §5.4／§5.6）：擱置是第四種輪廓（虛線空心方）；編輯中清單唯讀（D12）
    // 停用的記號與動作鍵是圖示（lucide svg 吃 currentColor），非文字 3:1；下一步右上的「›」
    // 是唯一的字符、spec 指定 --faint，同樣按非文字驗
    ["parked 虛線框", ".tk-mark.is-parked::before", "border", bg],
    ["停用的狀態記號", ".tk-mark:disabled", "color", bg],
    ["停用的動作鍵", ".tk-act:disabled", "color", bg],
    ["下一步的 › 記號", ".tasks-next-more", "color", bg],
  ])("%s 對背景至少 3:1", (_label, selector, prop, backdrop) => {
    expect(contrast(token(paintToken(selector, prop)), backdrop)).toBeGreaterThanOrEqual(3);
  });

  // 票上的文字門檻 4.5:1。已完成的標題淡化到某個 token 就停，再淡就不合格
  it.each([
    ["已完成的標題", ".tk.is-done .tk-title", "color", bg],
    // 票 19：擱置的標題淡化到 --dim 就停（與已完成同一條線）；編輯中停用的一行輸入是文字，不能掉到 --faint
    ["擱置的標題", ".tk.is-parked .tk-title", "color", bg],
    ["停用的一行輸入", ".tasks-new-input:disabled", "color", bg],
    ["來源 AI", ".tk-src.is-ai", "color", bg],
    ["來源 我", ".tk-src.is-me", "color", bg],
    // 所有專案頁的跨專案票列（票 19，spec §5.3）：列文字在 --bg 上；專案標籤有自己的 --surface-2 底
    ["跨專案票列文字", ".tk-xrow", "color", bg],
    ["跨專案票列的專案標籤", ".tk-proj", "color", surface2],
    ["第二層分區標籤", ".tasks-sec-lab", "color", bg],
    ["第二層分區計數", ".tasks-sec-n", "color", bg],
    // 票內文的 markdown（右欄與編輯器預覽共用）：正文與連結都要各自過 4.5:1
    [".tk-md 內文", ".tk-md", "color", bg],
    [".tk-md 連結", ".tk-md a", "color", bg],
    // 整頁編輯器（spec §6.2／§6.4，task 10 review FIX 4）：坐落在 --surface 上的文字
    [".ed-title 正常文字", ".ed-title", "color", surface],
    [".ed-area 正常文字", ".ed-area", "color", surface],
    [".ed-hint 狀態字", ".ed-hint", "color", surface],
    [".ed-title 停用文字", ".ed-title:disabled", "color", surface],
    [".ed-area 停用文字", ".ed-area:disabled", "color", surface],
    ["Save 停用文字", ".btn.is-primary:disabled", "color", surface],
    // 返回列與提示條坐落在 .tasks-pane，沿用 --bg
    ["返回列的專案名", ".full-back", "color", bg],
    ["返回列的票號", ".full-num", "color", bg],
    ["提示條文字", ".tk-banner", "color", bg],
    ["提示條按鈕文字", ".tk-banner .bbtn", "color", bg],
    // 票 21 貼進新對話的指令：標籤坐落在 .tasks-pane 的 --bg；<pre> 在框自己的 --surface-2 上
    ["指令區塊標籤", ".tasks-cmd-lab", "color", bg],
    ["指令內文", ".tasks-cmd-pre", "color", surface2],
    // 專案樹（票 19，spec §5.2）：brief 的「新規則自動納入」是錯的，這幾條要補（task 5 review FIX）
    ["樹頂端摘要文字", ".tree-head .s", "color", bg],
    ["樹頂端摘要讀不到警告", ".tree-head .s .is-warn", "color", bg],
    ["樹的數字", ".tree-n", "color", bg],
    // review 點名的那一條：demo 用 --faint，brief 明確要求換成 --dim，這裡才守得住
    ["樹的擱置 +N", ".tree-n .pk", "color", bg],
    ["樹讀不到警告", ".tree-una", "color", bg],
    ["樹未開待辦的淡化名稱", ".tree-item.is-dim .tree-name", "color", bg],
    ["樹分組標籤", ".tree-grp", "color", bg],
    ["樹列文字（一般底 --bg）", ".tree-item", "color", bg],
    ["樹列文字（反白底 --active）", ".tree-item", "color", active],
  ])("%s 對背景至少 4.5:1", (_label, selector, prop, backdrop) => {
    expect(contrast(token(paintToken(selector, prop)), backdrop)).toBeGreaterThanOrEqual(4.5);
  });

  // 完成區的展開箭頭是 lucide 的 svg，用 currentColor 吃 .tasks-sec 的 color；
  // 標籤與計數各有自己的 color。分開設就會漂移——2026-09-01 就是標籤改成 --dim
  // 而容器留在 --faint，箭頭比旁邊的字淡一截。
  // 這裡不驗絕對門檻：--faint 是 3.43:1，本來就過得了非文字的 3:1，那樣的斷言
  // 在缺陷還在的時候也是綠的。要驗的是「箭頭不可以比標籤淡」這個關係本身。
  it("完成區展開箭頭與分區標籤用同一個顏色 token", () => {
    expect(paintToken(".tasks-sec", "color")).toBe(paintToken(".tasks-sec-lab", "color"));
  });

  // opacity 禁令。上面那組是從 token 值算的，算不到 opacity 疊出來的實際顏色，
  // 所以「不准用 opacity」本身要是一條規則，否則上面那組會給出安心的假象。
  // 停用態也在禁令裡：index.contrast.test.ts 的全域白名單豁免 :disabled（WCAG 1.4.3），這裡不豁免——
  // 編輯中清單唯讀是靠換 token 淡化的，一用 opacity 上面那組就驗不到實際顏色。
  // `.tk-act(?!s)` 排除 .tk-acts：那是滑過才顯形的容器，0↔1 是顯示／隱藏不是淡化，刻意用 opacity
  it("狀態記號、已完成列、專案樹、跨專案票列、動作鍵、一行輸入與下一步不得用 opacity 淡化", () => {
    const rules = [...tasksCss.matchAll(/^(\.tk-mark[^{]*|\.tk\.is-done[^{]*|\.tree[^{]*|\.tk-xrow[^{]*|\.tk-proj[^{]*|\.tk-act(?!s)[^{]*|\.tasks-new-input[^{]*|\.tasks-next[^{]*)\{([^}]*)\}/gm)];
    // regex 沒命中會讓迴圈跑零次而測試全綠——先確認真的有抓到規則
    expect(rules.length).toBeGreaterThanOrEqual(4);
    for (const [, selector, body] of rules) {
      expect(`${selector.trim()} { ${body.trim()} }`).not.toMatch(/\bopacity\s*:/);
    }
  });
});

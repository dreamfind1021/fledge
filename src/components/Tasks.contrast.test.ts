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
  ])("%s 對背景至少 3:1", (_label, selector, prop, backdrop) => {
    expect(contrast(token(paintToken(selector, prop)), backdrop)).toBeGreaterThanOrEqual(3);
  });

  // 票上的文字門檻 4.5:1。已完成的標題淡化到某個 token 就停，再淡就不合格
  it.each([
    ["已完成的標題", ".tk.is-done .tk-title", "color", bg],
    ["來源 AI", ".tk-src.is-ai", "color", bg],
    ["來源 我", ".tk-src.is-me", "color", bg],
    ["總覽的下一步", ".tov-next", "color", bg],
    ["沒設下一步的提示", ".tov-next.is-none", "color", bg],
    ["chip 文字", ".tov-chip", "color", bg],
    ["還沒開始用", ".tov-unused", "color", bg],
    ["總覽分區標籤", ".tov-sec-lab", "color", bg],
    ["總覽分區計數", ".tov-sec-n", "color", bg],
    ["第二層分區標籤", ".tasks-sec-lab", "color", bg],
    ["第二層分區計數", ".tasks-sec-n", "color", bg],
    // 展開預覽（spec §6.1／§6.4）新增的選擇器：不能只讓「16 tests passed」是因為
    // 這幾條規則根本沒被掃到——沒有內文、不可編輯說明、正文與連結都要各自過 4.5:1
    [".tk-md 內文", ".tk-md", "color", bg],
    ["沒有內文的提示", ".tk-empty", "color", bg],
    ["不可編輯的說明", ".tk-noedit", "color", bg],
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
    // 票 21 貼進新對話的指令：標籤、展開鈕、複製鈕坐落在 .tasks-pane 的 --bg；<pre> 在自己的 --surface-2 上
    ["指令區塊標籤", ".tasks-cmd-lab", "color", bg],
    ["指令展開／收合鈕", ".tasks-cmd-toggle", "color", bg],
    ["指令複製鈕", ".tasks-cmd-btn", "color", bg],
    ["指令已複製狀態", ".tasks-cmd-btn.is-done", "color", bg],
    ["指令內文", ".tasks-cmd-pre", "color", surface2],
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
  it("狀態記號與已完成列不得用 opacity 淡化", () => {
    const rules = [...tasksCss.matchAll(/^(\.tk-mark[^{]*|\.tk\.is-done[^{]*)\{([^}]*)\}/gm)];
    // regex 沒命中會讓迴圈跑零次而測試全綠——先確認真的有抓到規則
    expect(rules.length).toBeGreaterThanOrEqual(4);
    for (const [, selector, body] of rules) {
      expect(`${selector.trim()} { ${body.trim()} }`).not.toMatch(/\bopacity\s*:/);
    }
  });
});

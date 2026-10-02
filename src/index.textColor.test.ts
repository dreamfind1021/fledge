import { describe, expect, it } from "vitest";

// 功能色拿來寫字一律用 --X-text（票 07，spec docs/planning/daylight-themes-design.md §3.3、§6.4）。
//
// 五個功能色（--primary、--session、--ai、--warning、--error）在每個主題都是同一組亮色：
// 按鈕底色、圖示、狀態點用它沒問題，但在淺色主題拿來寫字只有 1.5～3.4:1。寫字要用 --X-text——
// 午夜藍的 --X-text 是 --X 的別名（畫面不變），淺色主題深一階。
//
// 白名單形式：`color` 的值裡**任何位置**出現功能色（包括包在 color-mix() 裡），該選擇器必須登記在下面，
// 否則紅。黑名單擋不住沒想到的形狀（第 1 版只比對「整個值就是 var(--X)」，color-mix 等價寫法就繞過去了，Codex spec R1）。
//
// 保證等級（照實寫，spec §6.4）：只檢查 CSS 裡**直接引用**功能色的地方；TSX 則一律不准寫 inline 的 `color:`。
// 不追蹤 token 別名（定義 --my: var(--warning) 再拿來寫字）、不追蹤間接組出來的 style 值、不追蹤 DOM 繼承、
// 不掃 `el.style.color = …` 這種 DOM 指派（目前只有 Terminal.tsx 一處，值來自 term-theme），
// 也不驗證白名單裡的元素永遠不會放文字。這些靠規則層的對比測試與審查補位。
const CSS = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const TSX = import.meta.glob(["/src/**/*.tsx", "!/src/**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const FUNCTIONAL = /var\(\s*--(primary|session|ai|warning|error)\s*\)/;

// 圖示與其他非文字（spec 附錄 B）。淺色主題的非文字低於 3:1 是知情接受（spec §12.1）
const ICON_OK: Record<string, string> = {
  ".ae-del:hover": "帳號列的垃圾桶圖示鈕（只有圖示）",
  ".app-banner--error .app-banner-icon": "錯誤橫幅前的圖示",
  ".app-banner--warning .app-banner-icon": "警告橫幅前的圖示",
  ".confirm-ico": "確認框的警告圖示",
  ".lrow .lk": "記憶列的 ◈ 符號（已連結 topic）",
  ".relchip .ic": "相關小籤的 ◈ 符號",
  ".relchip.proj .ic": "相關小籤的 📁 符號",
  ".pal-search .pico": "⌘T 搜尋列的放大鏡圖示",
  ".pal-row.is-sel .rico": "⌘T 選中列的圖示",
  ".settings-del:hover": "設定列的垃圾桶圖示鈕（只有圖示）",
  ".sidebar-rail-btn--accent": "側欄收合時的「開啟資料夾」圖示鈕",
  ".sidebar-rail-btn--accent:hover": "同上（滑過）",
  ".sidebar-item-ico": "側欄專案的資料夾圖示",
  ".splash-err-head svg": "啟動失敗標題前的圖示",
  ".tasks-cmd-act.is-done": "指令框「已複製」的打勾圖示",
  ".tk-flag": "票列的旗標圖示鈕（只有圖示）",
  ".tk-act.is-danger:hover": "票列的垃圾桶圖示鈕（只有圖示）",
};

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
// 每條宣告：{ 路徑, 選擇器, 屬性, 值 }。body 用 [^{}]*：@media／@container 裡的規則才會以自己的選擇器被抓到，
// 不會把「@media (…)」當成選擇器、把裡面整段當成一條宣告
const declarations = () =>
  Object.entries(CSS).flatMap(([path, css]) =>
    [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, sel, body]) =>
      body.split(";").filter((d) => d.includes(":")).map((d) => {
        const i = d.indexOf(":");
        return { path, selector: sel.trim().replace(/\s+/g, " "), prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim() };
      }),
    ),
  );

describe("功能色當文字一律用 --X-text（spec §6.4）", () => {
  it("CSS 的 color 裡出現功能色的，只准是白名單裡的圖示", () => {
    const colors = declarations().filter((d) => d.prop === "color");
    // 掃到的 color 宣告太少代表切規則的正規式失效、迴圈空轉——那樣下面的 toEqual 會假綠
    expect(colors.length).toBeGreaterThan(300);
    const offenders = colors
      .filter((d) => FUNCTIONAL.test(d.value) && !(d.selector in ICON_OK))
      .map((d) => `${d.path} ${d.selector} → color: ${d.value}`);
    expect(offenders).toEqual([]);
  });

  it("白名單不得有死條目（該選擇器的 color 已經不是功能色，就該從白名單拿掉）", () => {
    const live = new Set(declarations().filter((d) => d.prop === "color" && FUNCTIONAL.test(d.value)).map((d) => d.selector));
    for (const sel of Object.keys(ICON_OK)) expect(live.has(sel), `白名單的 ${sel} 已經不是功能色的 color`).toBe(true);
  });

  // TSX 不寫 inline 的 color：文字色一律放 CSS，才會被上面那條白名單掃到（目前 0 處；Dashboard.tsx 的兩處是 background）。
  // 第 1 版想在 TSX 裡辨認「color 的值有沒有功能色」，一行正規式在 color-mix() 的逗號就停（Codex plan R1）；
  // 補成完整的值掃描器之後，Codex plan R2 判定過度設計——全專案 0 處，直接禁止最簡單，也沒有「值沒辨認出來」的漏洞。
  // 比對整份原始碼（不逐行切，鍵名與冒號分行也抓得到）；鍵名可以加引號（"color":，Codex plan R3）；
  // 前面不能接字母或連字號，所以 backgroundColor、border-color 不算。
  // 純文字掃描的限制：型別標註 { color: string } 也會被抓（TSX 裡目前沒有；真的需要就移到 .ts 或換名稱）
  const INLINE_COLOR = /(?<![\w-])(["'`]?)color\1\s*:/g;
  const inlineColors = (src: string) => [...src.matchAll(INLINE_COLOR)].map((m) => src.slice(m.index, m.index + 40).replace(/\s+/g, " "));
  it("TSX 不寫 inline 的 color（文字色一律放 CSS）", () => {
    // 正規式自己的防線：它失效的話下面那條永遠是空陣列。一列一種寫法，失敗訊息印出是哪一列
    const SELF: [string, string, boolean][] = [
      ["要抓到 color:", 'style={{ color: "var(--dim)" }}', true],
      ["加引號的鍵名", 'style={{ "color": "var(--dim)" }}', true],
      ["鍵名與冒號分行", 'style={{\n  color\n    : "var(--dim)" }}', true],
      ["backgroundColor 不算", 'style={{ backgroundColor: "var(--warning)" }}', false],
      ["border-color 不算", 'const css = "border-color: red";', false],
    ];
    for (const [label, src, want] of SELF) expect(inlineColors(src).length > 0, label).toBe(want);
    expect(Object.keys(TSX).length).toBeGreaterThan(30);
    const offenders = Object.entries(TSX).flatMap(([path, src]) => inlineColors(src).map((hit) => `${path} → ${hit}`));
    expect(offenders).toEqual([]);
  });
});

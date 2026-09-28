// CSS 讀取與顏色對比的共用工具——只給測試用：檔名不以 .test.ts 結尾，vitest 不會當成測試收集；
// app 也不 import 它，不會進打包。
//
// 從 components/Tasks.contrast.test.ts 與 Tasks.layout.test.ts 抽出（票 28 第一批，
// spec docs/planning/soft-tiles-app-wide-design.md §1.5）：外殼的樣式測試是第二個用到它們的地方，
// 依 CLAUDE.md「重複邏輯出現第二次就抽共用」。兩組工具各自保留原本的形式：
//   - 規則查詢（decls／decl／hasDecl）帶 text 參數——版面測試會對不同片段（基礎等級、各寬度區塊、keyframes）呼叫
//   - 塗色查詢（paintToken／paintColor／paintColors）用 cssRules(text) 綁定一段 CSS
//
// 用 vite 的 import.meta.glob 而非 node:fs——本專案沒有 @types/node（同 lib/sourceHygiene.test.ts）。
const RAW = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const readCss = (path: string) => {
  const text = RAW[path];
  if (typeof text !== "string") throw new Error(`glob 沒讀到 ${path}`);   // 讀不到要炸，不能靜默跳過
  return text;
};

export const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
// 基礎（窄）等級＝拿掉所有 @media／@container／@keyframes 區塊：decl 取最後一條宣告，
// 區塊內的覆寫只在那個寬度生效，混進來會把基礎值蓋掉（Codex final R1）
export const baseLevel = (css: string) => css.replace(/@[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

// ── 規則查詢 ──
// 某個選擇器在 text 裡所有規則的 prop 宣告（依出現順序）。規則一條都沒有就炸
export const decls = (text: string, selector: string, prop: string) => {
  const rules = [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].split(",").map((x) => x.trim()).includes(selector));
  if (rules.length === 0) throw new Error(`找不到規則 ${selector}`);
  return rules.flatMap((r) => [...r[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].map((m) => m[1].trim()));
};
// 同一個選擇器（權重相同）後面的蓋前面：取最後一條。只取第一條會漏掉檔尾的覆寫（Codex final R1）
export const decl = (text: string, selector: string, prop: string) => {
  const all = decls(text, selector, prop);
  if (all.length === 0) throw new Error(`${selector} 沒有宣告 ${prop}`);
  return all[all.length - 1];
};
// 「不准宣告」用這個：規則本身必須存在。用 toThrow 的話規則整條不見也會通過，等於沒驗（Codex final R1）
export const hasDecl = (text: string, selector: string, prop: string) => decls(text, selector, prop).length > 0;

// ── 顏色 ──
// 從 index.css 的 nightfall 區塊取 token。取不到就炸——靜默跳過等於這條防線沒上場
export const nightfallBlock = (() => {
  const all = readCss("/src/index.css");
  const from = all.indexOf('[data-theme="nightfall"]');
  const to = all.indexOf('[data-theme="daylight"]');
  if (from < 0 || to <= from) throw new Error("index.css 找不到 nightfall 區塊");
  return all.slice(from, to);
})();
export const token = (name: string) => {
  const m = nightfallBlock.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
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
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// 依頂層逗號切（括號內的逗號不切）
export const splitTop = (s: string) => {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
};
const inner = (s: string, fn: string) => s.slice(fn.length + 1, -1);   // "fn(...)" 的括號內
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
// color-mix(in srgb, …) 對不透明色＝sRGB 編碼值的線性插值；只混不透明色
export const resolveColor = (expr: string): string => {
  const e = expr.trim();
  const v = e.match(/^var\(--([a-z0-9-]+)\)$/);
  if (v) return token(v[1]);
  // 漸層不是一個顏色：只取一站會漏掉其他站變亮的退化（Codex final R1）——一律走 stops／paintColors
  if (e.startsWith("linear-gradient(")) throw new Error(`漸層要用 stops() 逐站驗：${e}`);
  if (e.startsWith("color-mix(")) {
    const [space, a, b] = splitTop(inner(e, "color-mix"));
    if (space !== "in srgb") throw new Error(`只算 srgb：${e}`);
    const part = (s: string) => {
      const m = s.match(/^(var\(--[a-z0-9-]+\))(?:\s+(\d+(?:\.\d+)?)%)?$/);
      if (!m) throw new Error(`認不得的 color-mix 成分：${s}`);
      return { c: resolveColor(m[1]), p: m[2] == null ? null : parseFloat(m[2]) / 100 };
    };
    const A = part(a), B = part(b);
    if (A.p != null && B.p != null) throw new Error(`兩邊都寫百分比不支援（要正規化或變半透明）：${e}`);
    const pa = A.p ?? (B.p == null ? 0.5 : 1 - B.p);
    const ca = rgb(A.c), cb = rgb(B.c);
    return hex(ca.map((x, i) => x * pa + cb[i] * (1 - pa)));
  }
  throw new Error(`認不得的顏色：${e}`);
};
// 背景的每一個色站（非漸層＝一站）。文字可能落在漸層任何位置，所以每站都要過門檻。
// 只驗色站、不取樣中段：目前的漸層都是「暗底混一點琥珀 → 同一個暗底」，中段亮度夾在兩站之間；
// 改成亮暗交錯的漸層時要補取樣
export const stops = (expr: string): string[] => {
  const e = expr.trim();
  if (!e.startsWith("linear-gradient(")) return [resolveColor(e)];
  const parts = splitTop(inner(e, "linear-gradient"));
  const colors = /^(-?\d+(?:\.\d+)?(?:deg|turn|rad|grad)|to\s)/.test(parts[0]) ? parts.slice(1) : parts;   // 開頭可能是角度／方向
  return colors.map((c) => resolveColor(c.replace(/(?:\s+\d+(?:\.\d+)?%)+$/, "")));                    // 去掉站位
};
// 前景對一組色站的最差對比
export const worst = (fg: string, backdrop: string | string[]) => Math.min(...[backdrop].flat().map((b) => contrast(fg, b)));
// 半透明底色（color-mix(…, transparent)）疊在不透明底色上，等於直接跟那個底色在 sRGB 混——
// 所以把 transparent 換成它實際坐落的那層底色（呼叫端從 CSS 讀）再算。
// 票 28 第四批 4a 從 Memory.style.test.ts 搬來：語言切換鈕的對比是第二個用到它的地方（spec §5.6）
export const over = (expr: string, backdrop: string) => resolveColor(expr.replace("transparent", backdrop));

// ── 塗色查詢：綁定一段 CSS（通常是 baseLevel(stripComments(readCss(path)))）──
// 不可以在測試裡自己寫死「某條規則用某個 token」——那樣有人把 CSS 改回較淡的 token 測試照樣全綠，
// 斷言就落在一個不會發生的情境上。要驗的是「CSS 現在用的那個 token 夠不夠」。
export const cssRules = (css: string) => {
  // paintToken 只抓第一個 var(--x)：背景是 color-mix 或漸層時，「琥珀 38% 混 surface-2」會被讀成純琥珀、
  // 算出假的高對比。背景一律走 paintColor／paintColors（票 26＋27）
  const paintToken = (selector: string, prop: string) => {
    const m = decl(css, selector, prop).match(/var\(--([a-z0-9-]+)\)/);
    if (!m) throw new Error(`${selector} 的 ${prop} 沒有用 var(--token)`);
    return m[1];
  };
  const paintColor = (selector: string, prop: string) => resolveColor(decl(css, selector, prop));
  const paintColors = (selector: string, prop: string) => stops(decl(css, selector, prop));
  return { paintToken, paintColor, paintColors };
};

// ── 樣式防線的小工具（票 28 第二批從 shell.style.test.ts 搬來：Memory.style.test.ts 是第二個用到它們的地方）──
// 讀某份 CSS 的基礎等級（去註解、拿掉 @media／@container／@keyframes）
export const baseOf = (path: string) => baseLevel(stripComments(readCss(path)));
// <button>／<input> 類用這個斷言「border 存在而且是 none」：宣告被刪掉時回 undefined，紅在斷言、不是紅在例外（spec G9）。
// 驗紅會刪掉宣告的值斷言也用它（decl 在宣告不見時會丟例外）
export const lastDecl = (text: string, selector: string, prop: string) => decls(text, selector, prop).slice(-1)[0];
// 分隔線 token 檢查（spec §1.5 第 2 點）：列出 paths 裡每一條引用 --border／--divider／--term-divider 的宣告，
// 格式「路徑 選擇器 → 宣告」。不用 baseOf：@media／@container 區塊裡加回來的線一樣要抓。readCss 讀不到就炸。
// scanned 是掃到的宣告總數。期望 hits 為空的呼叫端要斷言它夠大——regex 失效會讓迴圈空轉、hits 也是空的而全綠；
// 期望 hits 非空的呼叫端不需要：掃描失效時 hits 變空，toEqual 就會紅（Codex plan R1）
export const lineTokenHits = (paths: string[]) => {
  const hits: string[] = [];
  let scanned = 0;
  for (const path of paths) {
    const css = stripComments(readCss(path));
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const d of body.split(";")) {
        if (!d.includes(":")) continue;
        scanned += 1;
        if (/var\(\s*--(border|divider|term-divider)(?![\w-])/.test(d)) hits.push(`${path} ${selector.trim()} → ${d.trim()}`);
      }
    }
  }
  return { hits, scanned };
};

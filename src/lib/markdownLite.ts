import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";

// markdown 小子集（spec §9）。只認工具列會插入的八種語法，其餘原樣當文字。
// 例外是 `# `（票 25）：工具列不插，但離場筆記 state.md 的第一行固定是 `# 專案 — 狀態`，不認就每份都露出 `#`。
//
// **輸出 React 元素，不組 HTML 字串**（§9.4 第三條）：React 自己處理屬性值與文字內容的
// escape，`href` 裡的引號不可能跳脫屬性。自己組字串就得自己寫兩套 encoder，而且會忘。
//
// 0 新依賴：專案沒有任何 markdown 套件。之後不夠用要換套件是小改動——這是純函式，呼叫點只有預覽。

let keySeq = 0;
const k = () => `m${keySeq++}`;

/** §9.4 第二條：URL 是獨立的不受信任欄位。不帶 base 解析、只放行 http／https。 */
function safeHref(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());          // 不帶 base——相對路徑直接 throw，正好是要的行為
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
}

/** 行內語法：`code`、**bold**、~~del~~、*em*、[text](url)。code 裡不再解析；粗體與刪除線的內容也不再解析（spec §4.1.4）。 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[1]) out.push(createElement("code", { key: k() }, m[1].slice(1, -1)));
    else if (m[2]) out.push(createElement("strong", { key: k() }, m[2].slice(2, -2)));
    else if (m[3]) out.push(createElement("del", { key: k() }, m[3].slice(2, -2)));
    else if (m[4]) out.push(createElement("em", { key: k() }, m[4].slice(1, -1)));
    else if (m[5]) {
      const href = safeHref(m[7]);
      // scheme 不過就整段當文字——連中括號都保留，使用者看得出它沒被當成連結
      out.push(href ? createElement("a", { key: k(), href }, m[6]) : m[0]);
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// 只去半形空白與 tab：String.prototype.trim() 也會去掉全形空白 U+3000，作者拿它縮排時那是看得見的字（spec §4.1.5 第 1 點）
const strip = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, "");

// 換行兩側都是中日文字、或一邊中日文字一邊中性標點 → 直接接上；其餘放一個半形空格（spec §4.1.5 第 3、4 點）。
// 中性標點中英文都會用，所以只有另一邊是中日文字時才不插空格
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const NEUTRAL = /[\u2014\u2015\u2018\u2019\u201c\u201d\u2026\u00b7]/;
const glue = (a: string, b: string) =>
  (CJK.test(a) && (CJK.test(b) || NEUTRAL.test(b))) || (NEUTRAL.test(a) && CJK.test(b)) ? "" : " ";

/** 多行接回同一行（spec §4.1.5）：用 \n 接起來整段解析行內語法（粗體等可以跨行），再把每個 \n 依畫面上的前後字換掉。
 *  行內元素只有一層、裡面只有文字，所以畫面上的字就是各節點文字串起來的一串平的字串 */
function joined(lines: string[]): ReactNode[] {
  const nodes = inline(lines.map(strip).join("\n"));
  const texts = nodes.map((n) => (isValidElement(n) ? String((n as ReactElement<{ children: string }>).props.children) : String(n)));
  const flat = texts.join("");
  let at = 0;
  return nodes.map((n, i) => {
    const from = at;
    at += texts[i].length;
    if (!texts[i].includes("\n")) return n;
    const fixed = texts[i].replace(/\n/g, (_m, off: number) => glue(flat[from + off - 1] ?? "", flat[from + off + 1] ?? ""));
    return isValidElement(n) ? cloneElement(n, undefined, fixed) : fixed;
  });
}

export function renderMarkdownLite(src: string): ReactNode[] {
  keySeq = 0;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) { out.push(createElement("p", { key: k() }, ...joined(para))); para.length = 0; }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;                                          // 跳過結尾的 ```
      out.push(createElement("pre", { key: k() }, createElement("code", null, buf.join("\n"))));
      continue;
    }
    if (line.startsWith("# ")) { flushPara(); out.push(createElement("h1", { key: k() }, ...inline(line.slice(2)))); i++; continue; }
    if (line.startsWith("## ")) { flushPara(); out.push(createElement("h2", { key: k() }, ...inline(line.slice(3)))); i++; continue; }
    if (line.startsWith("- ")) {
      flushPara();
      const items: ReactNode[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(createElement("li", { key: k() }, ...inline(lines[i++].slice(2))));
      out.push(createElement("ul", { key: k() }, ...items));
      continue;
    }
    if (line.startsWith("> ")) {
      flushPara();
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) q.push(lines[i++].slice(2));
      out.push(createElement("blockquote", { key: k() }, createElement("p", null, ...joined(q))));
      continue;
    }
    if (line.trim() === "") { flushPara(); i++; continue; }
    para.push(line); i++;
  }
  flushPara();
  return out;
}

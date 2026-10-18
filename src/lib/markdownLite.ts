import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";

// markdown 小子集（票 3 spec §9；2026-10-19 擴充，docs/superpowers/specs/2026-10-19-tasks-panel-polish-design.md §4.1）。
// 認得：標題（# ～ ###）、粗體、斜體、刪除線、行內碼、清單（編號、一層子項目、續行）、引用、程式碼區塊、表格、分隔線、連結。
// 範圍以 2026-10-19 對真實票與離場筆記的盤點為準：盤點裡沒出現的寫法不支援，照段落文字處理；
// 刻意構造的輸入只保證不丟例外、不卡住（每一輪判斷至少吃掉一行）。
//
// **輸出 React 元素，不組 HTML 字串**（§9.4 第三條）：React 自己處理屬性值與文字內容的
// escape，`href` 裡的引號不可能跳脫屬性。自己組字串就得自己寫兩套 encoder，而且會忘。
//
// 0 新依賴：專案沒有任何 markdown 套件。換成 react-markdown＋remark-gfm 量過要多 157 KB（前端 JS +15%），
// 使用者選擇自己擴充（spec §2）。

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

// 分隔線：整行只有 3 個以上的 - 或 *，前面最多 3 個空格（spec §4.1.1 第 3 點）
const HR = /^ {0,3}(-{3,}|\*{3,})[ \t]*$/;
// 表格（spec §4.1.3）：| 開頭的行＋欄數相同的分隔列。切欄不支援 \| 跳脫，行內碼裡的 | 一樣會切（同 GFM）
const PIPE = /^[ \t]*\|/;
const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row: string) => {
  let s = strip(row);
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map(strip);
};

// 清單項目行（spec §4.1.2）：縮排、符號（- 或最多 9 位數字加 .）、內文。縮排 0～1 格是第一層，2 格以上是子項目（只有一層）
const ITEM = /^( *)(-|\d{1,9}\.) (.*)$/;
type Item = { text: string[]; kids: List[] };
type List = { ordered: boolean; start: number; items: Item[] };
const listOf = (marker: string): List => ({ ordered: marker !== "-", start: marker === "-" ? 1 : parseInt(marker, 10), items: [] });
// 起始號用第一項的數字，之後的數字不看、由瀏覽器依序編號；第一項是 1 時不寫 start
const renderList = (l: List): ReactNode => createElement(l.ordered ? "ol" : "ul",
  { key: k(), start: l.ordered && l.start !== 1 ? l.start : undefined },
  ...l.items.map((it) => createElement("li", { key: k() }, ...joined(it.text), ...it.kids.map(renderList))));

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
    if (line.startsWith("### ")) { flushPara(); out.push(createElement("h3", { key: k() }, ...inline(line.slice(4)))); i++; continue; }
    if (HR.test(line)) { flushPara(); out.push(createElement("hr", { key: k() })); i++; continue; }
    if (PIPE.test(line) && i + 1 < lines.length && SEP.test(lines[i + 1]) && cells(lines[i + 1]).length === cells(line).length) {
      flushPara();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && PIPE.test(lines[i])) rows.push(cells(lines[i++]));
      // 欄數照表頭：資料列少的補空格、多的捨掉
      const tr = (cols: string[], tag: "th" | "td") =>
        createElement("tr", { key: k() }, ...head.map((_, j) => createElement(tag, { key: k() }, ...inline(cols[j] ?? ""))));
      out.push(createElement("div", { key: k(), className: "tk-tbl" }, createElement("table", null,
        createElement("thead", null, tr(head, "th")),
        createElement("tbody", null, ...rows.map((r) => tr(r, "td"))))));
      continue;
    }
    const first = ITEM.exec(line);
    if (first && first[1].length < 2) {
      flushPara();
      const top = listOf(first[2]);
      let cur: Item = { text: [first[3]], kids: [] };
      top.items.push(cur);
      i++;
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (m && m[1].length < 2) {
          if ((m[2] !== "-") !== top.ordered) break;            // 符號換種類 → 這份清單結束，下一輪開新的
          cur = { text: [m[3]], kids: [] };
          top.items.push(cur);
        } else if (m) {                                          // 子項目：掛在上一個第一層項目下面
          const parent = top.items[top.items.length - 1];
          let sub = parent.kids[parent.kids.length - 1];
          if (!sub || sub.ordered !== (m[2] !== "-")) { sub = listOf(m[2]); parent.kids.push(sub); }
          cur = { text: [m[3]], kids: [] };
          sub.items.push(cur);
        } else if (/^ {2,}\S/.test(lines[i])) {
          cur.text.push(lines[i]);                               // 續行：接在最近的那一項，內容一律當文字
        } else break;                                            // 空行、沒縮排的非項目行：清單結束，交回外層重新判斷
        i++;
      }
      out.push(renderList(top));
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

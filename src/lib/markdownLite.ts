import { createElement, type ReactNode } from "react";

// markdown 小子集（spec §9）。只認工具列會插入的八種語法，其餘原樣當文字。
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

/** 行內語法：`code`、**bold**、*em*、[text](url)。code 裡不再解析。 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[1]) out.push(createElement("code", { key: k() }, m[1].slice(1, -1)));
    else if (m[2]) out.push(createElement("strong", { key: k() }, m[2].slice(2, -2)));
    else if (m[3]) out.push(createElement("em", { key: k() }, m[3].slice(1, -1)));
    else if (m[4]) {
      const href = safeHref(m[6]);
      // scheme 不過就整段當文字——連中括號都保留，使用者看得出它沒被當成連結
      out.push(href ? createElement("a", { key: k(), href }, m[5]) : m[0]);
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdownLite(src: string): ReactNode[] {
  keySeq = 0;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) { out.push(createElement("p", { key: k() }, ...inline(para.join("\n")))); para.length = 0; }
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
      out.push(createElement("blockquote", { key: k() }, createElement("p", null, ...inline(q.join("\n")))));
      continue;
    }
    if (line.trim() === "") { flushPara(); i++; continue; }
    para.push(line); i++;
  }
  flushPara();
  return out;
}

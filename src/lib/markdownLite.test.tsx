// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderMarkdownLite } from "./markdownLite";

const html = (src: string) => {
  const { container } = render(<>{renderMarkdownLite(src)}</>);
  return container.innerHTML;
};

describe("markdownLite・白名單語法", () => {
  afterEach(cleanup);

  it("標題", () => expect(html("## 標題")).toBe("<h2>標題</h2>"));
  // 票 25：state.md 第一行固定是 `# 專案 — 狀態`，不認的話每份離場筆記都露出一個 `#`
  it("一級標題；# 後沒有空白不算，### 不在子集裡照樣原樣", () => {
    expect(html("# 標題\n\n內文")).toBe("<h1>標題</h1><p>內文</p>");
    expect(html("#標題")).toBe("<p>#標題</p>");
    expect(html("### 三級")).toBe("<p>### 三級</p>");
  });
  it("粗體與斜體", () => expect(html("a **b** *c*")).toBe("<p>a <strong>b</strong> <em>c</em></p>"));
  it("行內程式碼裡的星號不解析", () => expect(html("`**x**`")).toBe("<p><code>**x**</code></p>"));
  it("程式碼區塊", () => expect(html("```\nline\n```")).toBe("<pre><code>line</code></pre>"));
  it("清單", () => expect(html("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>"));
  it("引用", () => expect(html("> q")).toBe("<blockquote><p>q</p></blockquote>"));
  it("連結", () => {
    expect(html("[t](https://x.y/z)")).toBe('<p><a href="https://x.y/z">t</a></p>');
  });
  it("段落之間用空行分", () => expect(html("a\n\nb")).toBe("<p>a</p><p>b</p>"));
});

describe("markdownLite・escape 與 URL 邊界（spec §9.4）", () => {
  afterEach(cleanup);

  it("HTML 標籤不執行", () => {
    const out = html('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
  it.each(["javascript:alert(1)", "JavaScript:alert(1)", "  javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x"])(
    "危險 scheme 不產生連結：%s", (u) => {
      const out = html(`[t](${u})`);
      expect(out).not.toContain("<a");
      expect(out).toContain("[t](");
    },
  );
  it.each(["/path", "./path", "//host/path", "not a url"])("相對路徑不產生連結：%s", (u) => {
    expect(html(`[t](${u})`)).not.toContain("<a");
  });
  it("href 裡的引號不會跳脫屬性", () => {
    // §9.4 第三條的保證是「引號跳脫不出屬性」，不是「危險字串不出現在 href 裡」——
    // WHATWG 的 URL 序列化只把引號與空白 percent-encode，onmouseover= 這串字仍在 href 中，
    // 但它是屬性值的一部分、不是新屬性。要驗的是 <a> 身上沒有長出額外的屬性。
    const { container } = render(<>{renderMarkdownLite('[t](https://x.y/" onmouseover="alert(1))')}</>);
    const a = container.querySelector("a");
    expect(a?.getAttributeNames()).toEqual(["href"]);
    expect(container.innerHTML).not.toContain('onmouseover="');
  });
  it("表格原樣顯示", () => {
    const src = "| a | b |\n|---|---|";
    const out = html(src);
    expect(out).toContain("| a | b |");
    expect(out).not.toContain("<table");
  });
});

// 多行接回同一行（spec §4.1.5）：整段一起解析行內語法，再看畫面上換行左右兩個字決定要不要插空格
describe("markdownLite・換行接回同一行（spec §4.1.5）", () => {
  afterEach(cleanup);

  it("中文接中文不插空格", () => expect(html("第一行\n第二行")).toBe("<p>第一行第二行</p>"));
  it("英文接英文放一個空格", () => expect(html("a\nb")).toBe("<p>a b</p>"));
  it("中英相接放一個空格", () => expect(html("Andrew Ng\n那份")).toBe("<p>Andrew Ng 那份</p>"));
  it("行頭行尾的半形空白與 tab 去掉，全形空白留著", () => expect(html("  第一行 \t\n　第二行")).toBe("<p>第一行　第二行</p>"));
  it("換行前是粗體：看粗體裡的字", () => expect(html("完成**設定**\n接著測試")).toBe("<p>完成<strong>設定</strong>接著測試</p>"));
  it("換行後是粗體：看粗體裡的字", () => expect(html("完成\n**設定**")).toBe("<p>完成<strong>設定</strong></p>"));
  it("換行前是行內碼", () => expect(html("完成`設定`\n接著")).toBe("<p>完成<code>設定</code>接著</p>"));
  it("換行前是刪除線", () => expect(html("完成~~設定~~\n接著")).toBe("<p>完成<del>設定</del>接著</p>"));
  it("換行前是連結", () => expect(html("見[說明](https://x.y/z)\n再處理")).toBe('<p>見<a href="https://x.y/z">說明</a>再處理</p>'));
  it("粗體可以跨行，裡面的換行照同一條規則", () => expect(html("**跨\n行**")).toBe("<p><strong>跨行</strong></p>"));
  it("被 safeHref 擋下的連結是文字，看的是 )", () => expect(html("[說明](javascript:x)\n再處理")).toBe("<p>[說明](javascript:x) 再處理</p>"));
  it("引用也一樣", () => expect(html("> 第一行\n> **第二**行")).toBe("<blockquote><p>第一行<strong>第二</strong>行</p></blockquote>"));
  it("中性標點接中文不插空格", () => expect(html("等等…\n接著")).toBe("<p>等等…接著</p>"));
  it("中性標點接英文照樣插空格", () => expect(html("wait…\nnext")).toBe("<p>wait… next</p>"));
  it("中文接中性標點不插空格", () => expect(html("中文\n“引號”")).toBe("<p>中文“引號”</p>"));
  it("破折號兩側都是中文時不插空格", () => expect(html("前面——\n後面")).toBe("<p>前面——後面</p>"));
});

describe("markdownLite・刪除線（spec §4.1.4）", () => {
  afterEach(cleanup);

  it("~~文字~~ 是刪除線", () => expect(html("~~刪~~ 留")).toBe("<p><del>刪</del> 留</p>"));
  it("行內碼裡的 ~~ 不解析", () => expect(html("`~~x~~`")).toBe("<p><code>~~x~~</code></p>"));
  it("刪除線的內容不再解析", () => expect(html("~~**x**~~")).toBe("<p><del>**x**</del></p>"));
});

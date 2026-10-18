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
  it("一級標題；# 後沒有空白不算，#### 以上照樣原樣", () => {
    expect(html("# 標題\n\n內文")).toBe("<h1>標題</h1><p>內文</p>");
    expect(html("#標題")).toBe("<p>#標題</p>");
    expect(html("#### 四級")).toBe("<p>#### 四級</p>");
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
  // 2026-10-19 起認得表格（spec §4.1.3）；沒有分隔列的 | 行仍是段落文字
  it("沒有分隔列的 | 行照樣原樣", () => expect(html("| a | b |\n| 1 | 2 |")).toBe("<p>| a | b | | 1 | 2 |</p>"));
  it("表格儲存格裡的危險連結不產生 <a>", () => expect(html("| a |\n|---|\n| [t](javascript:x) |"))
    .toBe('<div class="tk-tbl"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>[t](javascript:x)</td></tr></tbody></table></div>'));
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

// 清單（spec §4.1.2）：第一層從縮排 0～1 格的項目行開始；縮排 2 格以上是子項目（只有一層）或續行
describe("markdownLite・清單（spec §4.1.2）", () => {
  afterEach(cleanup);

  it("編號清單", () => expect(html("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>"));
  it("起始號照第一項", () => expect(html("6. a\n7. b")).toBe('<ol start="6"><li>a</li><li>b</li></ol>'));
  it("起始號只放數字", () => expect(html("007. a")).toBe('<ol start="7"><li>a</li></ol>'));
  it("十位數以上不算項目", () => expect(html("1234567890. x")).toBe("<p>1234567890. x</p>"));
  it("符號換種類就開新清單", () => expect(html("- a\n1. b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>"));
  it("縮排 1 格也算第一層", () => expect(html(" - a\n - b")).toBe("<ul><li>a</li><li>b</li></ul>"));
  it("- 下面掛編號子項目", () => expect(html("- a\n  1. b\n  2. c")).toBe("<ul><li>a<ol><li>b</li><li>c</li></ol></li></ul>"));
  it("編號下面掛 - 子項目", () => expect(html("1. a\n   - b")).toBe("<ol><li>a<ul><li>b</li></ul></li></ol>"));
  it("子清單換種類就在同一個父項目下開新子清單", () => expect(html("- a\n  - b\n  1. c")).toBe("<ul><li>a<ul><li>b</li></ul><ol><li>c</li></ol></li></ul>"));
  it("縮排 4 格的項目行也算子項目", () => expect(html("- a\n    - b")).toBe("<ul><li>a<ul><li>b</li></ul></li></ul>"));
  it("子項目之後回到第一層", () => expect(html("- a\n  - b\n- c")).toBe("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>"));
  it("續行接在第一層項目後面", () => expect(html("- 第一行\n  第二行")).toBe("<ul><li>第一行第二行</li></ul>"));
  it("續行接在子項目後面", () => expect(html("- a\n  - b\n    c")).toBe("<ul><li>a<ul><li>b c</li></ul></li></ul>"));
  it("續行跨過行內格式", () => expect(html("- 第一行\n  **第二**行")).toBe("<ul><li>第一行<strong>第二</strong>行</li></ul>"));
  it("續行的內容一律當文字", () => expect(html("- a\n  > b")).toBe("<ul><li>a &gt; b</li></ul>"));
  it("空行結束清單", () => expect(html("- a\n\n- b")).toBe("<ul><li>a</li></ul><ul><li>b</li></ul>"));
  it("被空行隔開的編號清單，第二份從它的號碼開始", () => expect(html("1. a\n\n2. b")).toBe('<ol><li>a</li></ol><ol start="2"><li>b</li></ol>'));
  it("沒縮排的文字結束清單", () => expect(html("- a\nb")).toBe("<ul><li>a</li></ul><p>b</p>"));
  it("縮排 2 格的項目行接在段落後面時是段落文字", () => expect(html("文字\n  - b")).toBe("<p>文字 - b</p>"));
  it("清單可以緊接在段落後面", () => expect(html("說明：\n1. a")).toBe("<p>說明：</p><ol><li>a</li></ol>"));
});

// 標題、分隔線、表格（spec §4.1.1、§4.1.3）
describe("markdownLite・標題、分隔線、表格（spec §4.1.1、§4.1.3）", () => {
  afterEach(cleanup);

  it("三級標題", () => expect(html("### 三級")).toBe("<h3>三級</h3>"));
  it("--- 是分隔線", () => expect(html("---")).toBe("<hr>"));
  it("*** 是分隔線", () => expect(html("***")).toBe("<hr>"));
  it("前面 3 個空格也算分隔線", () => expect(html("   ---")).toBe("<hr>"));
  it("後面有空白也算分隔線", () => expect(html("---  ")).toBe("<hr>"));
  it("前面 4 個空格不算分隔線", () => expect(html("    ---")).toBe("<p>---</p>"));
  it("段落後面接 --- 是分隔線", () => expect(html("a\n---")).toBe("<p>a</p><hr>"));
  it("標準表格", () => expect(html("| a | b |\n|---|---|\n| 1 | 2 |")).toBe('<div class="tk-tbl"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>'));
  it("分隔列的欄數不同時不是表格", () => expect(html("| a | b |\n|---|\n| 1 | 2 |")).toBe("<p>| a | b | |---| | 1 | 2 |</p>"));
  // 欄數不足的列不補格（Codex 合併前審查）：補格會讓輸出隨「表頭欄數 × 列數」放大；真實資料沒有欄數不足的列
  it("資料列欄數不足不補格、過多捨去", () => expect(html("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")).toBe('<div class="tk-tbl"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>1</td><td>2</td></tr></tbody></table></div>'));
  it("沒有資料列", () => expect(html("| a |\n|---|")).toBe('<div class="tk-tbl"><table><thead><tr><th>a</th></tr></thead><tbody></tbody></table></div>'));
  it("儲存格裡的行內語法", () => expect(html("| **a** | `b` |\n|---|---|")).toBe('<div class="tk-tbl"><table><thead><tr><th><strong>a</strong></th><th><code>b</code></th></tr></thead><tbody></tbody></table></div>'));
  it("表格可以緊接在段落後面", () => expect(html("說明：\n| a |\n|---|")).toBe('<p>說明：</p><div class="tk-tbl"><table><thead><tr><th>a</th></tr></thead><tbody></tbody></table></div>'));
  it("對齊冒號接受但不使用", () => expect(html("| a |\n|:---:|")).toBe('<div class="tk-tbl"><table><thead><tr><th>a</th></tr></thead><tbody></tbody></table></div>'));
});

// 刻意構造的輸入只保證不丟例外（spec §4.1.7）。片段涵蓋每一條逐行規則的開頭與它們的交界；固定種子，紅了可以重現
describe("markdownLite・任何輸入都不丟例外（spec §4.1.7）", () => {
  afterEach(cleanup);
  const PIECES = ["- a", "1. b", "  - c", "  2. d", "    e", "  f", "| x | y |", "|---|---|", "|---|", "| 1 |", "```", "", "# h", "## h",
    "### h", "---", "***", "> q", "~~s~~", "**b**", "`c`", "中文", "6. g", "   - h", "|", "-", "1."];

  it("固定種子隨機組出 500 份文件，每份都渲染成功", () => {
    let seed = 20261019;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 500; n++) {
      const doc = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => PIECES[Math.floor(rnd() * PIECES.length)]).join("\n");
      expect(() => html(doc), doc).not.toThrow();
    }
  });

  // 不卡住（spec §4.1.7，Codex 合併前審查）：短的資料列若照表頭補格，500 欄 × 500 行單獨的 | 只要 5 KB 就產生 25 萬格
  it("表格的格數不比輸入的 | 多：100 欄表頭接 100 行單獨的 | 只有 100 格", () => {
    const doc = [`|${" a |".repeat(100)}`, `|${"---|".repeat(100)}`, ...Array(100).fill("|")].join("\n");
    expect(html(doc).match(/<td>/g)?.length).toBe(100);
  });
});

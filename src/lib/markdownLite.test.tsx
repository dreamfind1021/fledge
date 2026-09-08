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

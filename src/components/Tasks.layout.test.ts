import { describe, expect, it } from "vitest";

// 三欄版面的防線（票 19，spec §5.1）。同前版的理由：jsdom 不做版面計算，
// scrollWidth/clientWidth 恆為 0，只能驗 CSS 的**規則存在性**與**數值預算**；
// 真正的版面由 headless Chrome／dev app 三個寬度各看一次，數字記在 Tasks.css 註解。
const RAW = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const css = (() => {
  const text = RAW["/src/components/Tasks.css"];
  if (typeof text !== "string") throw new Error("glob 沒讀到 Tasks.css");
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
})();

// 取某個 @container 區塊（依 min-width 值）。找不到就炸——靜默跳過等於防線沒上場
const block = (minWidth: number) => {
  const re = new RegExp(`@container\\s+tasks\\s*\\(\\s*min-width\\s*:\\s*${minWidth}px\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`Tasks.css 找不到 @container tasks (min-width: ${minWidth}px)`);
  return m[1];
};
const decl = (text: string, selector: string, prop: string) => {
  const rule = [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .find((m) => m[1].split(",").map((x) => x.trim()).includes(selector));
  if (!rule) throw new Error(`找不到規則 ${selector}`);
  const m = rule[2].match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  if (!m) throw new Error(`${selector} 沒有宣告 ${prop}`);
  return m[1].trim();
};
const px = (v: string) => { const m = v.match(/(\d+(?:\.\d+)?)px/); if (!m) throw new Error(`取不出 px：${v}`); return parseFloat(m[1]); };

describe("待辦面板三欄版面", () => {
  it(".tasks-root 是 container query 的容器（側邊欄可收合，不能用 viewport 斷點）", () => {
    expect(decl(css, ".tasks-root", "container-type")).toBe("inline-size");
  });

  it("預設（窄）：常駐樹收起、攤開的樹顯示、右欄有東西就藏清單、沒東西就藏右欄", () => {
    expect(decl(css, ".tasks-split > .tree", "display")).toBe("none");
    expect(decl(css, ".tasks-col-all .tree.as-page", "display")).toBe("flex");
    expect(decl(css, '.tasks-split[data-pane="open"] .tasks-col-list', "display")).toBe("none");
    expect(decl(css, '.tasks-split[data-pane="none"] .tasks-col-detail', "display")).toBe("none");
  });

  it("中（≥760）：樹回來、攤開的樹藏掉、清單的返回藏掉、右欄的返回打開", () => {
    const b = block(760);
    expect(decl(b, ".tasks-split > .tree", "display")).toBe("flex");
    expect(decl(b, ".tasks-col-all .tree.as-page", "display")).toBe("none");
    expect(decl(b, ".tasks-col-list .tasks-back", "display")).toBe("none");
    expect(decl(b, ".lb-detail .tasks-back", "display")).toBe("inline-flex");
  });

  it("寬（≥1040）：清單與右欄同時顯示、右欄的返回藏掉", () => {
    const b = block(1040);
    expect(decl(b, '.tasks-split[data-pane="open"] .tasks-col-list', "display")).toBe("block");
    expect(decl(b, '.tasks-split[data-pane="none"] .tasks-col-detail', "display")).toBe("block");
    expect(decl(b, ".lb-detail .tasks-back", "display")).toBe("none");
  });

  // 樹 232 ＋ 清單最小 360 ＋ 右欄至少 380 ≤ 1040：有人把任何一個數字調大都應該被擋下來
  it("寬等級的最小寬度預算在 1040 內", () => {
    const tree = px(decl(css, ".tree", "width"));
    const listMin = px(decl(block(1040), ".tasks-col-list", "min-width"));
    expect(tree + listMin + 380).toBeLessThanOrEqual(1040);
  });
});

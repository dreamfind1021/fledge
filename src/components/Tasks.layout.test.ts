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
    expect(decl(b, '.tasks-split[data-pane="none"] .tasks-col-detail', "display")).toBe("flex");   // 顯示，且不得蓋掉置中用的 flex column
    expect(decl(b, ".lb-detail .tasks-back", "display")).toBe("none");
  });

  // 空狀態置中（票 19 增補 §10.3）：.lb-detail.is-empty 自己是 flex 置中，但它得先撐滿右欄才有東西可以置中——
  // demo 置中是因為 demo 的 .lb-detail 本身撐滿欄；正式版少了這兩條，提示黏在右欄頂端
  // 空狀態只出現在 data-pane="none"，而寬等級那條 display 規則蓋得掉基礎規則——只驗基礎規則會假綠
  // （headless Chrome 實測：那條留 block 時提示仍黏在頂端 22px，改 flex 才落到 600px 高的中間）
  it("右欄是 flex column、.lb-detail 撐滿（空狀態置中的前提）", () => {
    expect(decl(css, ".tasks-col-detail", "display")).toBe("flex");
    expect(decl(css, ".tasks-col-detail", "flex-direction")).toBe("column");
    expect(decl(css, ".lb-detail", "flex")).toBe("1");
    expect(decl(block(1040), '.tasks-split[data-pane="none"] .tasks-col-detail', "display")).toBe("flex");
  });

  // 樹 232 ＋ 清單取 max(min-width, 剩餘×比例) ＋ 右欄至少 380 ≤ 1040；
  // 只加 min-width 會漏掉比例撐大清單的情況——Codex 守門抓到的假綠
  it("寬等級的最小寬度預算在 1040 內", () => {
    const tree = px(decl(css, ".tree", "width"));
    const b = block(1040);
    const flex = decl(b, ".tasks-col-list", "flex");
    const minWidth = px(decl(b, ".tasks-col-list", "min-width"));
    // flex-basis 必須是 calc((100% - Tpx) * F) 的形式，才能算出扣掉樹之後的剩餘寬度
    const calcMatch = flex.match(/calc\(\(100% - (\d+(?:\.\d+)?)px\)\s*\*\s*(\d*\.\d+|\d+)\)/);
    if (!calcMatch) throw new Error(`.tasks-col-list 的 flex-basis 不是預期的 calc((100% - Tpx) * F) 形式：${flex}`);
    const treeInCalc = parseFloat(calcMatch[1]);
    const ratio = parseFloat(calcMatch[2]);
    // calc 裡的樹寬要跟 .tree 的 width 同一個數字（單一事實來源，避免兩處各自維護漂移）
    expect(treeInCalc, `calc 裡的樹寬 ${treeInCalc} 應等於 .tree 的 width ${tree}`).toBe(tree);
    const basisAt1040 = (1040 - treeInCalc) * ratio;
    const list = Math.max(minWidth, basisAt1040);
    const total = tree + list + 380;
    expect(total, `樹 ${tree} ＋ 清單 ${list}（basis ${basisAt1040} / min-width ${minWidth}）＋ 右欄 380 ＝ ${total} 應 ≤ 1040`).toBeLessThanOrEqual(1040);
  });
});

import { describe, expect, it } from "vitest";

// 三欄版面的防線（票 19，spec §5.1）。同前版的理由：jsdom 不做版面計算，
// scrollWidth/clientWidth 恆為 0，只能驗 CSS 的**規則存在性**與**數值預算**；
// 真正的版面由 headless Chrome／dev app 三個寬度各看一次，數字記在 Tasks.css 註解。
const RAW = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const full = (() => {
  const text = RAW["/src/components/Tasks.css"];
  if (typeof text !== "string") throw new Error("glob 沒讀到 Tasks.css");
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
})();
// 基礎（窄）等級＝拿掉所有 @media／@container 區塊：decl 取最後一條宣告，區塊內的覆寫只在那個寬度生效，
// 混進來會把基礎值蓋掉（Codex final R1）
const css = full.replace(/@[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

// 取某個 @container 區塊（依 min-width 值）。找不到就炸——靜默跳過等於防線沒上場
const block = (minWidth: number) => {
  const re = new RegExp(`@container\\s+tasks\\s*\\(\\s*min-width\\s*:\\s*${minWidth}px\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = full.match(re);
  if (!m) throw new Error(`Tasks.css 找不到 @container tasks (min-width: ${minWidth}px)`);
  return m[1];
};
// 某個選擇器在 text 裡所有規則的 prop 宣告（依出現順序）。規則一條都沒有就炸
const decls = (text: string, selector: string, prop: string) => {
  const rules = [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].split(",").map((x) => x.trim()).includes(selector));
  if (rules.length === 0) throw new Error(`找不到規則 ${selector}`);
  return rules.flatMap((r) => [...r[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].map((m) => m[1].trim()));
};
// 同一個選擇器（權重相同）後面的蓋前面：取最後一條。只取第一條會漏掉檔尾的覆寫（Codex final R1）
const decl = (text: string, selector: string, prop: string) => {
  const all = decls(text, selector, prop);
  if (all.length === 0) throw new Error(`${selector} 沒有宣告 ${prop}`);
  return all[all.length - 1];
};
// 「不准宣告」用這個：規則本身必須存在。用 toThrow 的話規則整條不見也會通過，等於沒驗（Codex final R1）
const hasDecl = (text: string, selector: string, prop: string) => decls(text, selector, prop).length > 0;
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

  it("寬（≥1040）：選了票時清單與右欄同時顯示、右欄的返回藏掉、× 出現；沒選票時右欄不存在、清單撐滿（spec §11.3）", () => {
    const b = block(1040);
    expect(decl(b, '.tasks-split[data-pane="open"] .tasks-col-list', "display")).toBe("block");
    expect(decl(b, '.tasks-split[data-pane="none"] .tasks-col-detail', "display")).toBe("none");
    expect(decl(b, '.tasks-split[data-pane="none"] .tasks-col-list', "flex")).toBe("1 1 auto");
    expect(decl(b, '.tasks-split[data-pane="open"] .tasks-col-list .tk-acts', "display")).toBe("none");   // D18
    expect(decl(b, ".lb-detail .tasks-back", "display")).toBe("none");
    expect(decl(b, ".d-close", "display")).toBe("inline-flex");
  });

  // × 只在寬等級（D19）：中、窄等級由返回鍵關右欄
  it("× 預設不顯示", () => {
    expect(decl(css, ".d-close", "display")).toBe("none");
  });

  // 樹 232 ＋ gap ＋ 清單取 max(min-width, 剩餘×比例) ＋ gap ＋ 右欄至少 380 ＋ 右 padding ≤ 1040（spec §11.3）；
  // 只加 min-width 會漏掉比例撐大清單的情況——Codex 守門抓到的假綠。
  // flex-basis 的百分比對的是 .tasks-split 的內容寬（扣掉 padding，不扣 gap）
  it("寬等級的最小寬度預算在 1040 內（含 .tasks-split 的 padding 與兩道 gap）", () => {
    const tree = px(decl(css, ".tree", "width"));
    const gap = px(decl(css, ".tasks-split", "gap"));
    const padRight = px(decl(css, ".tasks-split", "padding").split(/\s+/)[1]);
    const b = block(1040);
    const flex = decl(b, ".tasks-col-list", "flex");
    const minWidth = px(decl(b, ".tasks-col-list", "min-width"));
    const calcMatch = flex.match(/calc\(\(100% - (\d+(?:\.\d+)?)px\)\s*\*\s*(\d*\.\d+|\d+)\)/);
    if (!calcMatch) throw new Error(`.tasks-col-list 的 flex-basis 不是預期的 calc((100% - Tpx) * F) 形式：${flex}`);
    const treeInCalc = parseFloat(calcMatch[1]);
    const ratio = parseFloat(calcMatch[2]);
    expect(treeInCalc, `calc 裡的樹寬 ${treeInCalc} 應等於 .tree 的 width ${tree}`).toBe(tree);
    const basisAt1040 = (1040 - padRight - treeInCalc) * ratio;
    const list = Math.max(minWidth, basisAt1040);
    const total = tree + gap + list + gap + 380 + padRight;
    expect(total, `樹 ${tree} ＋ gap ${gap} ＋ 清單 ${list} ＋ gap ${gap} ＋ 右欄 380 ＋ padding ${padRight} ＝ ${total} 應 ≤ 1040`).toBeLessThanOrEqual(1040);
  });

  // 票 25：寬等級剛過 1040 時中欄內容只剩 336px，英文摘要單獨就 304px。兩邊一起縮會各折成兩行；
  // 改成排不下時摘要整段換到標題下方。headless Chrome 實測（1040～1200、400／500／700，中英文、
  // 四種專案名）：改前專案名最多折三行、摘要折兩行；改後兩者都一行，排得下時摘要右緣仍貼齊（0～1px）
  it("頁首排不下時摘要整段換到標題下方，不在字中間折", () => {
    expect(decl(css, ".tasks-head", "flex-wrap")).toBe("wrap");
    expect(decl(css, ".tasks-sum", "white-space")).toBe("nowrap");
    // 靠右由 h1 撐滿達成：摘要若用 margin-left: auto，換行後會單獨掛在第二行右邊
    expect(decl(css, ".tasks-head h1", "flex")).toBe("1 1 auto");
    expect(hasDecl(css, ".tasks-sum", "margin-left")).toBe(false);
  });

  // 票 26＋27 D17：票名放不下就折行，不截斷；沒有空白的長字串（英文長 token、URL）也要在列內折斷
  it("票名不截斷：可折行、長字串可斷、列內元素對齊第一行", () => {
    expect(decl(css, ".tk-title", "white-space")).toBe("normal");
    expect(decl(css, ".tk-title", "overflow-wrap")).toBe("anywhere");
    expect(hasDecl(css, ".tk-title", "text-overflow")).toBe(false);
    expect(decl(css, ".tk-row", "align-items")).toBe("flex-start");
  });

  // spec §11.5：分隔靠底色與間距，不靠線
  it("欄與欄之間沒有分隔線", () => {
    expect(hasDecl(css, ".tree", "border-right")).toBe(false);
    expect(hasDecl(block(1040), ".tasks-col-list", "border-right")).toBe(false);
    expect(hasDecl(css, ".d-body", "border")).toBe(false);
  });

  // spec §11.6：軌道寬、最小填充寬（放得下兩位數）、擱置槽固定寬（軌道上下對齊）只寫在 CSS，TS 只給百分比
  it("專案樹軌道：軌道 64px、填充最小 22px、擱置槽最小 18px", () => {
    expect(decl(css, ".tree-trk", "width")).toBe("64px");
    expect(decl(css, ".tree-fill", "min-width")).toBe("22px");
    expect(decl(css, ".tree-n .pk", "min-width")).toBe("18px");
  });
});

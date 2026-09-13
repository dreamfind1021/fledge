import { describe, it, expect } from "vitest";
import { linksInLine, strIndexToColumn, type BufferLineLike } from "./terminalLinks";

const home = "/Users/demo";
const proj = "/Users/demo/proj";
const opts = { home, projectPath: proj };

// 以 [chars, width] 陣列建假 buffer line（全形字＝[字,2] 後接 spacer [,0]）
function mockLine(cells: Array<[string, number]>): BufferLineLike {
  return {
    length: cells.length,
    getCell: (i) => (cells[i] ? { getChars: () => cells[i][0], getWidth: () => cells[i][1] } : undefined),
  };
}

describe("strIndexToColumn", () => {
  it("純 ASCII：欄位＝字串索引", () => {
    const line = mockLine([["X", 1], ["h", 1], ["t", 1], ["t", 1], ["p", 1], ["s", 1]]);
    expect(strIndexToColumn(line, 0)).toBe(0);
    expect(strIndexToColumn(line, 1)).toBe(1);
    expect(strIndexToColumn(line, 5)).toBe(5);
  });

  it("全形字佔 2 欄：字串索引被 spacer 位移", () => {
    // "字https" → 字(col0,w2) + spacer(col1,w0) + h(col2)…
    const line = mockLine([["字", 2], ["", 0], ["h", 1], ["t", 1], ["t", 1], ["p", 1], ["s", 1]]);
    expect(strIndexToColumn(line, 1)).toBe(2); // "h" 在 col2 而非 col1
    expect(strIndexToColumn(line, 5)).toBe(6); // "s" 在 col6
  });
});

describe("linksInLine — URL", () => {
  it("偵測 https 連結與正確索引", () => {
    const line = "see https://github.com/a/b for info";
    const ls = linksInLine(line, opts);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ kind: "url", target: "https://github.com/a/b" });
    expect(line.slice(ls[0].start, ls[0].end)).toBe("https://github.com/a/b");
  });

  it("剝除網址尾隨標點（句號/括號）", () => {
    expect(linksInLine("go to https://x.com.", opts)[0].target).toBe("https://x.com");
    expect(linksInLine("(https://x.com/y)", opts)[0].target).toBe("https://x.com/y");
  });

  it("scheme 大小寫不敏感（HTTPS://）", () => {
    expect(linksInLine("X HTTPS://x.com", opts)[0]).toMatchObject({ kind: "url", target: "HTTPS://x.com" });
  });

  it("只放行 http/https：拒絕 mailto / tel（payload 風險，不支援）", () => {
    expect(linksInLine("mail mailto:a@b.com", opts)).toEqual([]);
    expect(linksInLine("call tel:+123", opts)).toEqual([]);
  });

  it("拒絕非白名單 scheme（javascript / file）", () => {
    expect(linksInLine("x javascript:alert(1)", opts)).toEqual([]);
    expect(linksInLine("x file:///etc/passwd", opts)).toEqual([]);
  });
});

describe("linksInLine — 檔案路徑（邊界＝projectPath）", () => {
  it("相對路徑對 projectPath 解析", () => {
    const ls = linksInLine("edit src/components/App.tsx now", opts);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ kind: "path", target: "/Users/demo/proj/src/components/App.tsx" });
  });

  it("絕對路徑（projectPath 內）直接用", () => {
    expect(linksInLine("open /Users/demo/proj/notes.md", opts)[0].target).toBe("/Users/demo/proj/notes.md");
  });

  it("~/ 展開後須落在 projectPath 內才放行", () => {
    // proj 在 home 下：~/proj/x.md 落在 projectPath 內 → 放行
    expect(linksInLine("cat ~/proj/x.md", opts)[0].target).toBe("/Users/demo/proj/x.md");
    // ~/ 指向 projectPath 外 → 拒絕
    expect(linksInLine("cat ~/todo.md", opts)).toEqual([]);
  });

  it("剝除 :line:col 行號後綴，target 不含行號、底線範圍含行號", () => {
    const line = "err at src/x.ts:42:7 here";
    const ls = linksInLine(line, opts);
    expect(ls[0]).toMatchObject({ kind: "path", target: "/Users/demo/proj/src/x.ts" });
    expect(line.slice(ls[0].start, ls[0].end)).toBe("src/x.ts:42:7");
  });

  it("拒絕逃逸出 projectPath 的相對路徑", () => {
    expect(linksInLine("x ../../../etc/passwd", opts)).toEqual([]);
  });

  it("拒絕 projectPath 外的絕對路徑（含 home 內但專案外）", () => {
    expect(linksInLine("x /etc/hosts", opts)).toEqual([]);
    expect(linksInLine("x /Users/demo/other/secret.md", opts)).toEqual([]); // home 內但專案外
  });

  it("無 projectPath → 相對路徑無基準、不連結", () => {
    expect(linksInLine("edit src/x.ts", { home })).toEqual([]);
  });

  it("含斜線但無副檔名/路徑前綴的普通字不誤判（cat/dog）", () => {
    expect(linksInLine("ratio cat/dog things", opts)).toEqual([]);
  });
});

describe("linksInLine — 混合與邊界", () => {
  it("一行多連結，依出現順序、索引正確", () => {
    const line = "https://a.com then src/b.ts";
    const ls = linksInLine(line, opts);
    expect(ls.map((l) => l.kind)).toEqual(["url", "path"]);
    expect(line.slice(ls[0].start, ls[0].end)).toBe("https://a.com");
    expect(line.slice(ls[1].start, ls[1].end)).toBe("src/b.ts");
  });

  it("URL 不會被當成路徑重複偵測", () => {
    const ls = linksInLine("https://x.com/a/b.ts", opts);
    expect(ls).toHaveLength(1);
    expect(ls[0].kind).toBe("url");
  });

  it("空行回空陣列", () => {
    expect(linksInLine("", opts)).toEqual([]);
  });

  it("無 home（homeDir 失敗）：URL + 相對路徑仍可用、~/ 略過", () => {
    const ls = linksInLine("see https://x.com edit src/a.ts and ~/z.md", { projectPath: proj });
    expect(ls.map((l) => l.kind)).toEqual(["url", "path"]); // ~/z.md 因無 home 被略過
    expect(ls[0].target).toBe("https://x.com");
    expect(ls[1].target).toBe("/Users/demo/proj/src/a.ts");
  });
});

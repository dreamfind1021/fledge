import { describe, it, expect } from "vitest";
import { formatPathsForPaste } from "./dropPath";

describe("formatPathsForPaste", () => {
  it("純 ASCII 安全路徑原樣輸出 + 尾隨空白", () => {
    expect(formatPathsForPaste(["/tmp/file.txt"])).toBe("/tmp/file.txt ");
  });

  it("純中文檔名無空白 → 不加引號（觀感同原生終端）", () => {
    expect(formatPathsForPaste(["/Users/me/專案/筆記.md"])).toBe("/Users/me/專案/筆記.md ");
  });

  it("含空白 → POSIX 單引號包裹", () => {
    expect(formatPathsForPaste(["/tmp/my file.txt"])).toBe("'/tmp/my file.txt' ");
  });

  it("含單引號 → '\\'' 跳脫（收尾→跳脫→重開）", () => {
    expect(formatPathsForPaste(["/tmp/it's.txt"])).toBe("'/tmp/it'\\''s.txt' ");
  });

  it("safe charset 外字元（+）→ 觸發引號", () => {
    expect(formatPathsForPaste(["/tmp/a+b"])).toBe("'/tmp/a+b' ");
  });

  it("emoji 不在 safe charset → 引號包裹", () => {
    expect(formatPathsForPaste(["/tmp/😀.txt"])).toBe("'/tmp/😀.txt' ");
  });

  it("多檔以空白 join、整串尾隨一個空白", () => {
    expect(formatPathsForPaste(["/a", "/b c"])).toBe("/a '/b c' ");
  });

  it("資料夾路徑照貼、無尾隨斜線", () => {
    expect(formatPathsForPaste(["/Users/me/folder"])).toBe("/Users/me/folder ");
  });

  it("含控制字元（換行）的路徑整項跳過、不改寫", () => {
    expect(formatPathsForPaste(["/tmp/a\nb", "/tmp/ok"])).toBe("/tmp/ok ");
  });

  it("全部項目都含控制字元 → 回空字串（caller 不動作）", () => {
    expect(formatPathsForPaste(["/tmp/a\nb"])).toBe("");
  });

  it("空陣列 → 空字串", () => {
    expect(formatPathsForPaste([])).toBe("");
  });

  it("50 paths：全部輸出、單一空白分隔、尾隨一空白", () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/tmp/f${i}`);
    const out = formatPathsForPaste(paths);
    expect(out).toBe(paths.join(" ") + " ");
    expect(out.trimEnd().split(" ").length).toBe(50);
  });
});

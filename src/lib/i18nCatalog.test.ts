import { describe, it, expect } from "vitest";

// 逐 namespace 對帳，而不是只盯 dashboard 一支：CLAUDE.md §4.6.13 要求新字串同步進所有
// locale catalog，而漏掉的那一邊在畫面上是「印出 key 原文」不是崩潰——沒有測試就沒人發現。
// 用 glob 而非逐一 import：新增 namespace 時不必記得回來改這條測試（漏改＝新 catalog 沒被守護）。
const zhFiles = import.meta.glob<Record<string, unknown>>(
  "/src/locales/zh-TW/*.json", { eager: true, import: "default" });
const enFiles = import.meta.glob<Record<string, unknown>>(
  "/src/locales/en/*.json", { eager: true, import: "default" });

function keys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]);
}

const ns = (path: string) => path.split("/").pop()!.replace(".json", "");

describe("i18n catalog", () => {
  it("掃得到 catalog（glob 失效時不能靜默空跑）", () => {
    expect(Object.keys(zhFiles).length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(zhFiles).map(ns).sort()).toEqual(Object.keys(enFiles).map(ns).sort());
  });

  for (const [path, zh] of Object.entries(zhFiles)) {
    const name = ns(path);
    const en = enFiles[`/src/locales/en/${name}.json`];
    it(`${name}：en 與 zh-TW key 集合完全一致`, () => {
      expect(en).toBeDefined();
      expect(keys(zh).sort()).toEqual(keys(en!).sort());
    });
  }
});

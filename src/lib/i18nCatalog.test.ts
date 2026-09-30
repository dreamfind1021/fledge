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

// 上面只比兩語互相一致：兩邊同時刪掉一個 key、程式碼還在引用，照樣全綠，畫面直接印出 key 原文。
// 錯誤訊息只在失敗路徑出現、手動驗收很少走到，所以從原始碼端反查（票 11）。
// 抓「字串字面值」而非 t(...) 呼叫：多張卡片先把 key 放進 CODE_KEY 之類的對照表，之後才交給 t()。
// 看不到動態組字（`errors.${x}`）——那類要嘛先 i18n.exists 再取字，要嘛呼叫端自己確認值域。
const sources = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true });

// `restore:errors.x`、`errors.x`、`mig.install.errors.x` 三種寫法都要抓
const ERROR_KEY = /(["'`])(?:(\w+):)?((?:\w+\.)*errors\.[\w.]+)\1/g;
// 陣列形式 useTranslation(["onboarding", "restore"]) 的預設 namespace 是第一個
const DEFAULT_NS = /useTranslation\(\s*\[?\s*["'](\w+)["']/g;

const refs = Object.entries(sources).flatMap(([path, text]) => {
  const defaults = new Set([...text.matchAll(DEFAULT_NS)].map((m) => m[1]));
  return [...text.matchAll(ERROR_KEY)].map((m) => ({
    where: `${path}:${text.slice(0, m.index).split("\n").length}`,
    // 沒前綴的 key 查檔案的預設 namespace；檔案用了零個或多個 namespace 時無從判斷，留 null 讓下面判紅
    namespace: m[2] ?? (defaults.size === 1 ? [...defaults][0] : null),
    key: m[3],
  }));
});

const keySets = (files: Record<string, Record<string, unknown>>) =>
  new Map(Object.entries(files).map(([path, c]) => [ns(path), new Set(keys(c))]));
const LANGS = { en: keySets(enFiles), "zh-TW": keySets(zhFiles) };

describe("原始碼引用的錯誤訊息 key", () => {
  it("三種寫法都掃得到（glob 或 regex 失效時不能靜默空跑）", () => {
    const seen = refs.map((r) => `${r.where.split(":")[0]} ${r.namespace}:${r.key}`);
    expect(seen).toContain("/src/components/Splash.tsx splash:errors.startup_failed");
    expect(seen).toContain("/src/components/BundleCard.tsx restore:errors.bundle_required");
    expect(seen).toContain("/src/components/InstallPreviewCard.tsx onboarding:mig.install.errors.loadFailed");
  });

  it("每個都在 en 與 zh-TW 的 catalog 裡", () => {
    const missing = refs.flatMap((r) => r.namespace === null
      ? [`${r.where} ${r.key}：檔案的 namespace 不只一個（或沒有），請寫明前綴`]
      : Object.entries(LANGS)
        .filter(([, sets]) => !sets.get(r.namespace!)?.has(r.key))
        .map(([lang]) => `${r.where} ${r.namespace}:${r.key} 不在 ${lang}`));
    expect(missing).toEqual([]);
  });
});

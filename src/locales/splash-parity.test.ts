import { describe, it, expect } from "vitest";
import splashZh from "./zh-TW/splash.json";
import splashEn from "./en/splash.json";
import appZh from "./zh-TW/app.json";
import appEn from "./en/app.json";

function keys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

function values(obj: Record<string, unknown>, prefix = ""): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? values(v as Record<string, unknown>, `${prefix}${k}.`)
      : [[`${prefix}${k}`, String(v)] as [string, string]],
  );
}

// splash 與 app 兩個 namespace 都是本次新增，規則相同故一起守
describe.each([
  ["splash", splashZh, splashEn],
  ["app", appZh, appEn],
])("%s locale parity", (_ns, zh, en) => {
  it("zh-TW 與 en 的 key 集合一致", () => {
    expect(keys(zh).sort()).toEqual(keys(en).sort());
  });

  // i18n-design §2.3：樣式不進 catalog，內嵌標記只能是 <Trans> 的語意標籤
  it("兩語 catalog 都不含 inline style 或 <span>", () => {
    const offenders = [...values(zh), ...values(en)]
      .filter(([, v]) => v.includes("style=") || v.includes("<span"))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  // CLAUDE.md §4.6.13：例外原文不得進畫面。`{{reason}}` 是唯一會把 String(e) 帶進文案的插值，
  // 守在 catalog 這層——呼叫端要傳 reason 得先有個位置放它。啟動失敗的原文只進「詳細資訊」與 console。
  it("errors.* 不得帶 {{reason}} 插值", () => {
    const offenders = [...values(zh), ...values(en)]
      .filter(([k, v]) => k.startsWith("errors.") && v.includes("{{reason}}"))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it("同一 key 的插值與標籤兩語一致", () => {
    const shape = (v: string) => ({
      vars: [...new Set(v.match(/\{\{(\w+)\}\}/g) ?? [])].sort(),
      tags: [...new Set(v.match(/<\/?[a-zA-Z]+\s*\/?>/g) ?? [])].sort(),
    });
    const enByKey = Object.fromEntries(values(en));
    for (const [key, zhValue] of values(zh)) {
      expect({ key, ...shape(zhValue) }).toEqual({ key, ...shape(enByKey[key]) });
    }
  });
});

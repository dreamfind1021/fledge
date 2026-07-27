import { describe, it, expect } from "vitest";
import zh from "./zh-TW/onboarding.json";
import en from "./en/onboarding.json";

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

describe("onboarding locale parity", () => {
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

  // spec-b4 §5／CLAUDE.md §4.6.13：畫面上的錯誤訊息一律由 catalog 映射，後端判別碼與例外
  // 原文只進 console。`{{reason}}` 是唯一會把 `String(e)`（`HTTP 500`、`TypeError: Failed to
  // fetch`、sidecar 中文 prose）帶進畫面的插值，所以守在 catalog 這一層——呼叫端要傳 reason
  // 得先有個位置放它。其他插值（path/name/count…）都是前端自己的資料，不在此限。
  it("errors.* 不得帶 {{reason}} 插值（例外原文不進畫面）", () => {
    const offenders = [...values(zh), ...values(en)]
      .filter(([k, v]) => k.startsWith("errors.") && v.includes("{{reason}}"))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  // 同一 key 兩語的插值變數與標籤必須一致，否則某語會漏掉 {{count}} 或少一個 <Trans> 子元素
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

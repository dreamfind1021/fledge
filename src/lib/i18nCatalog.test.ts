import { describe, it, expect } from "vitest";
import zhTW from "../locales/zh-TW/dashboard.json";
import en from "../locales/en/dashboard.json";

function keys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]);
}

describe("i18n catalog", () => {
  it("en 與 zh-TW key 集合完全一致", () => {
    expect(keys(zhTW).sort()).toEqual(keys(en).sort());
  });
});

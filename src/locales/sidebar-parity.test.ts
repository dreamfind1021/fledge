import { describe, it, expect } from "vitest";
import zh from "./zh-TW/sidebar.json";
import en from "./en/sidebar.json";

function keys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe("sidebar locale parity", () => {
  it("zh-TW 與 en 的 key 集合一致", () => {
    expect(keys(zh).sort()).toEqual(keys(en).sort());
  });
});

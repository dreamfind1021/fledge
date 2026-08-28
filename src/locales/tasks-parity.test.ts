import { describe, it, expect } from "vitest";
import en from "./en/tasks.json";
import zh from "./zh-TW/tasks.json";
function keys(o: object, p = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "object" && v ? keys(v as object, `${p}${k}.`) : [`${p}${k}`]);
}
describe("tasks i18n parity", () => {
  it("en 與 zh-TW key 完全一致", () => {
    expect(keys(en).sort()).toEqual(keys(zh).sort());
  });
});

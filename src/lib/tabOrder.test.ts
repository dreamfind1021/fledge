import { describe, it, expect } from "vitest";
import { reorderTabs } from "./tabOrder";

const mk = (id: string) => ({ id });

describe("reorderTabs", () => {
  it("把 active 移到 over 之前（往前移）", () => {
    const tabs = [mk("a"), mk("b"), mk("c")];
    expect(reorderTabs(tabs, "c", "a").map((t) => t.id)).toEqual(["c", "a", "b"]);
  });
  it("往後移", () => {
    const tabs = [mk("a"), mk("b"), mk("c")];
    expect(reorderTabs(tabs, "a", "c").map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
  it("active === over 時不變", () => {
    const tabs = [mk("a"), mk("b")];
    expect(reorderTabs(tabs, "a", "a")).toBe(tabs);
  });
  it("找不到 id 時不變", () => {
    const tabs = [mk("a"), mk("b")];
    expect(reorderTabs(tabs, "x", "a")).toBe(tabs);
  });
});

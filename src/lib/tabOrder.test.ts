import { describe, it, expect } from "vitest";
import { reorderTabs } from "./tabOrder";
import { insertTabAdjacent } from "./tabOrder";

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

const tab = (id: string, projectPath: string) => ({ id, projectPath });

describe("insertTabAdjacent", () => {
  it("該專案尚無分頁 → push 末端", () => {
    const tabs = [tab("a", "/p1")];
    const got = insertTabAdjacent(tabs, tab("new", "/p2"));
    expect(got.map((t) => t.id)).toEqual(["a", "new"]);
  });
  it("該專案已有 claude → 插在其後", () => {
    const tabs = [tab("c1", "/p1"), tab("c2", "/p2")];
    const got = insertTabAdjacent(tabs, tab("new", "/p1"));
    expect(got.map((t) => t.id)).toEqual(["c1", "new", "c2"]);
  });
  it("該專案已有多個分頁 → 插在群尾", () => {
    const tabs = [tab("c1", "/p1"), tab("t1", "/p1"), tab("c2", "/p2")];
    const got = insertTabAdjacent(tabs, tab("new", "/p1"));
    expect(got.map((t) => t.id)).toEqual(["c1", "t1", "new", "c2"]);
  });
  it("同專案分頁散落 → 插在最後一個之後", () => {
    const tabs = [tab("c1", "/p1"), tab("c2", "/p2"), tab("t1", "/p1")];
    const got = insertTabAdjacent(tabs, tab("new", "/p1"));
    expect(got.map((t) => t.id)).toEqual(["c1", "c2", "t1", "new"]);
  });
});

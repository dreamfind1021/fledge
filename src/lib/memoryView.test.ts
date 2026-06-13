import { it, expect } from "vitest";
import { buildGroups, defaultExpanded, matchesFacet, applyFacet, selectionValid,
  type Facet } from "./memoryView";
import type { MemoryOverview, MemoryItem } from "./sidecar";

function item(p: Partial<MemoryItem>): MemoryItem {
  return { source: "native", scope: "global", path: "/x.md", title: "t", type: "user",
    summary: "s", tags: [], status: "", links: [], mtime: 0, ...p };
}
function overview(p: Partial<MemoryOverview>): MemoryOverview {
  return { global: [], projects: [], kb: [], unattributed: [], unknown: [],
    scan_meta: { total: 0, unknown_count: 0, unattributed_count: 0 }, ...p };
}
const NO_FACET: Facet = { source: [], type: [] };

it("buildGroups 依序：global → 各專案 → kb → unattributed → unknown，空區跳過", () => {
  const o = overview({
    global: [item({ path: "/g.md" })],
    projects: [{ project: "/work/a", items: [item({ path: "/a.md", scope: "project", type: "project" })], related: [], suggestions: [] }],
    kb: [item({ path: "/k.md", source: "kms", scope: "kb", domain: "library", type: "" })],
  });
  const g = buildGroups(o);
  expect(g.map(x => x.kind)).toEqual(["global", "project", "kb"]);
  expect(g[1].key).toBe("proj:/work/a");
  expect(g[1].projectKey).toBe("/work/a");
});

it("defaultExpanded 只展開專案 group", () => {
  const g = buildGroups(overview({
    global: [item({})],
    projects: [{ project: "/work/a", items: [item({})], related: [], suggestions: [] }],
  }));
  const exp = defaultExpanded(g);
  expect(exp.has("proj:/work/a")).toBe(true);
  expect(exp.has("global")).toBe(false);
});

it("matchesFacet：source 與 type（kms 用 domain）皆空＝全部；有值才過濾", () => {
  const nat = item({ source: "native", type: "feedback" });
  const kms = item({ source: "kms", type: "", domain: "topics" });
  expect(matchesFacet(nat, NO_FACET)).toBe(true);
  expect(matchesFacet(nat, { source: ["kms"], type: [] })).toBe(false);
  expect(matchesFacet(kms, { source: [], type: ["topics"] })).toBe(true);
  expect(matchesFacet(nat, { source: [], type: ["topics"] })).toBe(false);
  expect(matchesFacet(nat, { source: [], type: ["feedback"] })).toBe(true);
});

it("applyFacet 過濾各 group 的 items 並丟掉變空的 group", () => {
  const g = buildGroups(overview({
    global: [item({ path: "/g.md", source: "native", type: "user" })],
    kb: [item({ path: "/k.md", source: "kms", domain: "library", type: "" })],
  }));
  const out = applyFacet(g, { source: ["kms"], type: [] });
  expect(out.map(x => x.kind)).toEqual(["kb"]);          // global 全被濾→丟掉
  expect(out[0].items).toHaveLength(1);
});

it("selectionValid：item 以 path 存在於任一 group 為準（含 fan-out）；project 需該專案仍在", () => {
  const g = buildGroups(overview({
    projects: [
      { project: "/work/a", items: [item({ path: "/a.md" })], related: [], suggestions: [] },
      { project: "/work/b", items: [item({ path: "/shared.md", source: "kms", domain: "topics", type: "" })], related: [], suggestions: [] },
    ],
  }));
  const g2 = buildGroups(overview({
    projects: [
      { project: "/work/a", items: [item({ path: "/shared.md", source: "kms", domain: "topics", type: "" })], related: [], suggestions: [] },
      { project: "/work/b", items: [item({ path: "/shared.md", source: "kms", domain: "topics", type: "" })], related: [], suggestions: [] },
    ],
  }));
  expect(selectionValid({ kind: "item", path: "/a.md", groupKey: "proj:/work/a" }, g)).toBe(true);
  expect(selectionValid({ kind: "item", path: "/gone.md", groupKey: "proj:/work/a" }, g)).toBe(false);
  // groupKey 指向 /work/a，但 /shared.md 只在 /work/b → path-anywhere 仍須有效（鎖死「不靠 groupKey 判存在」）
  expect(selectionValid({ kind: "item", path: "/shared.md", groupKey: "proj:/work/a" }, g)).toBe(true);
  expect(selectionValid({ kind: "item", path: "/shared.md", groupKey: "proj:/work/a" }, g2)).toBe(true);
  expect(selectionValid({ kind: "item", path: "/shared.md", groupKey: "proj:/work/b" }, g2)).toBe(true);
  expect(selectionValid({ kind: "project", projectKey: "/work/a" }, g)).toBe(true);
  expect(selectionValid({ kind: "project", projectKey: "/nope" }, g)).toBe(false);
  expect(selectionValid(null, g)).toBe(false);
});

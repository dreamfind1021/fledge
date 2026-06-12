import { describe, it, expect } from "vitest";
import { groupProjectsByAccount, tabKey, RECENT_BAND_LIMIT } from "./sidebarGroups";
import type { Project } from "./sidecar";

// 測試用 Project 工廠：預設 source=root、recent=null、path=/r/<name>
const mk = (over: Partial<Project> & { name: string; account: string }): Project => ({
  path: `/r/${over.name}`,
  source: "root",
  root: "/r",
  recent: null,
  ...over,
});

const ACCOUNTS = {
  work: { config_dir: "~/.claude", label: "工作" },
  personal: { config_dir: "~/.claude-tc", label: "私人" },
};

describe("groupProjectsByAccount", () => {
  it("依帳號分組、空群組不顯示、群組順序依 accounts key 順序", () => {
    const projects = [mk({ name: "a", account: "work" }), mk({ name: "b", account: "personal" }), mk({ name: "c", account: "work" })];
    const accounts = { ...ACCOUNTS, team: { config_dir: "~/.claude-team", label: "團隊" } }; // team 無專案
    const groups = groupProjectsByAccount(projects, new Set(), accounts);
    expect(groups.map((g) => g.key)).toEqual(["work", "personal"]); // team 不出現、順序依 accounts
    expect(groups[0].total).toBe(2);
    expect(groups[1].total).toBe(1);
    expect(groups[0].label).toBe("工作");
    expect(groups[0].configDir).toBe("~/.claude");
  });

  it("三 band 分類：open / surfaced(recent or manual) / discovered", () => {
    const op = mk({ name: "op", account: "work" });
    const rc = mk({ name: "rc", account: "work", recent: 100 });
    const mn = mk({ name: "mn", account: "work", source: "manual" });
    const dc = mk({ name: "dc", account: "work" });
    const openTabKeys = new Set([tabKey("/r/op", "work")]);
    const [g] = groupProjectsByAccount([op, rc, mn, dc], openTabKeys, ACCOUNTS);
    expect(g.open.map((p) => p.name)).toEqual(["op"]);
    // 此處只驗「rc/mn 都在 surfaced」，排序另有專測 → 故 .sort() 後比較、不對順序主張
    expect(g.surfaced.map((p) => p.name).sort()).toEqual(["mn", "rc"]);
    expect(g.discovered.map((p) => p.name)).toEqual(["dc"]);
  });

  it("openInType：同 path 但 tab 帳號≠類型（額度臨時開）不歸 band 1", () => {
    const qp = mk({ name: "qp", account: "work" }); // 類型 work
    const openTabKeys = new Set([tabKey("/r/qp", "personal")]); // 卻只用 personal 開著
    const [g] = groupProjectsByAccount([qp], openTabKeys, ACCOUNTS);
    expect(g.open).toEqual([]); // 不點亮 work 列
    expect(g.discovered.map((p) => p.name)).toEqual(["qp"]); // recent=null → 落自動發現
  });

  it("排序：band1 name 升冪、band2 recent 降冪且 manual 殿後、band3 name 升冪", () => {
    const projects = [
      mk({ name: "o-b", account: "work" }),
      mk({ name: "o-a", account: "work" }),
      mk({ name: "r-old", account: "work", recent: 10 }),
      mk({ name: "r-new", account: "work", recent: 30 }),
      mk({ name: "m-x", account: "work", source: "manual" }),
      mk({ name: "d-b", account: "work" }),
      mk({ name: "d-a", account: "work" }),
    ];
    const openTabKeys = new Set([tabKey("/r/o-b", "work"), tabKey("/r/o-a", "work")]);
    const [g] = groupProjectsByAccount(projects, openTabKeys, ACCOUNTS);
    expect(g.open.map((p) => p.name)).toEqual(["o-a", "o-b"]);
    expect(g.surfaced.map((p) => p.name)).toEqual(["r-new", "r-old", "m-x"]); // recent 降冪、manual 殿後
    expect(g.discovered.map((p) => p.name)).toEqual(["d-a", "d-b"]);
  });

  it("dangling 帳號 key：label 退回 key、configDir 空、接在 accounts 群組後、不被丟棄", () => {
    const projects = [mk({ name: "w", account: "work" }), mk({ name: "x", account: "ghost" })];
    const groups = groupProjectsByAccount(projects, new Set(), ACCOUNTS);
    expect(groups.map((g) => g.key)).toEqual(["work", "ghost"]);
    const ghost = groups[1];
    expect(ghost.label).toBe("ghost");
    expect(ghost.configDir).toBe("");
    expect(ghost.total).toBe(1);
  });

  it("空 projects → 回空陣列", () => {
    expect(groupProjectsByAccount([], new Set(), ACCOUNTS)).toEqual([]);
  });

  it("manual 帶 recent → 仍進 surfaced 且依 recent 排序（非殿後）", () => {
    const mr = mk({ name: "mr", account: "work", source: "manual", recent: 20 });
    const r1 = mk({ name: "r1", account: "work", recent: 10 });
    const [g] = groupProjectsByAccount([r1, mr], new Set(), ACCOUNTS);
    expect(g.surfaced.map((p) => p.name)).toEqual(["mr", "r1"]); // recent 20 > 10，manual 也照 recent 排
  });

  it("surfaced 內 recent 相同 → 依 name 升冪 tie-break", () => {
    const tb = mk({ name: "t-b", account: "work", recent: 50 });
    const ta = mk({ name: "t-a", account: "work", recent: 50 });
    const [g] = groupProjectsByAccount([tb, ta], new Set(), ACCOUNTS);
    expect(g.surfaced.map((p) => p.name)).toEqual(["t-a", "t-b"]);
  });

  it("recent 超過 RECENT_BAND_LIMIT：前 3 留 surfaced、其餘併入 discovered（recent 在前）", () => {
    const projects = [
      mk({ name: "r1", account: "work", recent: 50 }),
      mk({ name: "r2", account: "work", recent: 40 }),
      mk({ name: "r3", account: "work", recent: 30 }),
      mk({ name: "r4", account: "work", recent: 20 }),
      mk({ name: "r5", account: "work", recent: 10 }),
      mk({ name: "d1", account: "work" }), // 未接觸
    ];
    const [g] = groupProjectsByAccount(projects, new Set(), ACCOUNTS);
    expect(g.surfaced.length).toBe(RECENT_BAND_LIMIT); // 直顯上限
    expect(g.surfaced.map((p) => p.name)).toEqual(["r1", "r2", "r3"]);
    // 溢出 r4/r5 併入自動發現，recent 降冪在前、未接觸 d1 殿後
    expect(g.discovered.map((p) => p.name)).toEqual(["r4", "r5", "d1"]);
  });

  it("manual 不佔 RECENT_BAND_LIMIT 名額、永遠在 surfaced；溢出 recent 落 discovered", () => {
    const projects = [
      mk({ name: "r1", account: "work", recent: 50 }),
      mk({ name: "r2", account: "work", recent: 40 }),
      mk({ name: "r3", account: "work", recent: 30 }),
      mk({ name: "r4", account: "work", recent: 20 }),
      mk({ name: "mn", account: "work", source: "manual" }),
    ];
    const [g] = groupProjectsByAccount(projects, new Set(), ACCOUNTS);
    expect(g.surfaced.map((p) => p.name)).toEqual(["r1", "r2", "r3", "mn"]);
    expect(g.discovered.map((p) => p.name)).toEqual(["r4"]);
  });
});

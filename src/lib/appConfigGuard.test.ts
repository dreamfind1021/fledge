import { describe, it, expect } from "vitest";
import { isUsableConfig } from "./appConfigGuard";

// 一份合法的最小 config：每個必要欄位都在、選用欄位不給（模擬舊快取）
const base = () => ({
  version: 1,
  roots: [{ path: "/p", default_account: "default" }],
  accounts: { default: { config_dir: "~/.claude", label: "預設" } },
  manual_projects: [{ path: "/m", account: "default" }],
  project_overrides: { "/o": { account: "default" } },
  ui: { theme: "nightfall" },
});

describe("isUsableConfig", () => {
  it("完整合法 config 通過", () => {
    expect(isUsableConfig(base())).toBe(true);
  });

  it("非物件一律不通過", () => {
    expect(isUsableConfig(null)).toBe(false);
    expect(isUsableConfig(undefined)).toBe(false);
    expect(isUsableConfig("x")).toBe(false);
    expect(isUsableConfig([])).toBe(false);
  });

  // accounts：Sidebar:96 Object.keys、AccountsEditor:34 讀 a.config_dir、Settings:73
  it("accounts 為 null 或陣列不通過", () => {
    expect(isUsableConfig({ ...base(), accounts: null })).toBe(false);
    expect(isUsableConfig({ ...base(), accounts: [] })).toBe(false);
  });

  it("accounts 的值為 null 不通過（R2 舉的 {accounts:{work:null}}）", () => {
    expect(isUsableConfig({ ...base(), accounts: { work: null } })).toBe(false);
  });

  // Codex PR-gate：既有契約允許欄位缺席（sidebarGroups 的 `meta?.label || key` 就是為此而設，
  // 後端 load() 也原樣收下不補欄位）。把缺席升格成致命會讓歷史 config 的使用者永久卡在啟動畫面。
  it("accounts 的值缺 label 仍通過（既有契約允許，UI 有 key fallback）", () => {
    expect(isUsableConfig({ ...base(), accounts: { w: { config_dir: "~/.c" } } })).toBe(true);
  });

  it("accounts 的值缺 config_dir 仍通過（不會 throw，只是顯示空值）", () => {
    expect(isUsableConfig({ ...base(), accounts: { w: { label: "只有 label" } } })).toBe(true);
  });

  it("accounts 的值欄位型別錯不通過", () => {
    expect(isUsableConfig({ ...base(), accounts: { w: { config_dir: 1, label: "型別錯" } } })).toBe(false);
    expect(isUsableConfig({ ...base(), accounts: { w: { config_dir: "~/.c", label: 9 } } })).toBe(false);
  });

  // roots：AccountsEditor:48 .filter、Settings:112 r.default_account
  it("roots 缺失或非陣列不通過", () => {
    const { roots: _drop, ...withoutRoots } = base();
    expect(isUsableConfig(withoutRoots)).toBe(false);
    expect(isUsableConfig({ ...base(), roots: {} })).toBe(false);
  });

  it("roots 元素為 null 不通過，缺欄位或型別錯依規則", () => {
    expect(isUsableConfig({ ...base(), roots: [null] })).toBe(false);      // 存取欄位會 throw
    expect(isUsableConfig({ ...base(), roots: [{ path: "/p" }] })).toBe(true);   // 缺席合法
    expect(isUsableConfig({ ...base(), roots: [{ path: 1 }] })).toBe(false);     // 型別錯
  });

  // manual_projects：AccountsEditor:49 .filter
  it("manual_projects 為 null 不通過（.filter 會 throw）", () => {
    expect(isUsableConfig({ ...base(), manual_projects: null })).toBe(false);
    expect(isUsableConfig({ ...base(), manual_projects: [{ path: "/m" }] })).toBe(true);
    expect(isUsableConfig({ ...base(), manual_projects: [{ account: 3 }] })).toBe(false);
  });

  // project_overrides：AccountsEditor:50 Object.values
  it("project_overrides 非 record 不通過，值型別錯不通過", () => {
    expect(isUsableConfig({ ...base(), project_overrides: [] })).toBe(false);
    expect(isUsableConfig({ ...base(), project_overrides: { "/o": {} } })).toBe(true);
    expect(isUsableConfig({ ...base(), project_overrides: { "/o": null } })).toBe(false);
    expect(isUsableConfig({ ...base(), project_overrides: { "/o": { account: 1 } } })).toBe(false);
  });

  // subscriptions／kms_root 是選用欄位：未提供合法（舊快取），提供則型別必須對
  it("subscriptions 未提供通過、提供但型別錯不通過", () => {
    expect(isUsableConfig(base())).toBe(true);
    expect(isUsableConfig({ ...base(), subscriptions: [] })).toBe(true);
    expect(isUsableConfig({ ...base(), subscriptions: [{ name: "Max", monthly_cost: 100 }] })).toBe(true);
    expect(isUsableConfig({ ...base(), subscriptions: {} })).toBe(false);
    expect(isUsableConfig({ ...base(), subscriptions: [{ name: "Max", monthly_cost: "100" }] })).toBe(false);
    // 同 label 那條：欄位缺席是既有契約允許的，不得升格成致命
    expect(isUsableConfig({ ...base(), subscriptions: [{ name: "Max" }] })).toBe(true);
    expect(isUsableConfig({ ...base(), subscriptions: [null] })).toBe(false); // 元素 null 會 throw
  });

  it("kms_root 未提供通過、提供但非字串不通過", () => {
    expect(isUsableConfig({ ...base(), kms_root: "/kms" })).toBe(true);
    expect(isUsableConfig({ ...base(), kms_root: 1 })).toBe(false);
  });
});

// 這個 guard 曾經兩度走偏：先是太鬆（只驗頂層兩個欄位，Codex R2），再是太嚴（要求具名欄位
// 必須存在，鎖死既有使用者，Codex PR-gate）。以下兩張表把界線釘死——它們是「這個 guard
// 存在的理由」與「它不准做的事」，任一邊被改動都應該讓這裡紅。
describe("guard 的界線（雙向防護）", () => {
  const base = () => ({
    version: 1,
    roots: [],
    accounts: { default: { config_dir: "~/.claude", label: "預設" } },
    manual_projects: [],
    project_overrides: {},
    ui: { theme: "nightfall" },
  });

  // 必須擋下：這些會讓既有元件在 Splash 淡出後才 throw
  it.each([
    ["accounts 非物件", { accounts: null }],
    ["accounts 是陣列（Object.keys 語意錯）", { accounts: [] }],
    ["account 值為 null（AccountsEditor 讀 a.config_dir 會 throw）", { accounts: { w: null } }],
    ["roots 為 null（.filter 會 throw）", { roots: null }],
    ["roots 元素為 null", { roots: [null] }],
    ["manual_projects 為 null（.filter 會 throw）", { manual_projects: null }],
    ["project_overrides 為陣列（Object.values 語意錯）", { project_overrides: [] }],
    ["project_overrides 值為 null", { project_overrides: { "/o": null } }],
    ["subscriptions 元素為 null（.map 讀 s.name 會 throw）", { subscriptions: [null] }],
  ])("必須擋下：%s", (_label, patch) => {
    expect(isUsableConfig({ ...base(), ...patch })).toBe(false);
  });

  // 必須放行：這些是既有契約允許的形狀，擋下等於鎖死使用者（重試讀回同一份檔案，救不了）
  it.each([
    ["account 缺 label（sidebarGroups 以 key fallback）", { accounts: { w: { config_dir: "~/.c" } } }],
    ["account 缺 config_dir（顯示空值，不 throw）", { accounts: { w: { label: "x" } } }],
    ["account 為空物件", { accounts: { w: {} } }],
    ["root 缺欄位", { roots: [{}] }],
    ["manual_project 缺欄位", { manual_projects: [{}] }],
    ["override 缺 account", { project_overrides: { "/o": {} } }],
    ["subscription 缺 monthly_cost", { subscriptions: [{ name: "Max" }] }],
    ["選用欄位整個未提供", {}],
  ])("必須放行：%s", (_label, patch) => {
    expect(isUsableConfig({ ...base(), ...patch })).toBe(true);
  });
});

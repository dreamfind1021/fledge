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

  it("accounts 的值缺 config_dir 或 label 不通過", () => {
    expect(isUsableConfig({ ...base(), accounts: { w: { label: "只有 label" } } })).toBe(false);
    expect(isUsableConfig({ ...base(), accounts: { w: { config_dir: "~/.c" } } })).toBe(false);
    expect(isUsableConfig({ ...base(), accounts: { w: { config_dir: 1, label: "型別錯" } } })).toBe(false);
  });

  // roots：AccountsEditor:48 .filter、Settings:112 r.default_account
  it("roots 缺失或非陣列不通過", () => {
    const { roots: _drop, ...withoutRoots } = base();
    expect(isUsableConfig(withoutRoots)).toBe(false);
    expect(isUsableConfig({ ...base(), roots: {} })).toBe(false);
  });

  it("roots 元素缺 path 或 default_account 不通過", () => {
    expect(isUsableConfig({ ...base(), roots: [{ path: "/p" }] })).toBe(false);
    expect(isUsableConfig({ ...base(), roots: [{ default_account: "d" }] })).toBe(false);
    expect(isUsableConfig({ ...base(), roots: [null] })).toBe(false);
  });

  // manual_projects：AccountsEditor:49 .filter
  it("manual_projects 為 null 或元素畸形不通過", () => {
    expect(isUsableConfig({ ...base(), manual_projects: null })).toBe(false);
    expect(isUsableConfig({ ...base(), manual_projects: [{ path: "/m" }] })).toBe(false);
  });

  // project_overrides：AccountsEditor:50 Object.values
  it("project_overrides 非 record 或值缺 account 不通過", () => {
    expect(isUsableConfig({ ...base(), project_overrides: [] })).toBe(false);
    expect(isUsableConfig({ ...base(), project_overrides: { "/o": {} } })).toBe(false);
  });

  // subscriptions／kms_root 是選用欄位：未提供合法（舊快取），提供則型別必須對
  it("subscriptions 未提供通過、提供但型別錯不通過", () => {
    expect(isUsableConfig(base())).toBe(true);
    expect(isUsableConfig({ ...base(), subscriptions: [] })).toBe(true);
    expect(isUsableConfig({ ...base(), subscriptions: [{ name: "Max", monthly_cost: 100 }] })).toBe(true);
    expect(isUsableConfig({ ...base(), subscriptions: {} })).toBe(false);
    expect(isUsableConfig({ ...base(), subscriptions: [{ name: "Max", monthly_cost: "100" }] })).toBe(false);
  });

  it("kms_root 未提供通過、提供但非字串不通過", () => {
    expect(isUsableConfig({ ...base(), kms_root: "/kms" })).toBe(true);
    expect(isUsableConfig({ ...base(), kms_root: 1 })).toBe(false);
  });
});

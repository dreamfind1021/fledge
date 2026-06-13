import { describe, it, expect, vi } from "vitest";
// sidecar.ts 頂部 import @tauri-apps/api/core 的 invoke；node 環境下 mock 掉以免載入失敗
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { fetchMemoryOverview } from "./sidecar";

describe("fetchMemoryOverview", () => {
  it("parses overview shape", async () => {
    const j = { global: [], projects: [], kb: [], scan_meta: { total: 0, unknown_count: 0 } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => j }));
    const r = await fetchMemoryOverview(1234, "");
    expect(r.projects).toEqual([]);
    expect(r.scan_meta.total).toBe(0);
  });
  it("throws on bad shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(fetchMemoryOverview(1234, "")).rejects.toThrow();
  });
});

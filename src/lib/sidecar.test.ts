import { afterEach, describe, expect, it, vi } from "vitest";
// sidecar.ts 頂部 import @tauri-apps/api/core 的 invoke；node 環境下 mock 掉以免載入失敗
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { scanPreview, checkDir, addRoot, authHeaders, wsUrl, setAuthToken } from "./sidecar";

afterEach(() => vi.unstubAllGlobals());

function mockFetch(json: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => json }) as unknown as Response));
}

describe("scanPreview", () => {
  it("回傳 path/count/status", async () => {
    mockFetch({ path: "/real/x", count: 3, status: "ok" });
    const res = await scanPreview(1234, "/x");
    expect(res).toEqual({ path: "/real/x", count: 3, status: "ok" });
  });
});

describe("checkDir", () => {
  it("回傳後端 status", async () => {
    mockFetch({ status: "denied" });
    expect(await checkDir(1234, "~/.claude")).toBe("denied");
  });
});

describe("configWrite detail", () => {
  it("400 帶 detail 時 throw 出 detail 訊息", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ detail: "找不到此資料夾" }) }) as unknown as Response));
    await expect(addRoot(1234, "/x", "work")).rejects.toThrow("找不到此資料夾");
  });
});

describe("auth token", () => {
  it("authHeaders 有 token 帶 header、無 token 不帶", () => {
    setAuthToken("tok123");
    expect(authHeaders()).toEqual({ "X-Fledge-Token": "tok123" });
    setAuthToken(null);
    expect(authHeaders()).toEqual({});
  });

  it("wsUrl 有 token 附 query、無 token 不附", () => {
    setAuthToken("t ok");
    expect(wsUrl(1234, "sid")).toBe("ws://127.0.0.1:1234/ws/sid?token=t%20ok");
    setAuthToken(null);
    expect(wsUrl(1234, "sid")).toBe("ws://127.0.0.1:1234/ws/sid");
  });

  // 抓「漏把某個 fetch helper 加上 authHeaders」——任一 helper 沒帶 X-Fledge-Token 就讓此測試紅。
  it("所有 HTTP helper 的 fetch 都帶 X-Fledge-Token", async () => {
    setAuthToken("tok");
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return { ok: true, json: async () => ({ projects: [], permission_error: false, status: "ok", path: "", count: 0, version: "", ok: true, claude_found: false, session_id: "s" }) } as unknown as Response;
    }));
    const m = await import("./sidecar");
    await m.fetchHealth(1);
    await m.rawHealth(1);
    await m.fetchProjects(1);
    await m.scanPreview(1, "/x");
    await m.createSession(1, "/x", "work");
    await m.closeSession(1, "sid");
    await m.resizeSession(1, "sid", 1, 1);
    await m.fetchConfig(1);
    await m.addRoot(1, "/x", "work");
    await m.onboard(1, []);
    await m.checkDir(1, "/x");
    expect(seen.length).toBeGreaterThanOrEqual(11);
    for (const h of seen) expect(h["X-Fledge-Token"]).toBe("tok");
    setAuthToken(null);
  });
});

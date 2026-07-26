import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// sidecar.ts 頂部 import @tauri-apps/api/core 的 invoke；node 環境下 mock 掉以免載入失敗
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  scanPreview,
  checkDir,
  addRoot,
  authHeaders,
  wsUrl,
  setAuthToken,
  fetchUsageDashboard,
  fetchDirTree,
} from "./sidecar";

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
      return { ok: true, json: async () => ({ projects: [], permission_error: false, status: "ok", path: "", count: 0, version: "", ok: true, claude_found: false, session_id: "s", kpi: {} }) } as unknown as Response;
    }));
    const m = await import("./sidecar");
    await m.fetchHealth(1);
    await m.rawHealth(1);
    await m.fetchProjects(1);
    await m.scanPreview(1, "/x");
    await m.createSession(1, { path: "/x", account: "work" });
    await m.closeSession(1, "sid");
    await m.resizeSession(1, "sid", 1, 1);
    await m.fetchConfig(1);
    await m.addRoot(1, "/x", "work");
    await m.onboard(1, []);
    await m.checkDir(1, "/x");
    await m.fetchUsageDashboard(1);
    await m.fetchCodexUsage(1);
    await m.fetchMemoryOverview(1, "");
    await m.fetchMemoryRelated(1, "/p");
    await m.fetchMemoryItem(1, "/p/x.md");
    await m.confirmSuggestion(1, "/p", "topic");
    await m.dismissSuggestion(1, "/p", "topic");
    await m.addMemoryLink(1, "/a", "/b");
    await m.removeMemoryLink(1, "/a", "/b");
    await m.fetchDirTree(1, "/p");
    expect(seen.length).toBeGreaterThanOrEqual(20);
    for (const h of seen) expect(h["X-Fledge-Token"]).toBe("tok");
    setAuthToken(null);
  });
});

describe("createSession kind", () => {
  const stubFetch = (bodies: Array<Record<string, unknown>>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(init!.body as string));
        return { ok: true, json: async () => ({ session_id: "s" }) } as unknown as Response;
      }),
    );

  it("request body 帶 kind：預設 claude、可指定 terminal", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(bodies);
    const m = await import("./sidecar");
    await m.createSession(1234, { path: "/x", account: "work" });
    await m.createSession(1234, { path: "/x", account: "work", kind: "terminal" });
    expect(bodies[0]).toEqual({ path: "/x", account: "work", kind: "claude" });
    expect(bodies[1]).toEqual({ path: "/x", account: "work", kind: "terminal" });
  });

  // 安全不變式（spec §5）：安裝命令只能由後端以 install_id 查 TOOL_SPECS 取得。
  // 前端送出的 body 不得含任何命令字串，也不該帶 account（安裝不歸屬、不注入帳號 env）。
  it("kind=install 只送 install_id，不帶 command 也不帶 account", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(bodies);
    const m = await import("./sidecar");
    await m.createSession(1234, { path: "", kind: "install", installId: "homebrew" });
    expect(bodies[0]).toEqual({ path: "", kind: "install", install_id: "homebrew" });
  });

  it("kind=login 送 login_target", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(bodies);
    const m = await import("./sidecar");
    await m.createSession(1234, { path: "/x", account: "work", kind: "login", loginTarget: "codex" });
    expect(bodies[0]).toEqual({ path: "/x", account: "work", kind: "login", login_target: "codex" });
  });

  // 後端判別碼要能被前端映射成 i18n 字串（spec-b4 §5：不得把判別碼直接顯示給使用者）
  it("400 帶判別碼：throw SessionError 並保留 code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: "unknown_install_id" }),
    }) as unknown as Response));
    const m = await import("./sidecar");
    await expect(m.createSession(1234, { path: "", kind: "install", installId: "nope" }))
      .rejects.toMatchObject({ code: "unknown_install_id" });
  });

  it("非 JSON 錯誤回應：code 為 null、訊息帶狀態碼", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 500, json: async () => { throw new Error("not json"); },
    }) as unknown as Response));
    const m = await import("./sidecar");
    await expect(m.createSession(1234, { path: "/x", account: "work" }))
      .rejects.toMatchObject({ code: null, message: expect.stringContaining("500") });
  });
});

describe("fetchUsageDashboard", () => {
  it("202 回 null、200 回 payload、500 throw、error-only 200 throw、帶 X-Fledge-Token 與 days", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    setAuthToken("tok");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      if (url.includes("days=7")) return new Response(null, { status: 202 });
      if (url.includes("days=9")) return new Response(null, { status: 500 });
      if (url.includes("days=11"))
        return new Response(
          JSON.stringify({ scan_meta: { state: "error", error: "cold boom", missing_pricing: [] } }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ kpi: {} }), { status: 200 });
    }));
    expect(await fetchUsageDashboard(1234, 7)).toBeNull();
    await expect(fetchUsageDashboard(1234, 9)).rejects.toThrow("HTTP 500");
    await expect(fetchUsageDashboard(1234, 11)).rejects.toThrow("cold boom");
    expect((await fetchUsageDashboard(1234))?.kpi).toEqual({});
    expect(calls[0].url).toContain("/usage/dashboard?days=7");
    expect(calls[0].headers["X-Fledge-Token"]).toBe("tok");
    vi.unstubAllGlobals();
    setAuthToken(null);
  });
});

describe("fetchDirTree", () => {
  beforeEach(() => setAuthToken("tok"));

  it("POST 帶 token、回 entries", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ path: "/p", entries: [{ name: "a", path: "/p/a", is_dir: false }], status: "ok" }), { status: 200 }),
    );
    const res = await fetchDirTree(1234, "/p");
    expect(res.status).toBe("ok");
    expect(res.entries[0].name).toBe("a");
    const [, init] = spy.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect((init!.headers as Record<string, string>)["X-Fledge-Token"]).toBe("tok");
    spy.mockRestore();
  });

  it("HTTP !ok（403 forbidden）→ throw", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: { status: "forbidden" } }), { status: 403 }),
    );
    await expect(fetchDirTree(1234, "/etc")).rejects.toThrow();
    spy.mockRestore();
  });

  it("HTTP 200 帶 status=missing → 不 throw、回 status", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ path: "/p/x", entries: [], status: "missing" }), { status: 200 }),
    );
    const res = await fetchDirTree(1234, "/p/x");
    expect(res.status).toBe("missing");
    spy.mockRestore();
  });
});

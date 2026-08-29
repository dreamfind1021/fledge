import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// sidecar.ts 頂部 import @tauri-apps/api/core 的 invoke；node 環境下 mock 掉以免載入失敗
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import {
  scanPreview,
  checkDir,
  addRoot,
  authHeaders,
  wsUrl,
  setAuthToken,
  fetchUsageDashboard,
  fetchDirTree,
  waitForSidecarPort,
  fetchConfig,
  fetchTasksOverview,
  fetchTasks,
  createTask,
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
      // config 四個必要欄位是為了通過 fetchConfig 的 shape guard（design §4.1.3）——
      // 本測試驗的是 token header，不是 config 內容，給合法空殼即可。
      return { ok: true, json: async () => ({ projects: [], permission_error: false, status: "ok", path: "", count: 0, version: "", ok: true, claude_found: false, session_id: "s", kpi: {}, results: [], accounts: {}, roots: [], manual_projects: [], project_overrides: {} }) } as unknown as Response;
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
    await m.commonConfigPlan(1, { source: "work", targets: ["personal"], entries: ["commands"] });
    await m.commonConfigApply(1, { source: "work", targets: ["personal"], entries: ["commands"], overwrite: [] });
    await m.fetchTemplates(1);
    await m.templatesPlan(1, "project-starter", "/p");
    await m.templatesDeploy(1, "project-starter", "/p");
    expect(seen.length).toBeGreaterThanOrEqual(25);
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

describe("common config plan/apply", () => {
  const stubFetch = (calls: Array<{ url: string; body: Record<string, unknown> }>, json: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(init!.body as string) });
        return { ok: true, json: async () => json } as unknown as Response;
      }),
    );

  it("plan 送 source/targets/entries，回 source_dir 與 operations", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const operations = [{
      account: "personal", entry: "commands", target_path: "/t/commands",
      state: "missing", action: "create_link", needs_overwrite: false,
    }];
    stubFetch(calls, { source_dir: "/s", operations });
    const m = await import("./sidecar");

    const plan = await m.commonConfigPlan(1234, {
      source: "work", targets: ["personal"], entries: m.COMMON_CONFIG_ENTRIES,
    });

    expect(calls[0].url).toContain("/api/setup/common-config/plan");
    expect(calls[0].body).toEqual({
      source: "work", targets: ["personal"], entries: [...m.COMMON_CONFIG_ENTRIES],
    });
    expect(plan).toEqual({ source_dir: "/s", operations });
  });

  // 後端 body 的 entries 必須是可序列化的陣列——readonly tuple 直接塞進 JSON.stringify 沒問題，
  // 但 overwrite 這個欄位不能省略：省略等於「用後端預設」，而預設剛好也是空陣列，
  // 之後後端一改預設就會靜默變成破壞性操作
  it("apply 送 overwrite 清單，回 results", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const results = [{ account: "personal", entry: "commands", outcome: "created", backup_path: null, error: null }];
    stubFetch(calls, { results });
    const m = await import("./sidecar");

    const applied = await m.commonConfigApply(1234, {
      source: "work", targets: ["personal"], entries: ["commands"], overwrite: [],
    });

    expect(calls[0].url).toContain("/api/setup/common-config/apply");
    expect(calls[0].body).toEqual({
      source: "work", targets: ["personal"], entries: ["commands"], overwrite: [],
    });
    expect(applied).toEqual(results);
  });

  it("400/500 帶判別碼：throw SetupError 並保留 code，message 不含判別碼", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ error: "probe_failed" }),
    }) as unknown as Response));
    const m = await import("./sidecar");

    await expect(m.commonConfigPlan(1234, { source: "work", targets: ["personal"], entries: ["commands"] }))
      .rejects.toMatchObject({ code: "probe_failed", status: 500 });
    // 判別碼進 message 就會繞過 i18n 映射出現在畫面上（spec-b4 §5，比照 SessionError）
    await expect(m.commonConfigPlan(1234, { source: "work", targets: ["personal"], entries: ["commands"] }))
      .rejects.toThrow(/^(?!.*probe_failed).*$/);
  });

  it("非 JSON 錯誤回應（422 detail 陣列、裸 5xx）：code 為 null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 422, json: async () => { throw new Error("not json"); },
    }) as unknown as Response));
    const m = await import("./sidecar");

    await expect(m.commonConfigApply(1234, {
      source: "work", targets: ["personal"], entries: ["commands"], overwrite: [],
    })).rejects.toMatchObject({ code: null, status: 422 });
  });
});

describe("templates list/plan/deploy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("list 回 allowlist 全部範本（含 available 旗標）", async () => {
    const templates = [
      { id: "project-starter", label: "Project starter", description: "…", source_class: "public", available: true },
      { id: "kms-seed", label: "Knowledge base seed", description: "…", source_class: "private", available: false },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ templates }) }) as unknown as Response));
    const m = await import("./sidecar");

    expect(await m.fetchTemplates(1234)).toEqual(templates);
  });

  it("plan／deploy 送 template 與 destination，回 state／逐檔結果", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return {
        ok: true,
        json: async () => ({
          template: "project-starter", destination: "/p", state: "not_installed",
          operations: [{ path: "CLAUDE.md", type: "file", state: "missing" }],
          results: [{ path: "CLAUDE.md", outcome: "created", error: null }],
        }),
      } as unknown as Response;
    }));
    const m = await import("./sidecar");

    const plan = await m.templatesPlan(1234, "project-starter", "/p");
    const deployed = await m.templatesDeploy(1234, "project-starter", "/p");

    expect(calls[0].url).toContain("/api/setup/templates/plan");
    expect(calls[1].url).toContain("/api/setup/templates/deploy");
    for (const c of calls) expect(c.body).toEqual({ template: "project-starter", destination: "/p" });
    expect(plan.state).toBe("not_installed");
    expect(plan.operations).toEqual([{ path: "CLAUDE.md", type: "file", state: "missing" }]);
    expect(deployed.results).toEqual([{ path: "CLAUDE.md", outcome: "created", error: null }]);
  });

  it("400 帶判別碼：throw SetupError 並保留 code，message 不含判別碼", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: "unsafe_destination" }),
    }) as unknown as Response));
    const m = await import("./sidecar");

    await expect(m.templatesDeploy(1234, "project-starter", "/"))
      .rejects.toMatchObject({ code: "unsafe_destination", status: 400 });
    await expect(m.templatesPlan(1234, "project-starter", "/"))
      .rejects.toThrow(/^(?!.*unsafe_destination).*$/);
  });

  // list 是 GET、沒有判別碼合約（比照 fetchSetupStatus）：!ok 就 throw，讓卡片顯示載入失敗
  it("list 的 HTTP 失敗直接 throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    const m = await import("./sidecar");

    await expect(m.fetchTemplates(1234)).rejects.toThrow(/500/);
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

describe("waitForSidecarPort", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("拿到 port 就回傳", async () => {
    vi.mocked(invoke).mockImplementation(((cmd: string) =>
      Promise.resolve(cmd === "sidecar_port" ? 4321 : null)) as typeof invoke);
    await expect(waitForSidecarPort(1000)).resolves.toBe(4321);
  });

  // design §4.6：spawn 失敗時 Rust 端存了原因，前端不該空等到逾時才報通用訊息
  it("spawn 失敗時立即 throw 該原文，不等到逾時", async () => {
    vi.mocked(invoke).mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === "sidecar_spawn_error"
          ? "spawn /path/to/fledge-sidecar failed: No such file or directory"
          : null,
      )) as typeof invoke);
    const started = Date.now();
    await expect(waitForSidecarPort(5000)).rejects.toThrow(/No such file or directory/);
    expect(Date.now() - started).toBeLessThan(2000); // 遠早於 maxWait
  });

  it("port 與 spawn error 都沒有時，等到逾時才 throw", async () => {
    vi.mocked(invoke).mockImplementation((() => Promise.resolve(null)) as typeof invoke);
    await expect(waitForSidecarPort(400)).rejects.toThrow(/did not start/i);
  });
});

describe("fetchConfig shape guard", () => {
  const good = {
    version: 1,
    roots: [],
    accounts: { default: { config_dir: "~/.claude", label: "預設" } },
    manual_projects: [],
    project_overrides: {},
    ui: { theme: "nightfall" },
  };

  it("合法 config 正常回傳", async () => {
    mockFetch(good);
    await expect(fetchConfig(1234)).resolves.toMatchObject({ version: 1 });
  });

  // design §4.1.3：畸形 config 必須在這一層擋下，否則 UI 會在 Splash 淡出後才崩潰
  it("accounts 的值為 null 時 throw，不讓它流進 store", async () => {
    mockFetch({ ...good, accounts: { work: null } });
    await expect(fetchConfig(1234)).rejects.toThrow(/config/i);
  });

  it("manual_projects 為 null 時 throw", async () => {
    mockFetch({ ...good, manual_projects: null });
    await expect(fetchConfig(1234)).rejects.toThrow(/config/i);
  });

  // Codex PR-gate：既有契約允許 accounts[*] 缺 label（sidebarGroups 以 key fallback、後端
  // load() 原樣收下不補欄位）。若 guard 把缺席當致命，這種歷史 config 的使用者會永久卡在
  // 啟動畫面——重試讀回的是同一份檔案，救不了。
  it("缺 label 的歷史 config 仍正常載入（不得因驗證變嚴而鎖死使用者）", async () => {
    mockFetch({ ...good, accounts: { work: { config_dir: "~/.claude" } } });
    await expect(fetchConfig(1234)).resolves.toMatchObject({ version: 1 });
  });
});

// --- 還原：路徑模式與備份包摘要（票 02／票 11 的前端接線）---

describe("restore 路徑模式與 bundle-info", () => {
  const captureBody = (json: unknown) => {
    const seen: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return { ok: true, json: async () => json } as unknown as Response;
    }));
    return seen;
  };

  // 移機選到的包不在 backup_dir 裡，名字模式一律 unknown_bundle（增補 spec §2.7）。
  // 二擇一：送路徑就不能送名字，否則後端 400（歧義不讓後蓋前）。
  // 二擇一由**兩支函式**表達而不是一個 options 物件：後者允許呼叫端同時給兩個欄位
  // （後端 400），前者在編譯期就不可能。既有的還原卡因此一個字都不用改。
  it("restorePlanForPath 只送 bundle_path", async () => {
    const seen = captureBody({ bundle: "/tmp/b.tar.gz", dest: "/tmp/x", dest_status: "ok" });
    const m = await import("./sidecar");
    await m.restorePlanForPath(1234, "/tmp/b.tar.gz");
    expect(seen[0].body).toEqual({ bundle_path: "/tmp/b.tar.gz" });
  });

  it("restorePlan 只送 bundle（還原卡的既有路徑不變）", async () => {
    const seen = captureBody({ bundle: "b.tar.gz", dest: "/tmp/x", dest_status: "ok" });
    const m = await import("./sidecar");
    await m.restorePlan(1234, "b.tar.gz", "/tmp/x");
    expect(seen[0].body).toEqual({ bundle: "b.tar.gz", dest: "/tmp/x" });
  });

  it("createSession kind=restore 送 restore_bundle_path", async () => {
    const seen = captureBody({ session_id: "s" });
    const m = await import("./sidecar");
    await m.createSession(1234, {
      path: "", kind: "restore", restoreBundlePath: "/tmp/b.tar.gz", restoreDest: "/tmp/x",
    });
    expect(seen[0].body).toEqual({
      path: "", kind: "restore", restore_bundle_path: "/tmp/b.tar.gz", restore_dest: "/tmp/x",
    });
  });

  it("fetchBundleInfo 以 dest 查詢並回摘要", async () => {
    const info = { host: "old-mac", created: "20260731-1200", accounts: ["work"], extra: [], project_count: 9 };
    const seen = captureBody(info);
    const m = await import("./sidecar");
    expect(await m.fetchBundleInfo(1234, "/tmp/x")).toEqual(info);
    expect(seen[0].url).toContain(`dest=${encodeURIComponent("/tmp/x")}`);
  });

  it("bundle-info 的 400 判別碼保留在 RestoreError 上供 i18n 映射", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: "source_not_a_bundle" }),
    }) as unknown as Response));
    const m = await import("./sidecar");
    await expect(m.fetchBundleInfo(1234, "/tmp/x"))
      .rejects.toMatchObject({ code: "source_not_a_bundle" });
  });
});

describe("落點建議值與 adopt-config（票 03）", () => {
  const captureBody = (json: unknown) => {
    const seen: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return { ok: true, json: async () => json } as unknown as Response;
    }));
    return seen;
  };

  it("fetchLandingSuggestions 以 dest 查詢並回 home + spots", async () => {
    const payload = {
      home: "/Users/olduser",
      spots: [{ key: "work", kind: "account", old_path: "/Users/olduser/.claude",
                suggested: "/Users/me/.claude", suggested_exists: false }],
    };
    const seen = captureBody(payload);
    const m = await import("./sidecar");
    expect(await m.fetchLandingSuggestions(1234, "/tmp/x")).toEqual(payload);
    expect(seen[0].url).toContain(`dest=${encodeURIComponent("/tmp/x")}`);
  });

  // 落點是**使用者的授權**：manifest 只產生建議值，送回去的才算數（spec §4.2.2）
  it("adoptConfig 送使用者確認的落點，帳號與 extra 分開兩個欄位", async () => {
    const seen = captureBody({ ok: true });
    const m = await import("./sidecar");
    await m.adoptConfig(1234, {
      request_id: "req-1", dest: "/tmp/x",
      accounts: [{ key: "work", config_dir: "/Users/me/.claude" }],
      extra: [{ name: ".agents", path: "/Users/me/.agents" }],
    });
    expect(seen[0].body).toEqual({
      // 票 15：同一次確認的識別碼一路送到後端——後端據此在重送時回既有結果而不是 409
      request_id: "req-1",
      dest: "/tmp/x",
      accounts: [{ key: "work", config_dir: "/Users/me/.claude" }],
      extra: [{ name: ".agents", path: "/Users/me/.agents" }],
      roots: [],
    });
  });

  it("adoptConfig 的判別碼保留在 RestoreError 上供 i18n 映射", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: "overlapping_config_dirs" }),
    }) as unknown as Response));
    const m = await import("./sidecar");
    await expect(m.adoptConfig(1234, { request_id: "req-1", dest: "/tmp/x", accounts: [] }))
      .rejects.toMatchObject({ code: "overlapping_config_dirs" });
  });
});

describe("專案路徑對應（票 04）", () => {
  it("fetchProjectPaths 以 dest 查詢並回專案清單", async () => {
    const projects = [{ account: "work", old_path: "/Users/olduser/work/app",
                        encoded_dir: "-Users-olduser-work-app",
                        suggested: "/Users/me/work/app", suggested_exists: false }];
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(url);
      return { ok: true, json: async () => ({ projects }) } as unknown as Response;
    }));
    const m = await import("./sidecar");
    expect(await m.fetchProjectPaths(1234, "/tmp/x")).toEqual(projects);
    expect(seen[0]).toContain(`dest=${encodeURIComponent("/tmp/x")}`);
  });

  it("判別碼保留在 RestoreError 上供 i18n 映射", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: "source_not_a_bundle" }),
    }) as unknown as Response));
    const m = await import("./sidecar");
    await expect(m.fetchProjectPaths(1234, "/tmp/x"))
      .rejects.toMatchObject({ code: "source_not_a_bundle" });
  });
});

describe("fetchTasksOverview", () => {
  // plan §1.0：Tasks.tsx 一律經 wrapper。若它自己 fetch，接線測試仍會全綠，
  // 但正式 sidecar 會因缺 token 回 401——dev 看似正常、打包版整個死掉。
  it("打對 endpoint、用 GET、帶 auth header", async () => {
    setAuthToken("tok-tasks");
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ projects: [], permission_error: false }) }) as unknown as Response);
    vi.stubGlobal("fetch", spy);
    await fetchTasksOverview(4321);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4321/tasks/overview");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.headers).toEqual({ "X-Fledge-Token": "tok-tasks" });
    setAuthToken(null);
  });

  it("非 2xx 時 throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    await expect(fetchTasksOverview(4321)).rejects.toThrow();
  });
});

describe("fetchTasks", () => {
  it("打對 endpoint、帶 project query 與 auth header", async () => {
    setAuthToken("tok-list");
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ project: "/p", tasks_status: "ok", tasks: [], next_step: "" }) }) as unknown as Response);
    vi.stubGlobal("fetch", spy);
    await fetchTasks(4321, "/Users/tc/NAS/work/Meeting Agent");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4321/tasks?project=%2FUsers%2Ftc%2FNAS%2Fwork%2FMeeting%20Agent");
    expect(init.headers).toEqual({ "X-Fledge-Token": "tok-list" });
    setAuthToken(null);
  });

  it("非 2xx 時 throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response));
    await expect(fetchTasks(4321, "/x")).rejects.toThrow();
  });
});

describe("createTask", () => {
  it("POST 到 /tasks、帶 project/title payload 與 auth header", async () => {
    setAuthToken("tok-new");
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ name: "01-a.md" }) }) as unknown as Response);
    vi.stubGlobal("fetch", spy);
    await createTask(4321, "/p/a", "第一件事");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4321/tasks");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Fledge-Token": "tok-new" });
    expect(JSON.parse(init.body as string)).toEqual({ project: "/p/a", title: "第一件事" });
    setAuthToken(null);
  });

  it("非 2xx 時 throw（前端據此顯示建立失敗）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response));
    await expect(createTask(4321, "/p/a", "x")).rejects.toThrow();
  });
});

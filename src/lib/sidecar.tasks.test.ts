import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskConflictError, fetchTasksNote, updateTaskContent, updateTasksNote } from "./sidecar";

const stub = (status: number, json: () => Promise<unknown>) =>
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: status < 400, status, json }));
const call = () => updateTaskContent(1, "/p", "a.md", "t", "b", "f0");

describe("updateTaskContent 的成功定義（spec §7.3）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("200 且 name/fingerprint/body 都是字串 → 回 row", async () => {
    stub(200, () => Promise.resolve({ name: "a.md", fingerprint: "f", body: "b" }));
    expect((await call()).fingerprint).toBe("f");
  });
  it.each([
    ["缺 body", { name: "a.md", fingerprint: "f" }],
    ["缺 fingerprint", { name: "a.md", body: "b" }],
    ["body 不是字串", { name: "a.md", fingerprint: "f", body: 1 }],
  ])("200 但 %s → 拋 malformed", async (_, body) => {
    stub(200, () => Promise.resolve(body));
    await expect(call()).rejects.toThrow("malformed");
  });
  it("200 但 JSON 解析失敗（headers 送了 body 截斷）→ 拋", async () => {
    stub(200, () => Promise.reject(new SyntaxError("Unexpected end")));
    await expect(call()).rejects.toThrow();
  });
  it("409 → TaskConflictError", async () => {
    stub(409, () => Promise.resolve({ error: "stale" }));
    await expect(call()).rejects.toBeInstanceOf(TaskConflictError);
  });
  it("400 → 一般 Error", async () => {
    stub(400, () => Promise.resolve({ error: "not_editable" }));
    await expect(call()).rejects.toThrow("400");
  });
  // 離開編輯器時要靠這個 signal abort 在途請求，否則晚到的 200 會清掉已經屬於另一次編輯的草稿；
  // 元件層的測試 mock 掉 updateTaskContent，抓不到這裡漏傳。
  it("signal 有轉送進 fetch 的 options", async () => {
    stub(200, () => Promise.resolve({ name: "a.md", fingerprint: "f", body: "b" }));
    const controller = new AbortController();
    await updateTaskContent(1, "/p", "a.md", "t", "b", "f0", controller.signal);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});

describe("fetchTasksNote（票 19，spec §4.4）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("打 /tasks/note?project=，帶 auth header，回 JSON 原樣", async () => {
    const body = { status: "ok", content: "# p", mtime: "2026-09-16", path: "/p/.fledge/state.md", fingerprint: "n1", editable: true };
    stub(200, () => Promise.resolve(body));
    const r = await fetchTasksNote(1, "/p x");
    expect(r).toEqual(body);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:1/tasks/note?project=%2Fp%20x");
    expect(opts?.headers).toBeDefined();   // authHeaders()：漏了 dev 看似正常、打包版整個死掉
  });
  it("非 2xx → 拋", async () => {
    stub(400, () => Promise.resolve({ error: "unknown_project" }));
    await expect(fetchTasksNote(1, "/p")).rejects.toThrow("400");
  });
});

describe("updateTasksNote（票 19 增補，spec §10.2）", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = { status: "ok", content: "new", mtime: "2026-09-17", path: "/p/.fledge/state.md", fingerprint: "n2", editable: true };

  it("PUT /tasks/note，JSON body 帶 project／content／fingerprint，帶 auth header，回 JSON 原樣", async () => {
    stub(200, () => Promise.resolve(ok));
    const r = await updateTasksNote(1, "/p x", "new", "n1");
    expect(r).toEqual(ok);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:1/tasks/note");
    expect(opts?.method).toBe("PUT");
    expect(JSON.parse(String(opts?.body))).toEqual({ project: "/p x", content: "new", fingerprint: "n1" });
    expect((opts?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(opts?.headers).toBeDefined();   // authHeaders()：漏了 dev 看似正常、打包版整個死掉
  });
  it("409 → TaskConflictError", async () => {
    stub(409, () => Promise.resolve({ error: "stale" }));
    await expect(updateTasksNote(1, "/p", "new", "n1")).rejects.toBeInstanceOf(TaskConflictError);
  });
  it("其他非 2xx → 含 status 的一般 Error", async () => {
    stub(400, () => Promise.resolve({ error: "not_editable" }));
    await expect(updateTasksNote(1, "/p", "new", "n1")).rejects.toThrow("400");
  });
});

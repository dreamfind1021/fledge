import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskConflictError, updateTaskContent } from "./sidecar";

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
});

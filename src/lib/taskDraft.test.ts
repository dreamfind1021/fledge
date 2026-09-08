// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, listDrafts, loadDraft, saveDraft } from "./taskDraft";

describe("taskDraft", () => {
  beforeEach(() => localStorage.clear());

  it("存了讀得回來，含 fingerprint", () => {
    expect(saveDraft("/p", "01-a.md", { title: "t", body: "b", fingerprint: "f0" })).toBe(true);
    const d = loadDraft("/p", "01-a.md");
    expect(d?.title).toBe("t"); expect(d?.body).toBe("b"); expect(d?.fingerprint).toBe("f0");
    expect(typeof d?.savedAt).toBe("number");
  });
  it("沒存過回 null；清掉後回 null", () => {
    expect(loadDraft("/p", "x.md")).toBeNull();
    saveDraft("/p", "x.md", { title: "t", body: "", fingerprint: "f" });
    clearDraft("/p", "x.md");
    expect(loadDraft("/p", "x.md")).toBeNull();
  });
  it("不同專案同名票互不干擾", () => {
    saveDraft("/p1", "01-a.md", { title: "one", body: "", fingerprint: "f" });
    saveDraft("/p2", "01-a.md", { title: "two", body: "", fingerprint: "f" });
    expect(loadDraft("/p1", "01-a.md")?.title).toBe("one");
    expect(loadDraft("/p2", "01-a.md")?.title).toBe("two");
  });
  it("setItem 拋錯時回 false，不拋出去（spec §7.3 步驟 3）", () => {
    // 這個 repo 的 vitest.setup.ts 在偵測到 Node 的空殼 localStorage 時，換上的是一個
    // 原型鏈為 Object.prototype 的純物件（setItem 是自身屬性），不是 Storage 的實例，
    // 所以 spy 在 Storage.prototype 上攔不到它——要直接 spy 在 localStorage 這個物件本身。
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(saveDraft("/p", "01-a.md", { title: "t", body: "", fingerprint: "f" })).toBe(false);
    spy.mockRestore();
  });
  it("壞掉的 JSON 當沒有草稿", () => {
    localStorage.setItem("fledge.taskDraft./p/01-a.md", "{not json");
    expect(loadDraft("/p", "01-a.md")).toBeNull();
  });
  it("listDrafts 只列該專案的", () => {
    saveDraft("/p", "01-a.md", { title: "a", body: "", fingerprint: "f" });
    saveDraft("/p", "02-b.md", { title: "b", body: "", fingerprint: "f" });
    saveDraft("/q", "01-a.md", { title: "q", body: "", fingerprint: "f" });
    const names = listDrafts("/p").map((x) => x.name).sort();
    expect(names).toEqual(["01-a.md", "02-b.md"]);
  });
});

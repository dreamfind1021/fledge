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
  it("JSON 解析得出來但形狀不對，也當沒有草稿", () => {
    // 這條分支擋的是「JSON 解析得出來、但欄位型別不對」的舊版或損壞草稿；
    // 沒有它，undefined 會被還原進受控的 input，觸發警告並且把使用者的內容弄丟。
    const badShapes = [
      '{"title":1,"body":"b","fingerprint":"f"}', // 型別不符：title 不是字串
      '{"title":"t","body":"b"}', // 缺 fingerprint
      "[]", // 不是物件；JSON.parse 不拋錯，落到形狀檢查那個 if（實測過："null" 反而是 d.title 直接拋 TypeError、走另一條 catch，行為一樣回 null 但走的分支不同，所以這裡選會走到 if 分支的 "[]"）
    ];
    badShapes.forEach((raw, i) => {
      localStorage.setItem(`fledge.taskDraft./p/bad-${i}.md`, raw);
      expect(loadDraft("/p", `bad-${i}.md`)).toBeNull();
    });
  });
  it("listDrafts 只列該專案的", () => {
    saveDraft("/p", "01-a.md", { title: "a", body: "", fingerprint: "f" });
    saveDraft("/p", "02-b.md", { title: "b", body: "", fingerprint: "f" });
    saveDraft("/q", "01-a.md", { title: "q", body: "", fingerprint: "f" });
    const names = listDrafts("/p").map((x) => x.name).sort();
    expect(names).toEqual(["01-a.md", "02-b.md"]);
  });
});

import { describe, it, expect } from "vitest";
import { ImeDraftTracker } from "./imeDraftTracker";

describe("ImeDraftTracker", () => {
  it("懸置（組字中→end 空→blur 同窗）→ 顯示草稿", () => {
    const t = new ImeDraftTracker();
    t.compositionStart();
    t.compositionUpdate("測試");
    t.compositionEnd("", 1000);
    t.markBlur(1000);
    expect(t.suspendedDraft).toBe("測試");
  });
  it("正常 commit（end data 非空）→ 不顯示", () => {
    const t = new ImeDraftTracker();
    t.compositionStart();
    t.compositionUpdate("測試");
    t.compositionEnd("測試", 1000);
    t.markBlur(1000);
    expect(t.suspendedDraft).toBe(null);
  });
  it("Esc 取消（end 空但無 blur 確認）→ 不顯示", () => {
    const t = new ImeDraftTracker();
    t.compositionStart();
    t.compositionUpdate("測試");
    t.compositionEnd("", 1000);
    expect(t.suspendedDraft).toBe(null);
  });
  it("blur 超出相鄰窗 → 不顯示", () => {
    const t = new ImeDraftTracker();
    t.compositionStart();
    t.compositionUpdate("測試");
    t.compositionEnd("", 1000);
    t.markBlur(5000);
    expect(t.suspendedDraft).toBe(null);
  });
  it("compositionStart（IME 還原接手）→ 草稿退場", () => {
    const t = new ImeDraftTracker();
    t.compositionStart();
    t.compositionUpdate("測試");
    t.compositionEnd("", 1000);
    t.markBlur(1000);
    t.compositionStart();
    expect(t.suspendedDraft).toBe(null);
  });
  it("dismiss（Enter 重放／Esc）→ 草稿退場", () => {
    const t = new ImeDraftTracker();
    t.compositionStart();
    t.compositionUpdate("測試");
    t.compositionEnd("", 1000);
    t.markBlur(1000);
    t.dismiss();
    expect(t.suspendedDraft).toBe(null);
  });
  it("懸置→重組→正常 commit 不殘留", () => {
    const t = new ImeDraftTracker();
    t.compositionStart();
    t.compositionUpdate("測試");
    t.compositionEnd("", 1000);
    t.markBlur(1000);
    t.compositionStart();
    t.compositionUpdate("測試好");
    t.compositionEnd("測試好", 2000);
    expect(t.suspendedDraft).toBe(null);
  });
});

import { describe, it, expect } from "vitest";
import { ImeReplayGuard } from "./imeReplayGuard";

// 標準懸置序列：組字中送出第一份 → compositionend data 空 → 同毫秒 blur 確認（deactivate）
const suspended = () => {
  const g = new ImeReplayGuard();
  g.compositionStart();
  g.noteData("你好"); // xterm keydown-finalize 強制送出第一份
  g.compositionEnd("", 1000);
  g.markBlur(1000);
  return g;
};

describe("ImeReplayGuard", () => {
  it("懸置後相同 insertText 重放攔恰一次（one-shot）", () => {
    const g = suspended();
    expect(g.shouldBlock("insertText", "你好", true)).toBe(true);
    expect(g.shouldBlock("insertText", "你好", true)).toBe(false);
  });
  it("組字中 DSR／控制序列 onData 不覆寫 candidate（claude TUI 游標回報）", () => {
    const g = new ImeReplayGuard();
    g.compositionStart();
    g.noteData("你好");
    g.noteData("\u001b[?25;7R"); // DSR 落在第一份與 compositionend 之間（trace seq72→74）
    g.compositionEnd("", 1000);
    g.markBlur(1000);
    expect(g.shouldBlock("insertText", "你好", true)).toBe(true);
  });
  it("compositionend 空但無 blur 確認 → 不武裝（非切窗場景）", () => {
    const g = new ImeReplayGuard();
    g.compositionStart();
    g.noteData("你好");
    g.compositionEnd("", 1000);
    expect(g.shouldBlock("insertText", "你好", true)).toBe(false);
  });
  it("blur 與 compositionend 相距超過相鄰上限 → 不武裝", () => {
    const g = new ImeReplayGuard();
    g.compositionStart();
    g.noteData("你好");
    g.compositionEnd("", 1000);
    g.markBlur(5000);
    expect(g.shouldBlock("insertText", "你好", true)).toBe(false);
  });
  it("blur 恰於相鄰上限（1000ms）仍武裝", () => {
    const g = new ImeReplayGuard();
    g.compositionStart();
    g.noteData("你好");
    g.compositionEnd("", 1000);
    g.markBlur(2000); // delta 恰為 SUSPEND_BLUR_ASSOC_MS 上限值
    expect(g.shouldBlock("insertText", "你好", true)).toBe(true);
  });
  it("正常 commit（compositionend data 非空）不武裝", () => {
    const g = new ImeReplayGuard();
    g.compositionStart();
    g.noteData("你好");
    g.compositionEnd("你好", 1000);
    g.markBlur(1000);
    expect(g.shouldBlock("insertText", "你好", true)).toBe(false);
  });
  it("組字中無第一份（Esc 取消）不武裝", () => {
    const g = new ImeReplayGuard();
    g.compositionStart();
    g.compositionEnd("", 1000);
    g.markBlur(1000);
    expect(g.shouldBlock("insertText", "你好", true)).toBe(false);
  });
  it("新 compositionstart 解除武裝（重打同字串走組字路徑、不誤殺）", () => {
    const g = suspended();
    g.compositionStart(); // 使用者重打
    expect(g.shouldBlock("insertText", "你好", true)).toBe(false);
  });
  it("data 不同不攔、也不消耗武裝", () => {
    const g = suspended();
    expect(g.shouldBlock("insertText", "妳好", true)).toBe(false);
    expect(g.shouldBlock("insertText", "你好", true)).toBe(true); // 武裝仍在
  });
  it("非 insertText（如 insertFromPaste）不攔", () => {
    const g = suspended();
    expect(g.shouldBlock("insertFromPaste", "你好", true)).toBe(false);
  });
  it("非 trusted 不攔", () => {
    const g = suspended();
    expect(g.shouldBlock("insertText", "你好", false)).toBe(false);
  });
  it("onData 含 CR（整行已執行）解除武裝", () => {
    const g = suspended();
    g.noteData("\r");
    expect(g.shouldBlock("insertText", "你好", true)).toBe(false);
  });
});

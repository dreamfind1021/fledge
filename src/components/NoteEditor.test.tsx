// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import { TaskConflictError, type TasksNote } from "../lib/sidecar";
import { NoteEditor } from "./NoteEditor";

const updateTasksNote = vi.fn<(...a: unknown[]) => Promise<TasksNote>>();
vi.mock("../lib/sidecar", async (orig) => ({
  ...(await orig<typeof import("../lib/sidecar")>()),
  updateTasksNote: (...a: unknown[]) => updateTasksNote(...a),
}));
const writeClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("../lib/clipboard", () => ({ writeClipboard: (s: string) => writeClipboard(s) }));

const note = (over: Partial<TasksNote> = {}): TasksNote => ({
  status: "ok", content: "# p\n\n## 停在哪\n\n- x", mtime: "2026-09-14", path: "/p/.fledge/state.md",
  fingerprint: "n1", editable: true, ...over,
});
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, { ns: "tasks", ...o }) as string;
// leaveRequest 預設 0：與父層的計數起點一致；「掛載時非零不重播」那條自己傳
const setup = (leaveRequest = 0) => {
  const onSaved = vi.fn(); const onLeave = vi.fn();
  const view = (lr: number) => <NoteEditor port={1} project="/p" note={note()} onSaved={onSaved} onLeave={onLeave} leaveRequest={lr} t={t} />;
  const r = render(view(leaveRequest));
  return { onSaved, onLeave, rerender: (lr: number) => r.rerender(view(lr)) };
};
const box = () => screen.getByLabelText(en.note.editorBody) as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });

describe("NoteEditor（票 19 增補，spec §10.3）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); vi.clearAllMocks(); writeClipboard.mockReset().mockResolvedValue(true); });
  afterEach(cleanup);

  it("內文從 note.content 起；沒改過時儲存鍵停用", () => {
    setup();
    expect(box().value).toBe(note().content);
    expect((screen.getByText(en.list.save) as HTMLButtonElement).disabled).toBe(true);
  });

  it("不髒時 leaveRequest 變大 → 立刻 onLeave(false, true)，沒有橫幅", async () => {
    const { onLeave, rerender } = setup(0);
    rerender(1);
    await waitFor(() => expect(onLeave).toHaveBeenCalledWith(false, true));
    expect(screen.queryByText(en.note.unsaved)).toBeNull();
  });

  it("髒時 leaveRequest → 橫幅、不呼叫 onLeave；按仍要離開 → onLeave(false, true)", async () => {
    const { onLeave, rerender } = setup(0);
    type("typed");
    rerender(1);
    await screen.findByText(en.note.unsaved);
    expect(onLeave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(en.list.leaveAnyway));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledWith(false, true);
  });

  it("髒時 leaveRequest → 按留下 → 橫幅消失、字還在、不呼叫 onLeave", async () => {
    const { onLeave, rerender } = setup(0);
    type("typed");
    rerender(1);
    await screen.findByText(en.note.unsaved);
    fireEvent.click(screen.getByText(en.note.stay));
    expect(screen.queryByText(en.note.unsaved)).toBeNull();
    expect(box().value).toBe("typed");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("自己按取消且髒 → 橫幅；仍要離開 → onLeave(false, false)", async () => {
    const { onLeave } = setup();
    type("typed");
    fireEvent.click(screen.getByText(en.list.cancel));
    await screen.findByText(en.note.unsaved);
    expect(onLeave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(en.list.leaveAnyway));
    expect(onLeave).toHaveBeenCalledWith(false, false);
  });

  it("自己按取消且不髒 → 立刻 onLeave(false, false)", () => {
    const { onLeave } = setup();
    fireEvent.click(screen.getByText(en.list.cancel));
    expect(onLeave).toHaveBeenCalledWith(false, false);
  });

  it("儲存成功 → updateTasksNote 帶開始編輯那版的 fingerprint、onSaved 收到回傳", async () => {
    const saved = note({ content: "typed", fingerprint: "n2" });
    updateTasksNote.mockResolvedValue(saved);
    const { onSaved } = setup();
    type("typed");
    fireEvent.click(screen.getByText(en.list.save));
    await waitFor(() => expect(updateTasksNote).toHaveBeenCalledTimes(1));
    expect(updateTasksNote).toHaveBeenCalledWith(1, "/p", "typed", "n1");
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  });

  it("儲存中：文字區與兩顆鍵停用", async () => {
    let resolve!: (n: TasksNote) => void;
    updateTasksNote.mockReturnValue(new Promise<TasksNote>((r) => { resolve = r; }));
    setup();
    type("typed");
    fireEvent.click(screen.getByText(en.list.save));
    await waitFor(() => expect(box().disabled).toBe(true));
    expect((screen.getByText(en.list.save) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(en.list.cancel) as HTMLButtonElement).disabled).toBe(true);
    resolve(note({ content: "typed", fingerprint: "n2" }));
  });

  it("409 → conflict 橫幅；重新載入 → onLeave(true, false)", async () => {
    updateTasksNote.mockRejectedValue(new TaskConflictError());
    const { onLeave } = setup();
    type("typed");
    fireEvent.click(screen.getByText(en.list.save));
    await screen.findByText(en.note.conflict);
    expect(box().disabled).toBe(false);                       // 失敗後解鎖，字還在
    expect(box().value).toBe("typed");
    fireEvent.click(screen.getByText(en.note.reload));
    expect(onLeave).toHaveBeenCalledWith(true, false);
  });

  it("409 → 複製我的內容 → writeClipboard(content) → 已複製；橫幅不被蓋掉", async () => {
    updateTasksNote.mockRejectedValue(new TaskConflictError());
    setup();
    type("typed");
    fireEvent.click(screen.getByText(en.list.save));
    await screen.findByText(en.note.conflict);
    fireEvent.click(screen.getByText(en.list.copyMine));
    expect(writeClipboard).toHaveBeenCalledWith("typed");
    await screen.findByText(en.list.copied);
    expect(screen.getByText(en.note.conflict)).toBeTruthy();
  });

  it("其他錯誤 → list.actionError 橫幅，留在原畫面", async () => {
    updateTasksNote.mockRejectedValue(new Error("updateTasksNote failed: 500"));
    const { onLeave, onSaved } = setup();
    type("typed");
    fireEvent.click(screen.getByText(en.list.save));
    await screen.findByText(en.list.actionError);
    expect(onLeave).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(box().value).toBe("typed");
  });

  it("掛載時 leaveRequest 非零不重播、不離開", async () => {
    const { onLeave } = setup(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(onLeave).not.toHaveBeenCalled();
    expect(box()).toBeTruthy();
  });

  // request 觸發的橫幅停在畫面上，中間按複製不是離開動作；之後按仍要離開仍要回報 viaRequest=true（Codex R5 的同一條）
  it("leaveRequest 髒 → 橫幅 → 按留下 → 自己按取消 → 仍要離開 → onLeave(false, false)：留下之後的來源是自己", async () => {
    const { onLeave, rerender } = setup(0);
    type("typed");
    rerender(1);
    await screen.findByText(en.note.unsaved);
    fireEvent.click(screen.getByText(en.note.stay));
    fireEvent.click(screen.getByText(en.list.cancel));
    await screen.findByText(en.note.unsaved);
    fireEvent.click(screen.getByText(en.list.leaveAnyway));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledWith(false, false);
  });
});

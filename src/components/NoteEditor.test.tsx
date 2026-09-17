// @vitest-environment jsdom
import { StrictMode } from "react";
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
  const view = (lr: number, n: TasksNote) => <NoteEditor port={1} project="/p" note={n} onSaved={onSaved} onLeave={onLeave} leaveRequest={lr} t={t} />;
  const r = render(view(leaveRequest, note()));
  return { onSaved, onLeave, rerender: (lr: number, n: TasksNote = note()) => r.rerender(view(lr, n)) };
};
const box = () => screen.getByLabelText(en.note.editorBody) as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });

describe("NoteEditor（票 19 增補，spec §10.3）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en"); vi.clearAllMocks();
    // clearAllMocks 只清呼叫紀錄不清實作：上一條的 mockRejectedValue 會漏到下一條，一律 reset 再給預設
    updateTasksNote.mockReset().mockResolvedValue(note());
    writeClipboard.mockReset().mockResolvedValue(true);
  });
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

  it("儲存成功 → updateTasksNote 帶掛載那版的 fingerprint（rerender 換了 note 也不變）、onSaved 收到回傳", async () => {
    const saved = note({ content: "typed", fingerprint: "n2" });
    updateTasksNote.mockResolvedValue(saved);
    const { onSaved, rerender } = setup();
    type("typed");
    // 父層 rerender 傳來另一份 note（內文剛好等於打的字、fingerprint 不同）：基準是掛載時那份，
    // 所以仍算髒（儲存鍵可按）、送出的 fingerprint 仍是 n1——讀 live 的 note 兩個都會錯
    rerender(0, note({ content: "typed", fingerprint: "n9" }));
    expect((screen.getByText(en.list.save) as HTMLButtonElement).disabled).toBe(false);
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

  // 與 TaskEditor 同一條對父層的保證：onLeave 之後絕不 onSaved——父層 savedNote 的 editing=false／
  // pendingNav 作廢是無條件的，晚到的 200 會卸掉使用者剛開的下一個編輯器或清掉新的 pendingNav
  it("儲存中 leaveRequest → 仍要離開（離開永遠可按）→ 之後 PUT 才回 200 → onSaved 不被呼叫、onLeave 只一次", async () => {
    let resolve!: (n: TasksNote) => void;
    updateTasksNote.mockImplementationOnce(() => new Promise<TasksNote>((r) => { resolve = r; }));
    const { onSaved, onLeave, rerender } = setup(0);
    type("typed");
    fireEvent.click(screen.getByText(en.list.save));
    await waitFor(() => expect(box().disabled).toBe(true));          // 在途
    rerender(1);
    await screen.findByText(en.note.unsaved);                         // 儲存中內容仍髒 → 橫幅照出
    const leaveBtn = screen.getByText(en.list.leaveAnyway) as HTMLButtonElement;
    expect(leaveBtn.disabled).toBe(false);                            // spec D8：離開永遠可按
    fireEvent.click(leaveBtn);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledWith(false, true);
    resolve(note({ content: "typed", fingerprint: "n2" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(onSaved).not.toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  // main.tsx 包 React.StrictMode：dev 下 effect 會 mount→cleanup→mount 跑兩次。「離開後不 onSaved」的旗標
  // 若只在 cleanup 關、不在 effect 本體開，dev app 每一次儲存都會靜默丟掉 onSaved——jsdom 不包 StrictMode 看不到
  it("StrictMode 下儲存成功仍呼叫 onSaved（effect 雙跑不得把離開旗標卡死）", async () => {
    const saved = note({ content: "typed", fingerprint: "n2" });
    updateTasksNote.mockResolvedValue(saved);
    const onSaved = vi.fn();
    render(<StrictMode><NoteEditor port={1} project="/p" note={note()} onSaved={onSaved} onLeave={() => {}} leaveRequest={0} t={t} /></StrictMode>);
    type("typed");
    fireEvent.click(screen.getByText(en.list.save));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
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

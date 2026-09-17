// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import type { TaskRow, TasksNote } from "../lib/sidecar";
import { TaskDetail } from "./TaskDetail";

const writeClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("../lib/clipboard", () => ({ writeClipboard: (s: string) => writeClipboard(s) }));

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, { ns: "tasks", ...o }) as string;
const ticket = (over: Partial<TaskRow> = {}): TaskRow => ({
  name: "02-a.md", number: 2, title: "第二件", status: "doing", source: "ai", created: "2026-09-05",
  anomalies: [], fingerprint: "f", path: "/p/a/.fledge/tasks/02-a.md", body: "hello **bold**", editable: true, ...over,
});
const noop = () => {};
const base = (over: Partial<Parameters<typeof TaskDetail>[0]> = {}) => ({
  port: 1, project: "/p/a", projectName: "a", view: { kind: "empty" as const }, editing: false, leaveRequest: 0,
  backLabel: "a", onBack: noop, onCycle: noop, onPark: noop, onDelete: noop, onOpen: noop, onEdit: noop,
  onOpenNote: noop, onEditNote: noop, onSaved: noop, onSavedNote: noop, onLeave: noop, t, ...over,
});
const okNote = (over: Partial<TasksNote> = {}): TasksNote => ({
  status: "ok", content: "# p\n\n## 停在哪\n\n- x", mtime: "2026-09-14", path: "/p/a/.fledge/state.md", fingerprint: "n1", editable: true, ...over,
});

describe("TaskDetail", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); writeClipboard.mockReset().mockResolvedValue(true); });
  afterEach(cleanup);

  it("empty 畫提示；loading 畫載入中", () => {
    const a = render(<TaskDetail {...base()} />);
    expect(a.getByText(en.detail.hint)).toBeTruthy();
    cleanup();
    const b = render(<TaskDetail {...base({ view: { kind: "loading" } })} />);
    expect(b.getByText(en.detail.loading)).toBeTruthy();
  });

  it("票：麵包屑補零票號、標題、資訊列（狀態記號是循環按鈕）、動作在資訊列右側、內文 render", () => {
    const onCycle = vi.fn(), onPark = vi.fn(), onOpen = vi.fn(), onEdit = vi.fn();
    const { container } = render(<TaskDetail {...base({ view: { kind: "ticket", task: ticket(), rescueDraft: null }, onCycle, onPark, onOpen, onEdit })} />);
    expect(container.querySelector(".d-crumb")?.textContent).toBe("a / 02");
    expect(container.querySelector(".d-title")?.textContent).toBe("第二件");
    const meta = container.querySelector(".d-meta")!;
    expect(meta.querySelector(".d-acts")).not.toBeNull();             // 動作鍵在資訊列裡，不在內文下面
    expect(container.querySelector(".d-body strong")?.textContent).toBe("bold");
    const label = en.a11y.statusCycle.replace("{{current}}", en.status.doing).replace("{{next}}", en.status.done);
    fireEvent.click(screen.getByLabelText(label));
    expect(onCycle).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(en.list.park)); expect(onPark).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(en.a11y.openInEditor)); expect(onOpen).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(en.list.edit)); expect(onEdit).toHaveBeenCalled();
    expect(screen.getByText(en.detail.source.replace("{{who}}", en.source.ai))).toBeTruthy();
    expect(screen.getByText(en.detail.created.replace("{{date}}", "2026-09-05"))).toBeTruthy();
  });

  it("票：刪除兩段確認，取消不呼叫、確認才呼叫", () => {
    const onDelete = vi.fn();
    render(<TaskDetail {...base({ view: { kind: "ticket", task: ticket(), rescueDraft: null }, onDelete })} />);
    fireEvent.click(screen.getByLabelText(en.list.delete));
    fireEvent.click(screen.getByText(en.list.cancel));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(en.list.delete));
    fireEvent.click(screen.getAllByText(en.list.delete).find((el) => el.classList.contains("tk-confirm-yes"))!);
    expect(onDelete).toHaveBeenCalled();
  });

  it("票：parked 的動作鍵是取回；沒編號畫 —；沒內文畫提示", () => {
    const { container } = render(<TaskDetail {...base({ view: { kind: "ticket", task: ticket({ status: "parked", number: null, body: "" }), rescueDraft: null } })} />);
    expect(screen.getByLabelText(en.list.unpark)).toBeTruthy();
    expect(container.querySelector(".d-crumb")?.textContent).toBe("a / —");
    expect(screen.getByText(en.list.noBody)).toBeTruthy();
  });

  it("票：editable:false 藏編輯鍵、顯示不可編輯說明；有救援草稿時給複製、不給丟棄", async () => {
    // savedAt 是 TaskDraft 型別必填欄位（brief 原字面值漏了），元件本身不讀這個欄位，補上不影響測試邏輯
    const { container } = render(<TaskDetail {...base({ view: { kind: "ticket", task: ticket({ editable: false }), rescueDraft: { title: "T", body: "B", fingerprint: "old", savedAt: 0 } } })} />);
    expect(screen.queryByLabelText(en.list.edit)).toBeNull();
    expect(screen.getByText(en.list.notEditable)).toBeTruthy();
    expect(screen.queryByText(en.list.draftDiscard)).toBeNull();
    fireEvent.click(screen.getByText(en.list.copyMine));
    expect(writeClipboard).toHaveBeenCalledWith("# T\n\nB");
    await screen.findByText(en.list.copied);
    expect(container.querySelector(".tk-banner.is-draft")).not.toBeNull();
  });

  it("票：對 A 展開刪除確認後換成 B，確認列消失", () => {
    const a = ticket(), b = ticket({ name: "03-b.md", number: 3, title: "B" });
    const { container, rerender } = render(<TaskDetail {...base({ view: { kind: "ticket", task: a, rescueDraft: null } })} />);
    fireEvent.click(screen.getByLabelText(en.list.delete));
    expect(container.querySelector(".tk-confirm")).not.toBeNull();
    rerender(<TaskDetail {...base({ view: { kind: "ticket", task: b, rescueDraft: null } })} />);
    expect(container.querySelector(".tk-confirm")).toBeNull();
  });

  it("票：anomalies 有值時畫記號，點開列出原因", () => {
    render(<TaskDetail {...base({ view: { kind: "ticket", task: ticket({ anomalies: ["number_duplicate"] }), rescueDraft: null } })} />);
    fireEvent.click(screen.getByLabelText(en.anomaly.label));
    expect(screen.getByText(en.anomaly.number_duplicate)).toBeTruthy();
  });

  it("editing 為 true 時畫 TaskEditor，不畫票的檢視", () => {
    const { container } = render(<TaskDetail {...base({ view: { kind: "ticket", task: ticket(), rescueDraft: null }, editing: true })} />);
    expect(container.querySelector(".full-editor")).not.toBeNull();
    expect(container.querySelector(".d-title")).toBeNull();
  });

  it("筆記：ok 畫全文與更新日，開檔鍵帶 path；absent／unavailable 畫讀不到；null 畫載入中", () => {
    const onOpenNote = vi.fn();
    const { container, rerender } = render(<TaskDetail {...base({ view: { kind: "note", note: okNote() }, onOpenNote })} />);
    expect(container.querySelector(".d-crumb")?.textContent).toBe("a / .fledge/state.md");
    expect(container.querySelector(".d-title")?.textContent).toBe(en.detail.noteTitle);
    expect(screen.getByText(en.detail.noteUpdated.replace("{{date}}", "2026-09-14"))).toBeTruthy();
    expect(container.querySelector(".d-body h2")?.textContent).toBe("停在哪");
    fireEvent.click(screen.getByLabelText(en.a11y.openInEditor));
    expect(onOpenNote).toHaveBeenCalledWith("/p/a/.fledge/state.md");
    rerender(<TaskDetail {...base({ view: { kind: "note", note: { status: "absent", content: null, mtime: null, path: null, fingerprint: null, editable: false } } })} />);
    expect(screen.getByText(en.detail.noteUnavailable)).toBeTruthy();
    expect(screen.queryByLabelText(en.a11y.openInEditor)).toBeNull();
    rerender(<TaskDetail {...base({ view: { kind: "note", note: null } })} />);
    expect(screen.getByText(en.detail.loading)).toBeTruthy();
  });

  // 票 19 增補 §10.3：筆記檢視的編輯鍵排在「用編輯器打開」左邊，與票的資訊列同序
  it("筆記：editable → 編輯鍵在（排在開檔鍵前面）、點了 onEditNote；沒有 note.notEditable", () => {
    const onEditNote = vi.fn();
    const { container } = render(<TaskDetail {...base({ view: { kind: "note", note: okNote() }, onEditNote })} />);
    const acts = [...container.querySelectorAll(".d-meta .d-acts button")].map((b) => b.getAttribute("aria-label"));
    expect(acts).toEqual([en.a11y.editNote, en.a11y.openInEditor]);
    fireEvent.click(screen.getByLabelText(en.a11y.editNote));
    expect(onEditNote).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(en.note.notEditable)).toBeNull();
  });

  it("筆記：editable:false → 沒編輯鍵、有 note.notEditable、開檔鍵仍在", () => {
    render(<TaskDetail {...base({ view: { kind: "note", note: okNote({ editable: false }) } })} />);
    expect(screen.queryByLabelText(en.a11y.editNote)).toBeNull();
    expect(screen.getByText(en.note.notEditable)).toBeTruthy();
    expect(screen.getByLabelText(en.a11y.openInEditor)).toBeTruthy();
  });

  it("editing 且 view 是 note → 畫 NoteEditor（有 note.editorBody、.lb-detail.is-editing），不畫 d-title", () => {
    const { container } = render(<TaskDetail {...base({ view: { kind: "note", note: okNote() }, editing: true })} />);
    expect(container.querySelector(".lb-detail.is-editing .full-editor")).not.toBeNull();
    expect(screen.getByLabelText(en.note.editorBody)).toBeTruthy();
    expect(container.querySelector(".d-title")).toBeNull();
    expect(screen.queryByLabelText(en.a11y.editNote)).toBeNull();
  });

  it("返回鍵在 DOM 裡並回呼（顯示與否由 CSS 決定）", () => {
    const onBack = vi.fn();
    render(<TaskDetail {...base({ view: { kind: "ticket", task: ticket(), rescueDraft: null }, onBack, backLabel: "proj" })} />);
    fireEvent.click(screen.getByText("proj"));
    expect(onBack).toHaveBeenCalled();
  });
});

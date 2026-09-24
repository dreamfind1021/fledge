// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import type { TaskRow, TasksListResponse } from "../lib/sidecar";
import { NEXT_STATUS, TasksList } from "./TasksList";

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, { ns: "tasks", ...o }) as string;
const ticket = (over: Partial<TaskRow> = {}): TaskRow => ({
  name: "01-a.md", number: 1, title: "第一件", status: "todo", source: "me", created: "2026-08-29",
  anomalies: [], fingerprint: "f", path: "/p/a/.fledge/tasks/01-a.md", body: "", editable: true, ...over,
});
const list = (tasks: TaskRow[], over: Partial<TasksListResponse> = {}): TasksListResponse =>
  ({ project: "/p/a", tasks_status: "ok", tasks, next_step: "", handoff_command: "", ...over });
const noop = () => {};
const props = (over: Partial<Parameters<typeof TasksList>[0]> = {}) => ({
  data: list([ticket()]), projectName: "a", failed: false, notice: "",
  selectedName: null, onSelectTicket: noop, showNote: false, onToggleNote: noop, readOnly: false,
  orphanDrafts: [], onOrphanDiscard: noop, onBack: noop, onCreate: async () => {},
  onCycle: noop, onPark: noop, onDelete: noop, onOpen: noop, onEdit: noop, t, ...over,
});

describe("TasksList", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(cleanup);

  it("NEXT_STATUS：三態循環不變，parked 的下一個是 todo", () => {
    expect(NEXT_STATUS).toEqual({ todo: "doing", doing: "done", done: "todo", parked: "todo" });
  });

  it("四區：進行中／待辦預設展開，擱置／已完成預設收起，空區不畫", () => {
    render(<TasksList {...props({ data: list([
      ticket({ name: "01-d.md", number: 1, status: "doing", title: "D" }),
      ticket({ name: "02-t.md", number: 2, status: "todo", title: "T" }),
      ticket({ name: "03-p.md", number: 3, status: "parked", title: "P" }),
      ticket({ name: "04-x.md", number: 4, status: "done", title: "X" }),
    ]) })} />);
    expect(screen.getByText("D")).toBeTruthy();
    expect(screen.getByText("T")).toBeTruthy();
    expect(screen.queryByText("P")).toBeNull();
    expect(screen.queryByText("X")).toBeNull();
    fireEvent.click(screen.getByLabelText(en.a11y.expandParked));
    expect(screen.getByText("P")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(en.a11y.collapseDoing));
    expect(screen.queryByText("D")).toBeNull();
    // 只有一種狀態時其他三區的標頭不出現
    cleanup();
    const only = render(<TasksList {...props({ data: list([ticket({ status: "todo" })]) })} />);
    expect(only.container.querySelectorAll(".tasks-sec").length).toBe(1);
  });

  it("摘要四段固定，擱置是 0 也畫", () => {
    render(<TasksList {...props({ data: list([ticket({ status: "doing" }), ticket({ name: "02.md", number: 2, status: "done" })]) })} />);
    expect(screen.getByText(en.list.summary.replace("{{doing}}", "1").replace("{{todo}}", "0").replace("{{parked}}", "0").replace("{{done}}", "1"))).toBeTruthy();
  });

  it("點列回呼檔名；selectedName 那列反白；沒有原地展開的內文", () => {
    const onSelectTicket = vi.fn();
    const { container, rerender } = render(<TasksList {...props({ onSelectTicket, data: list([ticket({ body: "hidden body" })]) })} />);
    fireEvent.click(screen.getByText("第一件"));
    expect(onSelectTicket).toHaveBeenCalledWith("01-a.md");
    expect(screen.queryByText("hidden body")).toBeNull();
    expect(container.querySelector(".tk-row.active")).toBeNull();
    rerender(<TasksList {...props({ onSelectTicket, selectedName: "01-a.md", data: list([ticket({ body: "hidden body" })]) })} />);
    expect(container.querySelector(".tk-row.active")).not.toBeNull();
    expect(container.querySelector(".tk-body")).toBeNull();
  });

  it("hover 動作四顆：編輯（editable 才有）、開檔、擱置／取回、刪除；擱置那顆依狀態換字", () => {
    const onPark = vi.fn();
    const { container, rerender } = render(<TasksList {...props({ onPark, data: list([ticket()]) })} />);
    expect(screen.getByLabelText(en.list.edit)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(en.list.park));
    expect(onPark).toHaveBeenCalledWith(expect.objectContaining({ name: "01-a.md" }));
    rerender(<TasksList {...props({ onPark, data: list([ticket({ status: "parked" })]) })} />);
    fireEvent.click(screen.getByLabelText(en.a11y.expandParked));
    expect(screen.getByLabelText(en.list.unpark)).toBeTruthy();
    expect(container.querySelector(".tk-mark.is-parked")).not.toBeNull();
    rerender(<TasksList {...props({ data: list([ticket({ editable: false })]) })} />);
    expect(screen.queryByLabelText(en.list.edit)).toBeNull();
  });

  it("狀態記號的可及名稱：parked 點下去變 todo", () => {
    render(<TasksList {...props({ data: list([ticket({ status: "parked" })]) })} />);
    fireEvent.click(screen.getByLabelText(en.a11y.expandParked));
    const label = en.a11y.statusCycle.replace("{{current}}", en.status.parked).replace("{{next}}", en.status.todo);
    expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it("下一步整塊可點、可鍵盤、反白跟著 showNote；沒有下一步就沒有這塊", () => {
    const onToggleNote = vi.fn();
    const { container, rerender } = render(<TasksList {...props({ onToggleNote, data: list([ticket()], { next_step: "do x" }) })} />);
    const block = screen.getByLabelText(en.a11y.showNote);
    fireEvent.click(block);
    expect(onToggleNote).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(block, { key: "Enter" });
    expect(onToggleNote).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".tasks-next-more")?.textContent).toBe("›");
    rerender(<TasksList {...props({ onToggleNote, showNote: true, data: list([ticket()], { next_step: "do x" }) })} />);
    expect(screen.getByLabelText(en.a11y.hideNote).classList.contains("is-on")).toBe(true);
    rerender(<TasksList {...props({ data: list([ticket()]) })} />);
    expect(container.querySelector(".tasks-next")).toBeNull();
  });

  it("readOnly：一行輸入、狀態記號、四顆動作全部 disabled；列本身與下一步仍可點", () => {
    const onSelectTicket = vi.fn(), onToggleNote = vi.fn(), onCycle = vi.fn();
    const data = list([ticket()], { next_step: "x" });
    // 先在可寫狀態展開刪除確認，再切成唯讀：確認框必須跟著收掉，否則確認鍵還能送 DELETE（Codex plan R1 high）
    const { container, rerender } = render(<TasksList {...props({ readOnly: false, onSelectTicket, onToggleNote, onCycle, data })} />);
    fireEvent.click(screen.getByLabelText(en.list.delete));
    expect(container.querySelector(".tk-confirm")).not.toBeNull();
    rerender(<TasksList {...props({ readOnly: true, onSelectTicket, onToggleNote, onCycle, data })} />);
    expect(container.querySelector(".tk-confirm")).toBeNull();
    expect((screen.getByPlaceholderText(en.list.newPlaceholder) as HTMLInputElement).disabled).toBe(true);
    const mark = screen.getByTitle(en.status.todo) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    for (const l of [en.list.edit, en.a11y.openInEditor, en.list.park, en.list.delete]) {
      expect((screen.getByLabelText(l) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByText("第一件"));
    expect(onSelectTicket).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(en.a11y.showNote));
    expect(onToggleNote).toHaveBeenCalled();
  });

  it("readOnly：孤兒草稿的丟棄鍵 disabled（不可回復的寫入），複製仍可按", () => {
    const onOrphanDiscard = vi.fn();
    const orphanDrafts = [{ name: "09-gone.md", draft: { title: "舊草稿", body: "b", fingerprint: "f", savedAt: 0 } }];
    render(<TasksList {...props({ readOnly: true, orphanDrafts, onOrphanDiscard })} />);
    const discard = screen.getByText(en.list.draftDiscard) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    fireEvent.click(discard);
    expect(onOrphanDiscard).not.toHaveBeenCalled();
    expect((screen.getByText(en.list.copyMine) as HTMLButtonElement).disabled).toBe(false);
  });

  it("窄等級的返回鍵在 DOM 裡（顯示與否由 CSS 決定）", () => {
    const onBack = vi.fn();
    render(<TasksList {...props({ onBack })} />);
    fireEvent.click(screen.getByText(en.list.back));
    expect(onBack).toHaveBeenCalled();
  });
});

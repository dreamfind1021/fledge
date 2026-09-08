// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import { TaskConflictError, type TaskRow } from "../lib/sidecar";
import { loadDraft, saveDraft } from "../lib/taskDraft";
import { TaskEditor } from "./TaskEditor";

const updateTaskContent = vi.fn<(...a: unknown[]) => Promise<TaskRow>>();
vi.mock("../lib/sidecar", async (orig) => ({
  ...(await orig<typeof import("../lib/sidecar")>()),
  updateTaskContent: (...a: unknown[]) => updateTaskContent(...a),
}));

// copyMine 換走了 brief 原本的 @tauri-apps/plugin-clipboard-manager，改走這個 repo 自己的
// writeClipboard（回 boolean、不 throw）；mock 寫法沿用 EnvCard.test.tsx 已驗證過的樣子。
const writeClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("../lib/clipboard", () => ({ writeClipboard: (t: string) => writeClipboard(t) }));

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  name: "01-a.md", number: 1, title: "舊標題", status: "todo", source: "me", created: "2026-09-01",
  anomalies: [], fingerprint: "f0", path: "/p/.fledge/tasks/01-a.md", body: "舊內文", editable: true, ...over,
});
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, { ns: "tasks", ...o }) as string;
const setup = (over: Partial<TaskRow> = {}, extra = {}) => {
  const onSaved = vi.fn(); const onLeave = vi.fn();
  render(<TaskEditor port={1} project="/p" projectName="p" task={task(over)} onSaved={onSaved} onLeave={onLeave} t={t} {...extra} />);
  return { onSaved, onLeave };
};
const titleBox = () => screen.getByLabelText(en.list.editorTitle) as HTMLInputElement;
const bodyBox = () => screen.getByLabelText(en.list.editorBody) as HTMLTextAreaElement;
const saveBtn = () => screen.getByText(en.list.save) as HTMLButtonElement;

describe("TaskEditor", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en"); vi.clearAllMocks(); localStorage.clear(); vi.useRealTimers();
    writeClipboard.mockReset().mockResolvedValue(true);
  });
  afterEach(cleanup);

  it("送出前正規化並寫回畫面；送出的 fingerprint 是開始編輯那一版", async () => {
    updateTaskContent.mockResolvedValue(task({ title: "a b", fingerprint: "f1" }));
    const { onSaved } = setup();
    fireEvent.change(titleBox(), { target: { value: "  a   b  " } });
    fireEvent.change(bodyBox(), { target: { value: "\n\nline\r\nnext\n\n" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(updateTaskContent).toHaveBeenCalledTimes(1));
    const [, , , sentTitle, sentBody, sentFp] = updateTaskContent.mock.calls[0];
    expect(sentTitle).toBe("a b"); expect(sentBody).toBe("line\nnext"); expect(sentFp).toBe("f0");
    expect(titleBox().value).toBe("a b"); expect(bodyBox().value).toBe("line\nnext");
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: "f1" })));
    expect(loadDraft("/p", "01-a.md")).toBeNull();               // 成功清草稿
  });

  it("標題正規化後為空 → 擋下儲存不發 PUT", async () => {
    setup();
    fireEvent.change(titleBox(), { target: { value: "   " } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.titleRequired)).toBeTruthy());
    expect(updateTaskContent).not.toHaveBeenCalled();
  });

  it("儲存中鎖編輯區但返回可按；成功後回清單", async () => {
    let resolve!: (r: TaskRow) => void;
    updateTaskContent.mockReturnValue(new Promise((r) => { resolve = r; }));
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(titleBox().disabled).toBe(true));
    expect(bodyBox().disabled).toBe(true); expect(saveBtn().disabled).toBe(true);
    const back = screen.getByText("p") as HTMLButtonElement;        // 返回列上的專案名
    expect(back.disabled).toBe(false);
    resolve(task({ fingerprint: "f1" }));
  });

  it("409：編輯區一個字不動、顯示衝突提示、草稿留著", async () => {
    updateTaskContent.mockRejectedValue(new TaskConflictError());
    setup();
    fireEvent.change(bodyBox(), { target: { value: "我打的" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.conflictEditor)).toBeTruthy());
    expect(bodyBox().value).toBe("我打的"); expect(bodyBox().disabled).toBe(false);
    expect(loadDraft("/p", "01-a.md")?.body).toBe("我打的");
  });

  it("200 但回應缺 fingerprint → 當失敗，草稿留著", async () => {
    updateTaskContent.mockRejectedValue(new Error("updateTaskContent: malformed response"));
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(/Save failed/)).toBeTruthy());
    expect(loadDraft("/p", "01-a.md")?.body).toBe("x");
  });

  it("flush 失敗：不鎖、不發 PUT、顯示警告且複製與返回可按", async () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.draftUnsavable)).toBeTruthy());
    expect(updateTaskContent).not.toHaveBeenCalled();
    expect(bodyBox().disabled).toBe(false);
    spy.mockRestore();
  });

  it("打字後未滿 debounce 就返回：草稿已同步 flush（spec §7.3 一般離開）", () => {
    vi.useFakeTimers();
    const { onLeave } = setup();
    fireEvent.change(bodyBox(), { target: { value: "最後一段" } });
    fireEvent.click(screen.getByText("p"));                              // debounce 還沒觸發就按返回
    expect(loadDraft("/p", "01-a.md")?.body).toBe("最後一段");
    expect(onLeave).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("返回時 flush 失敗：不離開、顯示警告、可複製或仍要離開", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("q"); });
    const { onLeave } = setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(screen.getByText("p"));
    expect(onLeave).not.toHaveBeenCalled();
    expect(screen.getByText(en.list.draftUnsavable)).toBeTruthy();
    expect(screen.getByText(en.list.leaveAnyway)).toBeTruthy();
    fireEvent.click(screen.getByText(en.list.leaveAnyway));
    expect(onLeave).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("沒有改動就返回：不 flush、直接離開", () => {
    const spy = vi.spyOn(localStorage, "setItem");
    const { onLeave } = setup();
    fireEvent.click(screen.getByText("p"));
    expect(spy).not.toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("進來時有草稿且 fingerprint 相同 → 提示接著改；接著改後內容換成草稿", async () => {
    saveDraft("/p", "01-a.md", { title: "草稿標題", body: "草稿內文", fingerprint: "f0" });
    setup();
    expect(screen.getByText(en.list.draftFound)).toBeTruthy();
    fireEvent.click(screen.getByText(en.list.draftResume));
    expect(titleBox().value).toBe("草稿標題"); expect(bodyBox().value).toBe("草稿內文");
  });

  it("草稿 fingerprint 不同 → 提示被改過；還原後送出用的仍是草稿那版指紋", async () => {
    saveDraft("/p", "01-a.md", { title: "t", body: "b", fingerprint: "OLD" });
    updateTaskContent.mockRejectedValue(new TaskConflictError());
    setup({ fingerprint: "NEW" });
    expect(screen.getByText(en.list.draftStale)).toBeTruthy();
    fireEvent.click(screen.getByText(en.list.draftRestoreAnyway));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(updateTaskContent).toHaveBeenCalledTimes(1));
    expect(updateTaskContent.mock.calls[0][5]).toBe("OLD");
  });

  it("丟棄草稿：清掉且 pending debounce 不會寫回", async () => {
    vi.useFakeTimers();
    saveDraft("/p", "01-a.md", { title: "t", body: "b", fingerprint: "f0" });
    setup();
    fireEvent.change(bodyBox(), { target: { value: "打了一點" } });    // 排一個 debounce
    fireEvent.click(screen.getByText(en.list.draftDiscard));
    vi.advanceTimersByTime(2000);
    expect(loadDraft("/p", "01-a.md")).toBeNull();
    vi.useRealTimers();
  });

  it("離開時 abort：晚到的 200 不清草稿", async () => {
    let resolve!: (r: TaskRow) => void;
    let seenSignal: AbortSignal | undefined;
    updateTaskContent.mockImplementation((...a) => { seenSignal = a[6] as AbortSignal; return new Promise((r) => { resolve = r; }); });
    const { onLeave } = setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(updateTaskContent).toHaveBeenCalled());
    fireEvent.click(screen.getByText("p"));                              // 返回
    expect(onLeave).toHaveBeenCalled();
    expect(seenSignal?.aborted).toBe(true);
    resolve(task({ fingerprint: "f1" }));                                 // 晚到
    await new Promise((r) => setTimeout(r, 0));
    expect(loadDraft("/p", "01-a.md")?.body).toBe("x");                  // 草稿還在
  });

  it("unmount（closeTab 路徑）時 abort 在途請求並 flush 草稿（plan R2 F3）", async () => {
    let seenSignal: AbortSignal | undefined;
    updateTaskContent.mockImplementation((...a) => { seenSignal = a[6] as AbortSignal; return new Promise(() => {}); });
    const { unmount } = render(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={vi.fn()} onLeave={vi.fn()} t={t} />);
    fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "x" } });
    fireEvent.click(screen.getByText(en.list.save));
    await waitFor(() => expect(updateTaskContent).toHaveBeenCalled());
    // save() 送 PUT 之前已經同步 flush 過一次草稿（:117）——不清掉的話，就算 cleanup 的
    // saveDraft 整行被砍掉，下面的斷言照樣綠，因為看到的是 save() 那次 flush 留下的痕跡，
    // 不是 cleanup 自己的（task 10 review FIX 3：這條原本是假綠）
    localStorage.clear();
    unmount();                                                           // 模擬 closeTab：不經 leave()
    expect(seenSignal?.aborted).toBe(true);
    expect(loadDraft("/p", "01-a.md")?.body).toBe("x");
  });

  it("儲存成功後父層在 onSaved 當下同步卸載：cleanup 不會留下幽靈草稿（task 10 review FIX 1）", async () => {
    // 重現真正的 bug 形狀：onSaved 常常是父層拿掉編輯器的那個動作本身（同一個事件迴圈裡），
    // TaskEditor 自己完全沒有機會先用 dirty:false 多 render 一次——如果測試在 onSaved 之後
    // 才 await 一輪再手動 unmount，等於多送了一次 render，會讓 latest.current 提前被
    // render body（:61）同步掉，看不出 review 抓到的那個競態
    updateTaskContent.mockResolvedValue(task({ fingerprint: "f1" }));
    let doUnmount: (() => void) | null = null;
    const onSaved = vi.fn(() => doUnmount?.());
    const { unmount } = render(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={onSaved} onLeave={vi.fn()} t={t} />);
    doUnmount = unmount;
    fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "x" } });
    fireEvent.click(screen.getByText(en.list.save));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // 不能只驗「存檔成功清了草稿」——要驗的是卸載當下沒有用舊 fingerprint 把剛存好的
    // 內容當「未存」又寫回一份幽靈草稿
    expect(loadDraft("/p", "01-a.md")).toBeNull();
  });

  it("捨棄我的版本後 unmount：草稿不會被 cleanup 寫回（plan R3 F1）", async () => {
    updateTaskContent.mockRejectedValue(new TaskConflictError());
    const { unmount } = render(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={vi.fn()} onLeave={vi.fn()} t={t} />);
    fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "我的版本" } });
    fireEvent.click(screen.getByText(en.list.save));
    await screen.findByText(en.list.conflictEditor);
    fireEvent.click(screen.getByText(en.list.discardAndReload));
    unmount();
    expect(loadDraft("/p", "01-a.md")).toBeNull();
  });

  it("unmount 後舊的 debounce timer 不會覆寫重開後的新草稿（plan R3 F1）", () => {
    vi.useFakeTimers();
    const { unmount } = render(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={vi.fn()} onLeave={vi.fn()} t={t} />);
    fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "舊" } });
    unmount();                                                           // cleanup 已 flush「舊」並取消 timer
    saveDraft("/p", "01-a.md", { title: "t", body: "新", fingerprint: "f0" });   // 模擬重開後寫新草稿
    vi.advanceTimersByTime(2000);
    expect(loadDraft("/p", "01-a.md")?.body).toBe("新");                // 舊 timer 沒覆寫
    vi.useRealTimers();
  });

  it("unmount 時沒改過就不寫草稿", () => {
    const spy = vi.spyOn(localStorage, "setItem");
    const { unmount } = render(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={vi.fn()} onLeave={vi.fn()} t={t} />);
    unmount();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("工具列：粗體把選取包起來", () => {
    setup();
    const box = bodyBox();
    fireEvent.change(box, { target: { value: "hello world" } });
    box.setSelectionRange(0, 5);
    fireEvent.click(screen.getByLabelText(en.a11y.toolbarBold));
    expect(box.value).toBe("**hello** world");
  });

  it("預覽切換顯示 render 後的內文", () => {
    setup({ body: "**b**" });
    fireEvent.click(screen.getByText(en.list.preview));
    expect(document.querySelector(".ed-preview strong")?.textContent).toBe("b");
  });

  it("複製我的內容成功 → 顯示已複製（task 10 review FIX 6）", async () => {
    updateTaskContent.mockRejectedValue(new TaskConflictError());
    writeClipboard.mockResolvedValue(true);
    setup();
    fireEvent.change(bodyBox(), { target: { value: "我的內容" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.conflictEditor)).toBeTruthy());
    fireEvent.click(screen.getByText(en.list.copyMine));
    expect(writeClipboard).toHaveBeenCalledWith("# 舊標題\n\n我的內容");
    await waitFor(() => expect(screen.getByText(en.list.copied)).toBeTruthy());
  });

  it("複製我的內容失敗（回 false）→ 不顯示已複製，原本的提示還在（task 10 review FIX 6）", async () => {
    updateTaskContent.mockRejectedValue(new TaskConflictError());
    writeClipboard.mockResolvedValue(false);
    setup();
    fireEvent.change(bodyBox(), { target: { value: "我的內容" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.conflictEditor)).toBeTruthy());
    fireEvent.click(screen.getByText(en.list.copyMine));
    await waitFor(() => expect(writeClipboard).toHaveBeenCalled());
    expect(screen.queryByText(en.list.copied)).toBeNull();
    expect(screen.getByText(en.list.conflictEditor)).toBeTruthy();   // notice 沒被覆蓋
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import { TaskConflictError, TaskContentError, type TaskRow } from "../lib/sidecar";
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

  it("貼上網頁／PDF／Word 常見的分行與空白字元也正規化成 \\n／空白後送出（whole-branch review FIX 2）", async () => {
    // Python 的 str.splitlines() 除了 \r\n／\r／\n，還認 \v\f\x1c\x1d\x1e\x85\u2028\u2029；
    // JS 的 /\r\n?/ 完全不認得——不折成 \n 的話這些字元原封送到 sidecar，can_round_trip
    // 判 False、400 invalid_content，訊息看不出原因，使用者按幾次 Save 都一樣失敗
    // （這是原本的死路：Task 3 讓 sidecar 用後置條件拒絕，Task 10 依 spec §5.2.2 字面實作
    // 正規化，兩邊各自正確、合起來卻沒有出口）。標題另外還要吃 \x1c-\x1f 與 \x85——
    // Python str.split() 認的空白比 JS 的 \s 寬
    updateTaskContent.mockResolvedValue(task({ fingerprint: "f1" }));
    setup();
    const body = "first\x0bsecond\x0cthird\x1cfourth\x1dfifth\x1esixth\x85seventh\u2028eighth\u2029ninth";
    fireEvent.change(bodyBox(), { target: { value: body } });
    fireEvent.change(titleBox(), { target: { value: "a\x1cb\x1fc" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(updateTaskContent).toHaveBeenCalledTimes(1));
    const [, , , sentTitle, sentBody] = updateTaskContent.mock.calls[0];
    const expectedBody = "first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth\nninth";
    expect(sentTitle).toBe("a b c");
    expect(sentBody).toBe(expectedBody);
    expect(titleBox().value).toBe("a b c");                     // 畫面寫回的是正規化後的結果（§5.2.2）
    expect(bodyBox().value).toBe(expectedBody);
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

  it("200 但回應缺 fingerprint → 落回通用字串（不是 e.message），草稿留著（whole-branch review 二輪 FIX 1）", async () => {
    // malformed response 不是 TaskContentError，是 sidecar.ts 自己驗形狀後拋的裸 Error——
    // 這條路徑也不得把 e.message 塞進畫面（CLAUDE.md §4.6.13 管的是任何內部字串，不是只有
    // 400 那條），所以斷言用具體的翻譯字串而不是拿 /Save failed/ 這種可能巧合命中的 regex
    updateTaskContent.mockRejectedValue(new Error("updateTaskContent: malformed response"));
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.saveFailedGeneric)).toBeTruthy());
    expect(screen.queryByText(/malformed response/)).toBeNull();   // 原始例外字串沒有外流
    expect(loadDraft("/p", "01-a.md")?.body).toBe("x");
  });

  it("400 not_editable → 顯示專屬訊息、草稿留著（whole-branch review FIX 3，spec §8 封閉列舉）", async () => {
    updateTaskContent.mockRejectedValue(new TaskContentError("not_editable", 400));
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.saveFailedNotEditable)).toBeTruthy());
    expect(loadDraft("/p", "01-a.md")?.body).toBe("x");
  });

  it("400 invalid_content → 顯示專屬訊息、草稿留著", async () => {
    updateTaskContent.mockRejectedValue(new TaskContentError("invalid_content", 400));
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.saveFailedInvalidContent)).toBeTruthy());
    expect(loadDraft("/p", "01-a.md")?.body).toBe("x");
  });

  it("500 write_failed → 專屬訊息（磁碟／檔案系統問題，不是使用者的錯），並把原始例外記進 console（whole-branch review 二輪 FIX 1）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new TaskContentError("write_failed", 500);
    updateTaskContent.mockRejectedValue(err);
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.saveFailedWriteFailed)).toBeTruthy());
    expect(screen.queryByText(en.list.saveFailedNotEditable)).toBeNull();
    expect(screen.queryByText(en.list.saveFailedInvalidContent)).toBeNull();
    expect(screen.queryByText(en.list.saveFailedGeneric)).toBeNull();
    expect(screen.queryByText(/write_failed|status: 500|updateTaskContent failed/)).toBeNull();   // 判別碼／狀態碼沒有外流
    expect(errSpy).toHaveBeenCalledWith(expect.any(String), err);   // 診斷資訊仍留在 devtools
    errSpy.mockRestore();
  });

  it("400 invalid_target → 落回通用「儲存失敗」字串，不誤用 write_failed 或其他專屬字串（not_editable 與 write_failed 過去長得一樣，通用與專屬也不能混）", async () => {
    updateTaskContent.mockRejectedValue(new TaskContentError("invalid_target", 400));
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.saveFailedGeneric)).toBeTruthy());
    expect(screen.queryByText(en.list.saveFailedNotEditable)).toBeNull();
    expect(screen.queryByText(en.list.saveFailedInvalidContent)).toBeNull();
    expect(screen.queryByText(en.list.saveFailedWriteFailed)).toBeNull();
  });

  it("儲存失敗（非 409）也要有〔複製我的內容〕——spec §7.3 的失敗表格點名這顆按鈕（whole-branch review FIX 1）", async () => {
    updateTaskContent.mockRejectedValue(new Error("updateTaskContent: malformed response"));
    writeClipboard.mockResolvedValue(true);
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.saveFailedGeneric)).toBeTruthy());
    fireEvent.click(screen.getByText(en.list.copyMine));
    expect(writeClipboard).toHaveBeenCalledWith("# 舊標題\n\nx");
    await waitFor(() => expect(screen.getByText(en.list.copied)).toBeTruthy());
  });

  it("titleRequired 不需要〔複製我的內容〕——內容還活在可編輯的欄位裡，不是 §7.3 失敗表格的情境", async () => {
    setup();
    fireEvent.change(titleBox(), { target: { value: "   " } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.titleRequired)).toBeTruthy());
    expect(screen.queryByText(en.list.copyMine)).toBeNull();
  });

  it("flush 失敗：不鎖、不發 PUT、顯示警告且複製與返回可按", async () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.draftUnsavableSave)).toBeTruthy());
    expect(updateTaskContent).not.toHaveBeenCalled();
    expect(bodyBox().disabled).toBe(false);
    spy.mockRestore();
  });

  it("flush 持續失敗：按幾次儲存都不會發 PUT，沒有強制路徑（review high finding FIX 2）", async () => {
    // §7.3：flush 失敗「不進 isSaving、不鎖、不發 PUT」是硬性前置條件，允許的操作只有
    // 複製／繼續編輯／取消——沒有「仍要儲存」；K6 下寫壞票檔＋沒有最新草稿可能同時發生
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.draftUnsavableSave)).toBeTruthy());
    expect(updateTaskContent).not.toHaveBeenCalled();
    // 警告條裡只剩複製我的內容一顆按鈕——「仍要儲存」被整個拿掉，不是被停用
    const banner = screen.getByText(en.list.draftUnsavableSave).closest(".tk-banner");
    expect(banner?.querySelectorAll("button.bbtn").length).toBe(1);
    fireEvent.click(saveBtn());                                          // 再按一次儲存
    expect(updateTaskContent).not.toHaveBeenCalled();
    expect(screen.getByText(en.list.draftUnsavableSave)).toBeTruthy();   // 警告還在，不是被清空後偷偷發了 PUT
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

  // 這條原本測「送出途中按接著改」，前提是 Save 能在草稿提示還在時按下去；
  // 這一輪的修法（下面 5 條 review high finding 新測試）讓那個前提本身變得不可達——
  // 提示還在時 Save 現在直接是 disabled，不可能同時進入 saving 又看得到提示。
  // 換成驗證「不可達」這件事本身：草稿提示存在時，Save 按下去完全沒有效果
  it("草稿提示還在時，Save 按不下去——不可能同時進入 saving（原「儲存中鎖住…」測試前提已被取代）", async () => {
    saveDraft("/p", "01-a.md", { title: "草稿標題", body: "草稿內文", fingerprint: "f0" });
    setup();
    expect(screen.getByText(en.list.draftFound)).toBeTruthy();
    fireEvent.click(saveBtn());
    expect(updateTaskContent).not.toHaveBeenCalled();
    expect(screen.getByText(en.list.draftFound)).toBeTruthy();           // 提示還在，沒有被清掉或換頁
  });

  it("草稿提示顯示時：標題／內文／工具列／Save 都鎖住，返回與預覽不鎖（review high finding，spec §7.6）", () => {
    saveDraft("/p", "01-a.md", { title: "草稿標題", body: "草稿內文", fingerprint: "f0" });
    const { onLeave } = setup();
    expect(screen.getByText(en.list.draftFound)).toBeTruthy();
    expect(titleBox().disabled).toBe(true);
    expect(bodyBox().disabled).toBe(true);
    expect(saveBtn().disabled).toBe(true);
    for (const tl of ["Heading", "Bold", "Inline code", "List", "Quote", "Code block"]) {
      expect((screen.getByLabelText(tl) as HTMLButtonElement).disabled).toBe(true);
    }
    const back = screen.getByText("p") as HTMLButtonElement;             // 返回列上的專案名
    expect(back.disabled).toBe(false);
    expect((screen.getByText(en.list.preview) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(back);
    expect(onLeave).toHaveBeenCalled();                                  // 返回真的可按、真的有效
  });

  it("草稿提示顯示時：即使程式化的 change 事件送達，舊草稿 B 撐過 debounce 視窗不被覆寫（review high finding；whole-branch review M4）", () => {
    // §7.6 硬性規定：只有存檔成功／按丟棄／自己刪票才可以清草稿，打字不算。
    // disabled 屬性擋得住點擊（已驗證過），但擋不住直接派送的 change 事件（jsdom 對受控輸入框
    // 就是會放行）——所以這裡刻意對著 disabled 的欄位發 fireEvent.change，模擬「萬一 UI 鎖
    // 被繞過」的情境，驗的是 onTitle/onBody 自己的 early return，不是畫面上的 disabled 而已。
    vi.useFakeTimers();
    saveDraft("/p", "01-a.md", { title: "草稿標題", body: "草稿內文", fingerprint: "f0" });
    setup();
    expect(screen.getByText(en.list.draftFound)).toBeTruthy();
    fireEvent.change(bodyBox(), { target: { value: "偷打的字" } });
    // 錨點：只驗 loadDraft 分不出「guard 真的擋下來」跟「change 事件根本沒送達」——兩種情況
    // localStorage 都不會被寫，斷言一樣綠（whole-branch review M4）。React 的受控輸入框只有
    // 在 onChange 真的被呼叫、而且沒有呼叫對應的 setState 時，才會在下一次 commit 把 DOM 的
    // 原始 value 拉回目前的 state；如果事件根本沒送達任何 listener，fireEvent.change 自己
    // 直接寫入 DOM 的 "偷打的字" 不會有任何東西把它拉回去，畫面會停在 "偷打的字"。
    // 實測驗證過兩種路徑：guarded → "舊內文"（React 拉回去了）；unguarded → "偷打的字"
    // （state 真的被改了，controlled value 因此變成新值）。所以這裡斷言拉回原文，
    // 證明的是「事件送達了、而且被 early return 擋下」，不是「什麼都沒發生」。
    expect(bodyBox().value).toBe("舊內文");
    vi.advanceTimersByTime(2000);                                        // 遠超過 600ms 的 debounce 視窗
    expect(loadDraft("/p", "01-a.md")).toEqual(
      expect.objectContaining({ title: "草稿標題", body: "草稿內文", fingerprint: "f0" }),
    );
    vi.useRealTimers();
  });

  it("接著改：解鎖編輯器，內容換成草稿 B（review high finding）", () => {
    saveDraft("/p", "01-a.md", { title: "草稿標題", body: "草稿內文", fingerprint: "f0" });
    setup();
    fireEvent.click(screen.getByText(en.list.draftResume));
    expect(titleBox().disabled).toBe(false);
    expect(bodyBox().disabled).toBe(false);
    expect(saveBtn().disabled).toBe(false);
    expect(titleBox().value).toBe("草稿標題");
    expect(bodyBox().value).toBe("草稿內文");
  });

  it("丟棄草稿：解鎖編輯器，內容維持檔案原本的內容（review high finding）", () => {
    saveDraft("/p", "01-a.md", { title: "草稿標題", body: "草稿內文", fingerprint: "f0" });
    setup();
    fireEvent.click(screen.getByText(en.list.draftDiscard));
    expect(titleBox().disabled).toBe(false);
    expect(bodyBox().disabled).toBe(false);
    expect(saveBtn().disabled).toBe(false);
    expect(titleBox().value).toBe("舊標題");
    expect(bodyBox().value).toBe("舊內文");
  });

  it("沒有草稿的票完全不鎖（回歸風險：整個改動最容易誤傷的情況）", () => {
    setup();
    expect(screen.queryByText(en.list.draftFound)).toBeNull();
    expect(screen.queryByText(en.list.draftStale)).toBeNull();
    expect(titleBox().disabled).toBe(false);
    expect(bodyBox().disabled).toBe(false);
    expect(saveBtn().disabled).toBe(false);
    expect((screen.getByLabelText(en.a11y.toolbarBold) as HTMLButtonElement).disabled).toBe(false);
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

  it("工具列：粗體把選取包起來，游標落在整段（含右邊記號）之後，且文字區真的拿到焦點", () => {
    setup();
    const box = bodyBox();
    fireEvent.change(box, { target: { value: "hello world" } });
    box.setSelectionRange(0, 5);
    fireEvent.click(screen.getByLabelText(en.a11y.toolbarBold));
    expect(box.value).toBe("**hello** world");
    expect(box.selectionStart).toBe(9);   // "**hello**".length
    expect(box.selectionEnd).toBe(9);
    // 點按鈕會把焦點從文字區移走；沒有焦點的欄位不顯示游標，offset 設對了使用者也看不到
    // （使用者回報：「符號有出來，但游標消失了」）——只驗 offset 抓不到這個，jsdom 對
    // 沒有焦點的欄位一樣讓你讀寫 selectionStart/End（whole-branch review 四輪 FIX）
    expect(document.activeElement).toBe(box);
  });

  it("工具列：粗體在沒有選取時，游標落在兩個記號中間，打字立刻是套了格式的內容，且文字區真的拿到焦點（whole-branch review 三輪 FIX 4；四輪補焦點）", () => {
    // 使用者回報：空選取按下去只會插入 **** 這種看得到、用不出來的字面符號，游標又落在
    // 整串最後面，接著打字變成 ****text，格式完全沒套用，而且不知道要先選字才能用
    setup();
    const box = bodyBox();
    fireEvent.change(box, { target: { value: "hello" } });
    box.setSelectionRange(5, 5);          // 游標在最後面，沒有選取任何字
    fireEvent.click(screen.getByLabelText(en.a11y.toolbarBold));
    expect(box.value).toBe("hello****");
    expect(box.selectionStart).toBe(7);   // "hello**" 之後，也就是兩個 * 中間
    expect(box.selectionEnd).toBe(7);
    expect(document.activeElement).toBe(box);   // 游標位置是對的，但沒有焦點就看不見
  });

  it("工具列剩六顆按鈕：斜體與連結已拿掉（使用者驗收——斜體可用但用不到；連結插入 [選取](url) 後 safeHref(\"url\") 解析不出協定，按了預覽不會出現連結）", () => {
    setup();
    expect(document.querySelectorAll(".ed-bar .ed-btn")).toHaveLength(6);
    expect(screen.queryByLabelText("Italic")).toBeNull();
    expect(screen.queryByLabelText("Link")).toBeNull();
  });

  it("預覽按鈕文字反映按下去會做什麼：編輯中顯示「Preview」，預覽中顯示「Back to editing」（whole-branch review 三輪 FIX 1）", () => {
    // 使用者回報：預覽中按鈕還是寫「預覽」，點下去卻是回編輯——文字與動作相反
    setup({ body: "b" });
    expect(screen.getByText(en.list.preview)).toBeTruthy();
    fireEvent.click(screen.getByText(en.list.preview));
    expect(screen.queryByText(en.list.preview)).toBeNull();
    expect(screen.getByText(en.list.backToEdit)).toBeTruthy();
    fireEvent.click(screen.getByText(en.list.backToEdit));
    expect(screen.getByText(en.list.preview)).toBeTruthy();
    expect(screen.queryByText(en.list.backToEdit)).toBeNull();
  });

  it("預覽切換顯示 render 後的內文", () => {
    setup({ body: "**b**" });
    fireEvent.click(screen.getByText(en.list.preview));
    expect(document.querySelector(".ed-preview strong")?.textContent).toBe("b");
  });

  it("複製我的內容成功 → 顯示已複製，且不吃掉 409 提示與〔捨棄我的版本，重新載入〕（task 10 review FIX 6；whole-branch review FIX 4）", async () => {
    // 複製曾經用 setNotice({key:"list.copied"}) 蓋掉 notice——notice 同時是 409 說明與
    // 「捨棄我的版本，重新載入」的容器，蓋掉就等於把 §7.5 復原流程的第二步一起端走。
    // 這個 repo 對孤兒草稿／救援複製已經各自修過一次同一種形狀，這是第三次（whole-branch review）
    updateTaskContent.mockRejectedValue(new TaskConflictError());
    writeClipboard.mockResolvedValue(true);
    setup();
    fireEvent.change(bodyBox(), { target: { value: "我的內容" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(en.list.conflictEditor)).toBeTruthy());
    fireEvent.click(screen.getByText(en.list.copyMine));
    expect(writeClipboard).toHaveBeenCalledWith("# 舊標題\n\n我的內容");
    await waitFor(() => expect(screen.getByText(en.list.copied)).toBeTruthy());
    // 複製後，衝突說明與捨棄按鈕都還在——不是被複製回饋整條換掉
    expect(screen.getByText(en.list.conflictEditor)).toBeTruthy();
    expect(screen.getByText(en.list.discardAndReload)).toBeTruthy();
  });

  it("〔複製我的內容〕在草稿存不進去（離開分支）的提示裡也不會吃掉〔仍要離開〕（whole-branch review 二輪 FIX 3：unsavable 分支的對稱測試）", async () => {
    // FIX 4 只驗了 notice／conflictEditor 分支；copied 這面旗標同樣蓋在 unsavable 那個
    // 提示條上（複製按鈕兩處共用），邏輯是對稱的，但這一半原本沒有測試釘住
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("q"); });
    writeClipboard.mockResolvedValue(true);
    setup();
    fireEvent.change(bodyBox(), { target: { value: "x" } });
    fireEvent.click(screen.getByText("p"));                              // 返回時 flush 失敗
    expect(screen.getByText(en.list.draftUnsavable)).toBeTruthy();
    fireEvent.click(screen.getByText(en.list.copyMine));
    expect(writeClipboard).toHaveBeenCalledWith("# 舊標題\n\nx");
    await waitFor(() => expect(screen.getByText(en.list.copied)).toBeTruthy());
    // 複製後，警告文字與〔仍要離開〕都還在——不是被複製回饋整條換掉
    expect(screen.getByText(en.list.draftUnsavable)).toBeTruthy();
    expect(screen.getByText(en.list.leaveAnyway)).toBeTruthy();
    spy.mockRestore();
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

  describe("leaveRequest（票 19，spec §5.7）", () => {
    it("值變大時走 leave()：草稿寫成功 → onLeave(false)", async () => {
      const onLeave = vi.fn();
      const { rerender } = render(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={() => {}} onLeave={onLeave} leaveRequest={0} t={t} />);
      fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "typed" } });
      rerender(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={() => {}} onLeave={onLeave} leaveRequest={1} t={t} />);
      await waitFor(() => expect(onLeave).toHaveBeenCalledWith(false));
      expect(loadDraft("/p", task().name)?.body).toBe("typed");
    });

    it("掛載時 leaveRequest 已經非零 → 不重播、不離開", async () => {
      const onLeave = vi.fn();
      render(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={() => {}} onLeave={onLeave} leaveRequest={3} t={t} />);
      await new Promise((r) => setTimeout(r, 0));
      expect(onLeave).not.toHaveBeenCalled();
      expect(screen.getByLabelText(en.list.editorBody)).toBeTruthy();
    });

    it("草稿寫不進去 → 不呼叫 onLeave，顯示複製與仍要離開；按仍要離開才走", async () => {
      const onLeave = vi.fn();
      // spy 在 localStorage 這個物件本身，不是 Storage.prototype——這個 repo 的 vitest.setup.ts
      // 換上的殼是純物件，setItem 是自身屬性，prototype 攔不到（見 lib/taskDraft.test.ts 的同一個註記）
      const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
      try {
        const { rerender } = render(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={() => {}} onLeave={onLeave} leaveRequest={0} t={t} />);
        fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "typed" } });
        rerender(<TaskEditor port={1} project="/p" projectName="p" task={task()} onSaved={() => {}} onLeave={onLeave} leaveRequest={1} t={t} />);
        await screen.findByText(en.list.leaveAnyway);
        expect(onLeave).not.toHaveBeenCalled();
        expect(screen.getByDisplayValue("typed")).toBeTruthy();        // 字還在
        fireEvent.click(screen.getByText(en.list.leaveAnyway));
        expect(onLeave).toHaveBeenCalledWith(false);
      } finally { setItem.mockRestore(); }
    });
  });
});

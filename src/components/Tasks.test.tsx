// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import { TaskConflictError, type TaskRow, type TasksListResponse, type TasksOverview } from "../lib/sidecar";
import { loadDraft, saveDraft } from "../lib/taskDraft";
import { Tasks } from "./Tasks";

const fetchTasksOverview = vi.fn<(port: number) => Promise<TasksOverview>>();
const fetchTasks = vi.fn<(port: number, project: string) => Promise<TasksListResponse>>();
const createTask = vi.fn<(port: number, project: string, title: string) => Promise<TaskRow>>();
const updateTask = vi.fn<(p: number, proj: string, name: string, status: string, fp: string) => Promise<TaskRow>>();
const deleteTask = vi.fn<(p: number, proj: string, name: string, fp: string) => Promise<void>>();
const openFile = vi.fn<(port: number, p: string) => Promise<{ status: string }>>();
const updateTaskContent = vi.fn<
  (p: number, proj: string, name: string, title: string, body: string, fp: string, signal?: AbortSignal) => Promise<TaskRow>
>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchTasksOverview: (port: number) => fetchTasksOverview(port),
  fetchTasks: (port: number, project: string) => fetchTasks(port, project),
  createTask: (port: number, project: string, title: string) => createTask(port, project, title),
  updateTask: (p: number, proj: string, n: string, st: string, fp: string) => updateTask(p, proj, n, st, fp),
  deleteTask: (p: number, proj: string, n: string, fp: string) => deleteTask(p, proj, n, fp),
  openFile: (port: number, path: string) => openFile(port, path),
  updateTaskContent: (p: number, proj: string, n: string, ti: string, bo: string, fp: string, sig?: AbortSignal) =>
    updateTaskContent(p, proj, n, ti, bo, fp, sig),
}));

// 孤兒草稿的複製走這支（回 boolean、不 throw），寫法沿用 TaskEditor.test.tsx 已驗證過的樣子。
const writeClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("../lib/clipboard", () => ({ writeClipboard: (t: string) => writeClipboard(t) }));

const proj = (over: Partial<TasksOverview["projects"][number]> = {}) => ({
  path: "/p/a", name: "a", account: "work", unfinished: 1, doing: 0,
  parked: 0, doing_tasks: [], recent_tasks: [],
  tasks_status: "ok" as const, next_step: "", ...over,
});
// 狀態按鈕的可及名稱是組出來的：「現在是什麼，點下去變什麼」
const statusLabel = (current: string, next: string) =>
  en.a11y.statusCycle.replace("{{current}}", current).replace("{{next}}", next);
const ticket = (over: Partial<TaskRow> = {}): TaskRow => ({
  name: "01-a.md", number: 1, title: "第一件", status: "todo", source: "me",
  created: "2026-08-29", anomalies: [], fingerprint: "f", path: "/p/a/.fledge/tasks/01-a.md",
  body: "", editable: true, ...over,
});

const tree = () => within(screen.getByTestId("tree"));
// 等樹上有那個專案名（初始總覽落地）→ 點 → 等專案頁的標題出現（清單落地）。不寫死等某張票的標題，
// 空清單／unavailable／不同 fixture 的測試都能用
const openProject = async (name = "a") => {
  fireEvent.click(await tree().findByText(name));
  await waitFor(() => expect(document.querySelector(".tasks-pane .tasks-head h1")?.textContent).toBe(name));
};

describe("Tasks 面板", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    localStorage.clear();   // 草稿住在 localStorage，測試之間不清會互相污染
    fetchTasksOverview.mockResolvedValue({ projects: [proj()], permission_error: false, recent_days: 7 });
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket()], next_step: "", handoff_command: "" });
    createTask.mockResolvedValue(ticket({ name: "02-b.md", number: 2, title: "新的" }));
    updateTask.mockResolvedValue(ticket({ status: "doing", fingerprint: "f2" }));
    deleteTask.mockResolvedValue(undefined);
    openFile.mockResolvedValue({ status: "ok" });
    updateTaskContent.mockResolvedValue(ticket({ fingerprint: "f2" }));
    writeClipboard.mockReset().mockResolvedValue(true);
  });
  afterEach(cleanup);   // vitest 未開 globals → testing-library 不會自動 cleanup

  it("分頁不在前景時不打 API；切到前景才讀", async () => {
    const { rerender } = render(<Tasks port={1234} isActive={false} />);
    expect(fetchTasksOverview).not.toHaveBeenCalled();
    rerender(<Tasks port={1234} isActive />);
    await waitFor(() => expect(fetchTasksOverview).toHaveBeenCalledTimes(1));
  });

  it("單一專案收到 unavailable 時畫成錯誤態，不是空清單", async () => {
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "unavailable", tasks: null, next_step: "", handoff_command: "" });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await waitFor(() => expect(screen.getByText(en.list.unavailable)).toBeTruthy());
    expect(screen.queryByText(en.list.empty)).toBeNull();   // 不得退化成「沒有待辦」
  });

  it("第二層：未完成在上、done 預設收起，展開才看得到", async () => {
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "", handoff_command: "",
      tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "做完的", status: "done", source: "ai" })],
    });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await waitFor(() => expect(screen.getByText("第一件")).toBeTruthy());
    expect(screen.queryByText("做完的")).toBeNull();                 // done 預設摺疊
    fireEvent.click(screen.getByLabelText(en.a11y.expandDone));
    expect(screen.getByText("做完的")).toBeTruthy();
    expect(screen.getByText(en.source.ai)).toBeTruthy();             // 來源標記
  });

  // 票 21：state.md 末尾的「貼進新對話的指令」。預設摺疊（只露第一行），展開才看全文
  const CMD = "第一句。\n\n第二句。\n\n第三句。";
  it("第二層：有指令段就出現區塊，預設摺疊、點內容框展開、再點收合", async () => {
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket()], next_step: "", handoff_command: CMD });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText(en.list.handoffLabel);
    const pre = screen.getByText((_, el) => el?.tagName === "PRE" && el.textContent === CMD);
    const box = pre.closest(".tasks-cmd")!;
    const row = pre.closest("[role=button]")!;                       // 跟票列同一套：整個框是按鈕
    expect(box.classList.contains("is-folded")).toBe(true);           // 全文在 DOM 裡，靠樣式只露第一行
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(box.classList.contains("is-folded")).toBe(false);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    expect(box.classList.contains("is-folded")).toBe(true);
    expect(screen.queryByText("Expand")).toBeNull();                   // 沒有另外的「展開」文字
  });

  it("第二層：指令框可用鍵盤展開（Enter／空白鍵）", async () => {
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket()], next_step: "", handoff_command: CMD });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText(en.list.handoffLabel);
    const row = screen.getByText((_, el) => el?.tagName === "PRE" && el.textContent === CMD).closest("[role=button]")!;
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(row, { key: " " });
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("第二層：框尾的複製圖示把整段指令寫進剪貼簿、圖示變成已複製，且不會連帶展開", async () => {
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket()], next_step: "", handoff_command: CMD });
    writeClipboard.mockResolvedValue(true);
    render(<Tasks port={1234} isActive />);
    await openProject();
    const copy = await screen.findByLabelText(en.list.handoffCopy);   // 圖示鈕，只有可及名稱沒有文字
    expect(copy.textContent).toBe("");
    fireEvent.click(copy);
    expect(writeClipboard).toHaveBeenCalledWith(CMD);                 // 摺疊時也複製全文，不是露出的那一行
    await waitFor(() => expect(screen.getByLabelText(en.list.copied)).toBeTruthy());
    const box = copy.closest(".tasks-cmd")!;
    expect(box.classList.contains("is-folded")).toBe(true);           // 點圖示不能把框展開（stopPropagation）
  });

  it("第二層：沒有指令段就整塊不出現", async () => {
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket()], next_step: "有下一步", handoff_command: "" });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("有下一步");
    expect(screen.queryByText(en.list.handoffLabel)).toBeNull();
    expect(screen.queryByText(en.list.handoffCopy)).toBeNull();
  });

  // A1：未完成拆成「進行中／待辦」兩區，進行中永遠浮在最上面；空的區整段不畫
  it("四區分組：進行中在待辦之上，擱置預設收起，沒有進行中時不留空標頭", async () => {
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "", handoff_command: "",
      tasks: [
        ticket({ name: "01-a.md", number: 1, title: "待做的", status: "todo" }),
        ticket({ name: "02-b.md", number: 2, title: "在做的", status: "doing" }),
        ticket({ name: "03-c.md", number: 3, title: "擱置的", status: "parked" }),
      ],
    });
    const { container, rerender } = render(<Tasks port={1234} isActive />);
    await openProject();
    await waitFor(() => expect(screen.getByText("在做的")).toBeTruthy());
    // 後端給的順序是 01 在前，畫面上必須是「在做的」先出現——分組有真的改變排序。
    // 擱置區預設收起：標頭在、票不在
    const titles = [...container.querySelectorAll(".tk-title")].map((n) => n.textContent);
    expect(titles).toEqual(["在做的", "待做的"]);
    expect(screen.getByText(en.list.doing)).toBeTruthy();
    expect(screen.getByLabelText(en.a11y.expandParked)).toBeTruthy();
    expect(screen.queryByText("擱置的")).toBeNull();

    // 沒有 doing 的票時，「進行中」整段不該出現（留一個 0 的標頭只是噪音）
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "", handoff_command: "",
      tasks: [ticket({ title: "只有待辦", status: "todo" })],
    });
    rerender(<Tasks port={1234} isActive={false} />);
    rerender(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("只有待辦")).toBeTruthy());
    expect(screen.queryByText(en.list.doing)).toBeNull();
  });

  // B1：created 後端本來就回，畫成月-日。認不得的格式一律不畫，不做猜測性切字
  it("日期畫成月-日；認不得的 created 不畫", async () => {
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "", handoff_command: "",
      tasks: [
        ticket({ name: "01-a.md", title: "有日期", created: "2026-08-29" }),
        ticket({ name: "02-b.md", number: 2, title: "壞日期", created: "2026/08/29" }),
      ],
    });
    const { container } = render(<Tasks port={1234} isActive />);
    await openProject();
    await waitFor(() => expect(screen.getByText("有日期")).toBeTruthy());
    expect([...container.querySelectorAll(".tk-date")].map((n) => n.textContent)).toEqual(["08-29"]);
  });

  // design §6.2：「異常」不是「隱藏」——票照常出現，點記號才說明哪裡不對
  it("異常票照常顯示，點記號展開檔名與原因", async () => {
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "", handoff_command: "",
      tasks: [ticket({ name: "壞的.md", number: null, title: "壞的", anomalies: ["number_missing", "status_invalid"] })],
    });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await waitFor(() => expect(screen.getByText("壞的")).toBeTruthy());   // 沒有被隱藏
    fireEvent.click(screen.getByLabelText(en.anomaly.label));
    expect(screen.getByText("壞的.md")).toBeTruthy();
    expect(screen.getByText(en.anomaly.number_missing)).toBeTruthy();
    expect(screen.getByText(en.anomaly.status_invalid)).toBeTruthy();
  });

  // design §5.2：一行輸入建票。source/status/created 都由 sidecar 決定，前端只送標題。
  it("打字送出會建票並重讀清單", async () => {
    render(<Tasks port={1234} isActive />);
    await openProject();
    const input = await screen.findByLabelText(en.list.newPlaceholder);
    fireEvent.change(input, { target: { value: "  新的一件事  " } });
    fireEvent.click(screen.getByText(en.list.add));

    await waitFor(() => expect(createTask).toHaveBeenCalledWith(1234, "/p/a", "新的一件事"));
    await waitFor(() => expect(fetchTasks).toHaveBeenCalledTimes(2));   // 建完重讀
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("空白標題不送出", async () => {
    render(<Tasks port={1234} isActive />);
    await openProject();
    const input = await screen.findByLabelText(en.list.newPlaceholder);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("建票失敗顯示錯誤，不清空使用者打的字", async () => {
    createTask.mockRejectedValue(new Error("400"));
    render(<Tasks port={1234} isActive />);
    await openProject();
    const input = await screen.findByLabelText(en.list.newPlaceholder);
    fireEvent.change(input, { target: { value: "會失敗的" } });
    fireEvent.click(screen.getByText(en.list.add));
    await waitFor(() => expect(screen.getByText(en.list.createError)).toBeTruthy());
    expect((input as HTMLInputElement).value).toBe("會失敗的");
  });

  // ── T4：切狀態、刪除、開編輯器、衝突偵測 ──────────────────

  async function openList() {
    render(<Tasks port={1234} isActive />);
    await openProject();
    await waitFor(() => expect(screen.getByText("第一件")).toBeTruthy());
  }

  it("點狀態循環到下一個狀態，並帶該票的 fingerprint", async () => {
    await openList();
    fireEvent.click(screen.getByLabelText(statusLabel(en.status.todo, en.status.doing)));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(1234, "/p/a", "01-a.md", "doing", "f"));
    // 斷言記號按鈕本身的 title，不是 getByText——後者會命中「進行中」分區標頭而不是這張票
    await waitFor(() => expect(screen.getByTitle(en.status.doing)).toBeTruthy());
  });

  // design §7.2：成功回應要帶回新 fingerprint、前端要用它取代本地狀態，
  // 否則第二次操作會被錯誤地判成 409。單次點擊的測試抓不到這個。
  it("連續兩次切狀態，第二次用的是回傳的新 fingerprint", async () => {
    await openList();
    fireEvent.click(screen.getByLabelText(statusLabel(en.status.todo, en.status.doing)));
    await waitFor(() => expect(screen.getByTitle(en.status.doing)).toBeTruthy());

    updateTask.mockResolvedValue(ticket({ status: "done", fingerprint: "f3" }));
    // 這時票已經是 doing，按鈕的可及名稱跟著變成「進行中，切換成已完成」
    fireEvent.click(screen.getByLabelText(statusLabel(en.status.doing, en.status.done)));
    await waitFor(() => expect(updateTask).toHaveBeenLastCalledWith(1234, "/p/a", "01-a.md", "done", "f2"));
  });

  // Codex 審查 medium：aria-label 會蓋掉 title 與按鈕內文，只寫「切換狀態」
  // 等於報讀使用者完全聽不出這張票的狀態。名稱必須帶現在的狀態與按下去的結果。
  it("狀態按鈕的可及名稱帶得出目前狀態與下一個狀態", async () => {
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "", handoff_command: "",
      tasks: [
        ticket({ name: "01-a.md", title: "待辦的", status: "todo" }),
        ticket({ name: "02-b.md", number: 2, title: "在做的", status: "doing" }),
        ticket({ name: "03-c.md", number: 3, title: "做完的", status: "done" }),
      ],
    });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await waitFor(() => expect(screen.getByText("在做的")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(en.a11y.expandDone));

    expect(screen.getByLabelText(statusLabel(en.status.todo, en.status.doing))).toBeTruthy();
    expect(screen.getByLabelText(statusLabel(en.status.doing, en.status.done))).toBeTruthy();
    expect(screen.getByLabelText(statusLabel(en.status.done, en.status.todo))).toBeTruthy();

    // 同一條 finding 的另一半：三態不能只差顏色。done 畫勾（有 svg），
    // todo 與 doing 是 CSS 方框（沒有 svg）——輪廓不同，單色顯示下也分得開。
    const glyph = (cls: string) =>
      document.querySelector(`.tk-mark.${cls}`)!.querySelector("svg");
    expect(glyph("is-done")).toBeTruthy();
    expect(glyph("is-todo")).toBeNull();
    expect(glyph("is-doing")).toBeNull();
  });

  // Codex 第三輪 medium（main 上就有的既有缺陷）：沒有 in-flight 鎖時，連點兩下會用
  // **同一個 fingerprint** 送兩次 PATCH，第二次必然被判 stale → 使用者什麼都沒做錯卻
  // 看到「這張票已被改過」。上面那條「連續兩次」測試是等第一次回應才點，照不到這個。
  it("第一次改狀態還在路上時，再點不會送出第二個請求", async () => {
    let release!: (t: TaskRow) => void;
    updateTask.mockImplementation(() => new Promise<TaskRow>((res) => { release = res; }));
    await openList();

    const btn = screen.getByLabelText(statusLabel(en.status.todo, en.status.doing));
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(en.list.conflict)).toBeNull();   // 不該冒出衝突訊息

    // 回應到了就要放行，鎖不能卡住後續操作
    release(ticket({ status: "doing", fingerprint: "f2" }));
    await waitFor(() => expect(screen.getByTitle(en.status.doing)).toBeTruthy());
    updateTask.mockResolvedValue(ticket({ status: "done", fingerprint: "f3" }));
    fireEvent.click(screen.getByLabelText(statusLabel(en.status.doing, en.status.done)));
    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(2));
  });

  it("收到 409 顯示已被改過並重新載入", async () => {
    updateTask.mockRejectedValue(new TaskConflictError());
    await openList();
    fireEvent.click(screen.getByLabelText(statusLabel(en.status.todo, en.status.doing)));
    await waitFor(() => expect(screen.getByText(en.list.conflict)).toBeTruthy());
    await waitFor(() => expect(fetchTasks).toHaveBeenCalledTimes(2));
  });

  // design §5.2：刪除先跳確認——檔案直接消失，而 .fledge/ 不進 git，救不回
  it("刪除確認選取消，不得送出 DELETE", async () => {
    await openList();
    fireEvent.click(screen.getByLabelText(en.list.delete));
    expect(screen.getByText(en.list.confirmDelete)).toBeTruthy();
    fireEvent.click(screen.getByText(en.list.cancel));
    expect(deleteTask).not.toHaveBeenCalled();
    expect(screen.queryByText(en.list.confirmDelete)).toBeNull();
  });

  it("刪除確認選刪除才真的送出，並重新載入", async () => {
    await openList();
    fireEvent.click(screen.getByLabelText(en.list.delete));
    // 確認框裡的「刪除」按鈕與列上的 icon 同字，取確認框內那顆
    const yes = screen.getByText(en.list.confirmDelete).parentElement!.querySelector(".tk-confirm-yes")!;
    fireEvent.click(yes);
    await waitFor(() => expect(deleteTask).toHaveBeenCalledWith(1234, "/p/a", "01-a.md", "f"));
    await waitFor(() => expect(fetchTasks).toHaveBeenCalledTimes(2));
  });

  // 票 01 起走 sidecar 的 /api/open，不再用 Tauri 的 openPath——
  // capability 的白名單已移除，改回去會被拒
  it("用編輯器打開走 sidecar 給的絕對路徑，前端不拼路徑", async () => {
    await openList();
    fireEvent.click(screen.getByLabelText(en.a11y.openInEditor));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith(1234, "/p/a/.fledge/tasks/01-a.md"));
  });

  // sidecar 擋下來（403）或檔案不見時 fetch 本身是成功的，只有 status 不是 ok。
  // 不看 status 的話使用者點了完全沒反應，也不知道為什麼
  it("sidecar 回非 ok 的 status 時顯示錯誤，不是靜靜沒反應", async () => {
    openFile.mockResolvedValue({ status: "forbidden" });
    await openList();
    fireEvent.click(screen.getByLabelText(en.a11y.openInEditor));
    await waitFor(() => expect(screen.getByText(en.list.actionError)).toBeTruthy());
  });

  // ── 展開預覽 ＋ 編輯入口（spec §6.1）──

  // 迴歸測試（review fix 1）：keydown 冒泡到 tk-row 途中，若列不分辨事件來源就無條件
  // preventDefault，會連巢狀按鈕自己的合成 click 都一起取消掉——鍵盤使用者 Tab 到
  // 狀態記號／旗標／編輯／開檔／刪除任一顆，按 Enter 都會被列吃掉，只選取整列。
  // fireEvent.keyDown 在 jsdom 不會像真實瀏覽器一樣合成出 click，所以斷言按鈕動作
  // 真的被觸發是測不出來的（那是在測 jsdom，不是測我們的程式碼）；這裡斷言的是
  // 觀察得到、且正是缺陷本體的那件事——列沒有被誤選取。
  it("鍵盤在狀態記號按鈕上按 Enter 不會誤觸列選取", async () => {
    await openList();
    const btn = screen.getByLabelText(statusLabel(en.status.todo, en.status.doing));
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(document.querySelector(".tk-row.active")).toBeNull();
  });

  it.each([
    ["明確 false", { editable: false }],
    ["缺欄", { editable: undefined as unknown as boolean }],
    ["非布林", { editable: "yes" as unknown as boolean }],
  ])("editable 是 %s 時不顯示編輯按鈕", async (_, over) => {
    // 「不可編輯」的說明文字隨展開內文一起搬到右欄（Task 8），這裡只守清單側的 fail-safe：沒有編輯入口
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", next_step: "", handoff_command: "", tasks: [ticket(over)] });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    expect(screen.queryByLabelText(en.list.edit)).toBeNull();
  });

  it("editable 為 true 時有編輯按鈕", async () => {
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    expect(screen.getByLabelText(en.list.edit)).toBeTruthy();
  });

  // ── 第三層導覽（spec §6.2）──

  it("點編輯進編輯器；儲存後回清單且那張票反白、fingerprint 已更新", async () => {
    updateTaskContent.mockResolvedValue(ticket({ title: "改過", fingerprint: "f9", body: "新內文" }));
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    fireEvent.click(screen.getByLabelText(en.list.edit));
    await screen.findByLabelText(en.list.editorTitle);
    fireEvent.change(screen.getByLabelText(en.list.editorTitle), { target: { value: "改過" } });
    fireEvent.click(screen.getByText(en.list.save));
    await screen.findByText("改過");                                   // 回到清單
    expect(document.querySelector(".tk-row.active")).toBeTruthy();     // 那張票反白（右欄正在顯示它）
    // 下一次操作用新 fingerprint
    fireEvent.click(screen.getByLabelText(statusLabel(en.status.todo, en.status.doing)));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(1234, "/p/a", "01-a.md", "doing", "f9"));
  });

  it("編輯中切走再切回，不重讀、內容不被蓋掉", async () => {
    const { rerender } = render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    fireEvent.click(screen.getByLabelText(en.list.edit));
    const box = await screen.findByLabelText(en.list.editorBody);
    fireEvent.change(box, { target: { value: "打到一半" } });
    const calls = fetchTasks.mock.calls.length;
    rerender(<Tasks port={1234} isActive={false} />);
    rerender(<Tasks port={1234} isActive />);
    fireEvent(window, new Event("focus"));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchTasks.mock.calls.length).toBe(calls);
    expect((screen.getByLabelText(en.list.editorBody) as HTMLTextAreaElement).value).toBe("打到一半");
  });

  // 樹掛在編輯器旁邊之後多了一條路：編輯 A 的票時點樹上的 B，select() 不清 editing，
  // 編輯器會以 project="/p/b" 重掛、存檔與草稿都落到 B。過渡期先讓樹在編輯中不動作，
  // 不從樹呼叫 leaveEditor／setEditing(null)——那會繞過 TaskEditor.leave()（Codex R1 的保護）
  it("過渡期：編輯中點樹上的另一個專案不動作（Task 9 換成編輯器離開流程）", async () => {
    fetchTasksOverview.mockResolvedValue({ projects: [proj(), proj({ path: "/p/b", name: "b" })], permission_error: false, recent_days: 7 });
    render(<Tasks port={1234} isActive />);
    await openProject();
    fireEvent.click(screen.getByLabelText(en.list.edit));
    await screen.findByLabelText(en.list.editorBody);
    const listCalls = fetchTasks.mock.calls.length;
    fireEvent.click(tree().getByText("b"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByLabelText(en.list.editorBody)).toBeTruthy();      // 編輯器還在
    expect(fetchTasks).toHaveBeenCalledTimes(listCalls);                 // 沒有切到 b
    expect(tree().getByText("a").closest(".tree-item")?.classList.contains("active")).toBe(true);
  });

  // 票檔名在專案之間會撞名（每個專案都有 01-*.md）：選中的票名是父層 state，
  // 不隨 Ticket 重新 mount 而重置，切專案時要自己清掉，否則 B 的同名票會無端反白。
  it("切專案後選中狀態重置，不會讓另一個專案撞名的票無端反白", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [proj({ path: "/p/a", name: "a" }), proj({ path: "/p/b", name: "b" })],
      permission_error: false, recent_days: 7,
    });
    fetchTasks.mockImplementation((_port: number, project: string) =>
      Promise.resolve({ project, tasks_status: "ok" as const, next_step: "", handoff_command: "", tasks: [ticket({ name: "01-a.md" })] }));
    render(<Tasks port={1234} isActive />);
    await openProject();
    const row = await screen.findByText("第一件");
    fireEvent.click(row);                                       // 選中 A 的 01-a.md
    await waitFor(() => expect(document.querySelector(".tk-row.active")).toBeTruthy());
    fireEvent.click(tree().getByText(en.tree.allProjects));             // 返回總覽
    await openProject("b");                                      // 進 B（同樣有 01-a.md）
    await screen.findByText("第一件");
    expect(document.querySelector(".tk-row.active")).toBeNull();
  });

  it("孤兒草稿：票不在清單裡時列在頂端，可丟棄", async () => {
    saveDraft("/p/a", "99-gone.md", { title: "消失的", body: "b", fingerprint: "f" });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText(/消失的/);
    fireEvent.click(screen.getAllByText(en.list.draftDiscard)[0]);
    await waitFor(() => expect(loadDraft("/p/a", "99-gone.md")).toBeNull());
  });

  // 孤兒草稿旁邊就是不可回復的丟棄按鈕；writeClipboard 永不 throw，失敗只會 console.warn，
  // 呼叫端不接回傳值就是「使用者以為存到剪貼簿了，其實沒有」——這兩條把兩個分支都釘住。
  it("孤兒草稿：複製成功顯示已複製", async () => {
    writeClipboard.mockResolvedValue(true);
    saveDraft("/p/a", "99-gone.md", { title: "消失的", body: "b", fingerprint: "f" });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText(/消失的/);
    fireEvent.click(screen.getAllByText(en.list.copyMine)[0]);
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith("# 消失的\n\nb"));
    await waitFor(() => expect(screen.getByText(en.list.copied)).toBeTruthy());
  });

  it("孤兒草稿：複製失敗（writeClipboard 回 false）不顯示已複製", async () => {
    writeClipboard.mockResolvedValue(false);
    saveDraft("/p/a", "99-gone.md", { title: "消失的", body: "b", fingerprint: "f" });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText(/消失的/);
    fireEvent.click(screen.getAllByText(en.list.copyMine)[0]);
    await waitFor(() => expect(writeClipboard).toHaveBeenCalled());
    expect(screen.queryByText(en.list.copied)).toBeNull();
  });

  // 那個 .filter(...) 才是孤兒草稿功能本體：草稿對應的票還活著的話不該被宣告成孤兒。
  // 拿掉它這條測試會變紅（其餘七條的草稿都剛好已經是孤兒，擋不住這個回歸）。
  it("草稿對應的票還在清單裡時不算孤兒，不顯示孤兒草稿列", async () => {
    saveDraft("/p/a", "01-a.md", { title: "第一件", body: "改到一半", fingerprint: "f" });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    expect(document.querySelector(".tk-banner.is-draft")).toBeNull();
  });

  // tasks_status absent 時 list.tasks 是空陣列（不是 null）——naive 比對會讓草稿被判成
  // 「票已經不在了」的孤兒，配上一鍵不可逆的〔丟棄草稿〕；spec §7.4 明講 absent 跟
  // unavailable 要同一套待遇：現在讀不到，草稿留著，不做任何清除（whole-branch review M3）
  it("tasks_status absent 時草稿不被當成孤兒，不出現一鍵不可逆的丟棄鍵", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [proj({ tasks_status: "absent", unfinished: 0 })], permission_error: false, recent_days: 7,
    });
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "absent", tasks: [], next_step: "", handoff_command: "" });
    saveDraft("/p/a", "01-a.md", { title: "還沒送出的草稿", body: "b", fingerprint: "f" });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await waitFor(() => expect(screen.getByText(en.list.empty)).toBeTruthy());
    expect(document.querySelector(".tk-banner.is-draft")).toBeNull();
    expect(screen.queryByText(/還沒送出的草稿/)).toBeNull();
    expect(screen.queryByText(en.list.draftDiscard)).toBeNull();
    expect(loadDraft("/p/a", "01-a.md")).not.toBeNull();   // 沒被清掉——只是沒被畫成孤兒
  });

  it("離開後重進再送：V1 的晚到 200 不干擾 V2 的 409 畫面（spec §10.2）", async () => {
    // V1 送出 → 離開 → 重進改成 B → 送 V2 得 409 → V1 的 200 之後才到 → B 仍在編輯區、409 提示仍在
    let resolveV1!: (r: TaskRow) => void;
    updateTaskContent
      .mockImplementationOnce(() => new Promise((r) => { resolveV1 = r; }))
      .mockRejectedValueOnce(new TaskConflictError());
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    fireEvent.click(screen.getByLabelText(en.list.edit));
    fireEvent.change(await screen.findByLabelText(en.list.editorBody), { target: { value: "V1" } });
    fireEvent.click(screen.getByText(en.list.save));
    await waitFor(() => expect(updateTaskContent).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("a", { selector: ".full-back" }));   // 離開（abort V1）——樹上也有 "a"，限定編輯器的返回鍵
    await screen.findByText("第一件");
    fireEvent.click(screen.getByLabelText(en.list.edit));                // 重進
    fireEvent.click(await screen.findByText(en.list.draftDiscard));       // 不要 V1 的草稿
    fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "B" } });
    fireEvent.click(screen.getByText(en.list.save));                     // V2 → 409
    await screen.findByText(en.list.conflictEditor);
    resolveV1(ticket({ fingerprint: "f1" }));                             // V1 晚到
    await new Promise((r) => setTimeout(r, 0));
    expect((screen.getByLabelText(en.list.editorBody) as HTMLTextAreaElement).value).toBe("B");
    expect(screen.getByText(en.list.conflictEditor)).toBeTruthy();
  });

  // 這條原本叫「換票時編輯器 remount」，但重掛是型別切換（TaskEditor → TasksList → TaskEditor）
  // 保證的，跟 TaskEditor 上那把 key 無關——本任務的紅證明已經驗過：拿掉 key 這條測試仍是綠的。
  // 名字改成它真正驗的行為；三個斷言仍然都有價值：B 顯示 B 自己的內容、不誤讀 A 的草稿提示、
  // A 的草稿仍留在 A 自己的鍵下（順帶驗證了上一個任務的「一般離開也要 flush」）。
  it("換票後編輯器顯示 B 的內容與草稿提示，不承接 A 的（plan R3 F2）", async () => {
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", next_step: "", handoff_command: "", tasks: [
      ticket({ name: "01-a.md", title: "A", body: "A 的內文" }),
      ticket({ name: "02-b.md", number: 2, title: "B", body: "B 的內文" }),
    ] });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("A");
    fireEvent.click(screen.getAllByLabelText(en.list.edit)[0]);          // 進 A
    fireEvent.change(await screen.findByLabelText(en.list.editorBody), { target: { value: "A 打了字" } });
    fireEvent.click(screen.getByText("a", { selector: ".full-back" }));   // 返回
    await screen.findByText("B");
    fireEvent.click(screen.getAllByLabelText(en.list.edit)[1]);          // 進 B
    expect((await screen.findByLabelText(en.list.editorBody) as HTMLTextAreaElement).value).toBe("B 的內文");
    expect(screen.queryByText(en.list.draftFound)).toBeNull();           // 不讀 A 的草稿
    expect(loadDraft("/p/a", "01-a.md")?.body).toBe("A 打了字");         // A 的草稿在 A
  });

  it("捨棄版本重載：清單進 loading，重讀完才有編輯按鈕（plan R2 F4）", async () => {
    updateTaskContent.mockRejectedValue(new TaskConflictError());
    let resolveList!: (l: TasksListResponse) => void;
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    fireEvent.click(screen.getByLabelText(en.list.edit));
    fireEvent.change(await screen.findByLabelText(en.list.editorBody), { target: { value: "x" } });
    fireEvent.click(screen.getByText(en.list.save));
    await screen.findByText(en.list.conflictEditor);
    fetchTasks.mockReturnValueOnce(new Promise((r) => { resolveList = r; }));
    fireEvent.click(screen.getByText(en.list.discardAndReload));
    await screen.findByText(en.overview.loading);                       // 清單進 loading
    expect(screen.queryByLabelText(en.list.edit)).toBeNull();            // 沒有編輯按鈕可按
    resolveList({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ fingerprint: "NEW" })], next_step: "", handoff_command: "" });
    await screen.findByText("第一件");
    expect(screen.getByLabelText(en.list.edit)).toBeTruthy();
  });

  it("使用者自己刪票時草稿一併清掉", async () => {
    saveDraft("/p/a", "01-a.md", { title: "t", body: "b", fingerprint: "f" });
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    fireEvent.click(screen.getByLabelText(en.list.delete));
    fireEvent.click(screen.getByText(en.list.delete, { selector: ".tk-confirm-yes" }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalled());
    expect(loadDraft("/p/a", "01-a.md")).toBeNull();
  });
});

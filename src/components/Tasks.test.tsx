// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import { TaskConflictError, type TaskRow, type TasksListResponse, type TasksNote, type TasksOverview } from "../lib/sidecar";
import { loadDraft, saveDraft } from "../lib/taskDraft";
import { Tasks } from "./Tasks";

const fetchTasksOverview = vi.fn<(port: number) => Promise<TasksOverview>>();
const fetchTasks = vi.fn<(port: number, project: string) => Promise<TasksListResponse>>();
const createTask = vi.fn<(port: number, project: string, title: string) => Promise<TaskRow>>();
const updateTask = vi.fn<(p: number, proj: string, name: string, status: string, fp: string) => Promise<TaskRow>>();
const deleteTask = vi.fn<(p: number, proj: string, name: string, fp: string) => Promise<void>>();
const openFile = vi.fn<(port: number, p: string) => Promise<{ status: string }>>();
const fetchTasksNote = vi.fn<(port: number, project: string) => Promise<TasksNote>>();
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
  fetchTasksNote: (port: number, project: string) => fetchTasksNote(port, project),
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
    fetchTasksNote.mockResolvedValue({ status: "ok", content: "# note", mtime: "2026-09-14", path: "/p/a/.fledge/state.md", fingerprint: "n1", editable: true });
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
    // 改狀態不就地更新（Codex R5）：畫面變 doing 靠的是寫入後的重讀，mock 要回已改過的那張
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ status: "doing", fingerprint: "f2" })], next_step: "", handoff_command: "" });
    fireEvent.click(screen.getByLabelText(statusLabel(en.status.todo, en.status.doing)));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(1234, "/p/a", "01-a.md", "doing", "f"));
    // 斷言記號按鈕本身的 title，不是 getByText——後者會命中「進行中」分區標頭而不是這張票
    await waitFor(() => expect(screen.getByTitle(en.status.doing)).toBeTruthy());
  });

  // design §7.2：第二次操作不得帶過期 fingerprint。改狀態不就地更新（Codex R5），
  // 新 fingerprint 只能由寫入後的重讀帶回來；單次點擊的測試抓不到這個。
  it("連續兩次切狀態，第二次用的是重讀帶回的新 fingerprint", async () => {
    await openList();
    // 寫入成功後會重讀（D12）：mock 要回已改過的那張——這條 GET 就是畫面與 fingerprint 的唯一來源
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ status: "doing", fingerprint: "f2" })], next_step: "", handoff_command: "" });
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
    // 同上：放行後的重讀要回已改過的那張——doing→done 那顆按鈕只會在重讀落地後出現（不就地更新）
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ status: "doing", fingerprint: "f2" })], next_step: "", handoff_command: "" });

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

  it("點編輯進編輯器；儲存後右欄回到票檢視且那張票反白、fingerprint 已更新", async () => {
    updateTaskContent.mockResolvedValue(ticket({ title: "改過", fingerprint: "f9", body: "新內文" }));
    render(<Tasks port={1234} isActive />);
    await openProject();
    await screen.findByText("第一件");
    fireEvent.click(screen.getByLabelText(en.list.edit));
    await screen.findByLabelText(en.list.editorTitle);
    fireEvent.change(screen.getByLabelText(en.list.editorTitle), { target: { value: "改過" } });
    // 儲存後會重讀一次：mock 要回已儲存的版本，否則 GET 會把舊 fingerprint 蓋回來
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ title: "改過", fingerprint: "f9", body: "新內文" })], next_step: "", handoff_command: "" });
    fireEvent.click(screen.getByText(en.list.save));
    await waitFor(() => expect(document.querySelector(".tasks-col-detail .d-title")?.textContent).toBe("改過"));   // 右欄回到票檢視
    expect(document.querySelector(".tk-row.active")).toBeTruthy();     // 那張票反白（右欄正在顯示它）
    // 下一次操作用新 fingerprint（清單與右欄各有一顆狀態鍵，限定清單那顆）
    fireEvent.click(within(document.querySelector(".tasks-col-list") as HTMLElement).getByLabelText(statusLabel(en.status.todo, en.status.doing)));
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
    // 離開（abort V1）：V1 還在路上時 saving 為 true，頁尾的「取消」是 disabled 的，只有返回鍵按得下去；
    // 專案名會同時命中樹、清單標題、返回鍵，用 .full-back 限定編輯器的返回鍵
    fireEvent.click(screen.getByText("a", { selector: ".full-back" }));
    const detail = () => document.querySelector(".tasks-col-detail") as HTMLElement;
    await within(detail()).findByText("第一件");                          // 右欄回到票檢視
    fireEvent.click(within(detail()).getByLabelText(en.list.edit));      // 重進（清單與右欄各有一顆編輯鍵）
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
    fireEvent.click(within(document.querySelector(".lb-detail.is-editing") as HTMLElement).getByText(en.list.cancel));   // 返回
    fireEvent.click(await screen.findByText("B"));                       // 清單點第二張票 → 右欄顯示 B
    fireEvent.click(within(document.querySelector(".tasks-col-detail") as HTMLElement).getByLabelText(en.list.edit));   // 右欄的編輯鍵 → 進 B
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
    // setList(null) 後清單與右欄都顯示載入中，同一個字串會雙重匹配——限定清單欄；編輯鍵限定右欄
    const list = () => document.querySelector(".tasks-col-list") as HTMLElement;
    const detail = () => document.querySelector(".tasks-col-detail") as HTMLElement;
    await within(list()).findByText(en.overview.loading);               // 清單進 loading
    expect(within(detail()).queryByLabelText(en.list.edit)).toBeNull();  // 沒有編輯按鈕可按
    resolveList({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ fingerprint: "NEW" })], next_step: "", handoff_command: "" });
    await within(list()).findByText("第一件");
    expect(within(detail()).getByLabelText(en.list.edit)).toBeTruthy();
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

  describe("導覽狀態機（spec §5.7）", () => {
    it("初始：樹＋所有專案頁；總覽與清單分兩條抓，切專案才抓清單", async () => {
      render(<Tasks port={1234} isActive />);
      await waitFor(() => expect(fetchTasksOverview).toHaveBeenCalledTimes(1));
      expect(fetchTasks).not.toHaveBeenCalled();
      expect(screen.getByText(en.overview.doingAll)).toBeTruthy();
      await openProject();
      expect(fetchTasks).toHaveBeenCalledWith(1234, "/p/a");
      expect(document.querySelector(".tasks-split")?.getAttribute("data-pane")).toBe("none");
    });

    it("點列＝右欄顯示那張票、data-pane=open；再點同一張＝關", async () => {
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ body: "the body" })], next_step: "", handoff_command: "" });
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByText("第一件"));
      expect(document.querySelector(".tasks-col-detail .d-title")?.textContent).toBe("第一件");
      expect(screen.getByText("the body")).toBeTruthy();
      expect(document.querySelector(".tasks-split")?.getAttribute("data-pane")).toBe("open");
      fireEvent.click(screen.getByText("第一件", { selector: ".tk-title" }));
      expect(document.querySelector(".d-title")).toBeNull();
      expect(document.querySelector(".tasks-split")?.getAttribute("data-pane")).toBe("none");
    });

    it("所有專案頁點票＝切專案＋右欄顯示那張票；右欄用清單那份資料畫", async () => {
      fetchTasksOverview.mockResolvedValue({ projects: [proj({ doing_tasks: [ticket({ status: "doing", body: "from overview" })] })], permission_error: false, recent_days: 7 });
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ status: "doing", body: "from list" })], next_step: "", handoff_command: "" });
      render(<Tasks port={1234} isActive />);
      fireEvent.click(await screen.findByText("第一件"));
      await screen.findByText("from list");
      expect(screen.queryByText("from overview")).toBeNull();
      expect(fetchTasks).toHaveBeenCalledWith(1234, "/p/a");
    });

    it("點下一步＝右欄顯示離場筆記（打 fetchTasksNote）；再點＝關；點票＝換成票", async () => {
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket()], next_step: "do x", handoff_command: "" });
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByLabelText(en.a11y.showNote));
      await screen.findByText(en.detail.noteTitle);
      expect(fetchTasksNote).toHaveBeenCalledWith(1234, "/p/a");
      fireEvent.click(screen.getByLabelText(en.a11y.hideNote));
      expect(screen.queryByText(en.detail.noteTitle)).toBeNull();
      fireEvent.click(screen.getByLabelText(en.a11y.showNote));
      await screen.findByText(en.detail.noteTitle);
      fireEvent.click(screen.getByText("第一件"));
      expect(screen.queryByText(en.detail.noteTitle)).toBeNull();
      expect(document.querySelector(".d-title")?.textContent).toBe("第一件");
    });

    it("切專案清掉右欄；回所有專案清掉右欄與清單", async () => {
      fetchTasksOverview.mockResolvedValue({ projects: [proj(), proj({ path: "/p/b", name: "b" })], permission_error: false, recent_days: 7 });
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByText("第一件"));
      expect(document.querySelector(".d-title")).not.toBeNull();
      fireEvent.click(tree().getByText("b"));
      await waitFor(() => expect(fetchTasks).toHaveBeenLastCalledWith(1234, "/p/b"));
      expect(document.querySelector(".d-title")).toBeNull();
      fireEvent.click(tree().getByText(en.tree.allProjects));
      expect(screen.getByText(en.overview.doingAll)).toBeTruthy();
    });

    it("右欄對 A 展開刪除確認後從清單點 B：確認列不沿用、不會刪到 B", async () => {
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "第二件" })], next_step: "", handoff_command: "" });
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByText("第一件"));
      const detail = () => document.querySelector(".tasks-col-detail") as HTMLElement;
      fireEvent.click(within(detail()).getByLabelText(en.list.delete));
      expect(detail().querySelector(".tk-confirm")).not.toBeNull();
      fireEvent.click(screen.getByText("第二件"));
      expect(document.querySelector(".d-title")?.textContent).toBe("第二件");
      expect(detail().querySelector(".tk-confirm")).toBeNull();
      expect(deleteTask).not.toHaveBeenCalled();
    });

    it("非編輯時清單找不到選中的票（外部刪了）→ 右欄回空", async () => {
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByText("第一件"));
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [], next_step: "", handoff_command: "" });
      fireEvent(window, new Event("focus"));
      await waitFor(() => expect(screen.getByText(en.detail.hint)).toBeTruthy());
    });

    // tasks_status 變 unavailable 時 list.tasks 是 null：「找不到票」的 effect 若只認陣列，右欄的
    // 票既找不到（view=loading）也不會被清（pane 留著），清單那欄寫「讀不到」、右欄卻永遠「載入中」（Codex R5）
    it("非編輯時清單重讀回 unavailable → 右欄回空，不卡載入中", async () => {
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByText("第一件"));
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "unavailable", tasks: null, next_step: "", handoff_command: "" });
      fireEvent(window, new Event("focus"));
      await waitFor(() => expect(screen.getByText(en.detail.hint)).toBeTruthy());
      expect(screen.queryByText(en.detail.loading)).toBeNull();
    });
  });

  describe("資料重讀（spec §5.8，D12）", () => {
    it("視窗取得焦點：總覽與清單都重抓；樹上的數字跟著更新", async () => {
      render(<Tasks port={1234} isActive />);
      await openProject();
      fetchTasksOverview.mockResolvedValue({ projects: [proj({ unfinished: 5 })], permission_error: false, recent_days: 7 });
      fireEvent(window, new Event("focus"));
      await waitFor(() => expect(tree().getByText("5")).toBeTruthy());
      expect(fetchTasks).toHaveBeenCalledTimes(2);
    });

    it("每次寫入成功後重抓：改狀態、擱置、建票、刪票各觸發一次總覽＋清單", async () => {
      render(<Tasks port={1234} isActive />);
      await openProject();
      const before = () => [fetchTasksOverview.mock.calls.length, fetchTasks.mock.calls.length];
      // 每一步都等重讀真的落地（mock 的清單永遠是一張 todo，重讀回來 title 就是 To do）。
      // 改狀態不就地更新（Codex R5），畫面只在重讀落地時變；不等落地，下一顆按鈕就可能按在
      // 上一次重讀還沒回來的畫面上，計數對不上
      const settled = async (o: number, l: number) => {
        await waitFor(() => expect(before()).toEqual([o + 1, l + 1]));
        await screen.findByTitle(en.status.todo);
        return before();
      };
      let [o, l] = before();
      fireEvent.click(screen.getByTitle(en.status.todo));                                   // 改狀態
      [o, l] = await settled(o, l);
      fireEvent.click(screen.getByLabelText(en.list.park));                                 // 擱置
      [o, l] = await settled(o, l);
      fireEvent.change(screen.getByPlaceholderText(en.list.newPlaceholder), { target: { value: "x" } });
      fireEvent.submit(screen.getByPlaceholderText(en.list.newPlaceholder).closest("form")!);   // 建票
      [o, l] = await settled(o, l);
      fireEvent.click(screen.getByLabelText(en.list.delete));
      fireEvent.click(document.querySelector(".tk-confirm-yes") as HTMLElement);            // 刪票
      await settled(o, l);
    });

    it("較舊的在途 GET 被淘汰：清單已載入→焦點觸發 GET₁（卡住）→寫入觸發 GET₂→GET₁ 晚回，畫面是 GET₂", async () => {
      render(<Tasks port={1234} isActive />);
      await openProject();                                                                 // 清單已載入
      let resolveFirst!: (v: TasksListResponse) => void;
      fetchTasks
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))          // GET₁ 卡住
        .mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ title: "第二版", status: "doing", fingerprint: "f2" })], next_step: "", handoff_command: "" });
      fireEvent(window, new Event("focus"));                                                // GET₁
      await waitFor(() => expect(fetchTasks).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByTitle(en.status.todo));                                   // 寫入 → 成功 → bump → GET₂
      await screen.findByText("第二版");
      resolveFirst({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ title: "第一版" })], next_step: "", handoff_command: "" });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText("第一版")).toBeNull();                                    // 舊快照沒蓋掉新的
      expect(screen.getByText("第二版")).toBeTruthy();
    });

    it("擱置鍵送 parked；擱置區的取回鍵送 todo", async () => {
      updateTask.mockResolvedValue(ticket({ status: "parked", fingerprint: "f2" }));
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByLabelText(en.list.park));
      await waitFor(() => expect(updateTask).toHaveBeenCalledWith(1234, "/p/a", "01-a.md", "parked", "f"));
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ status: "parked", fingerprint: "f2" })], next_step: "", handoff_command: "" });
      fireEvent(window, new Event("focus"));
      fireEvent.click(await screen.findByLabelText(en.a11y.expandParked));
      fireEvent.click(screen.getByLabelText(en.list.unpark));
      await waitFor(() => expect(updateTask).toHaveBeenLastCalledWith(1234, "/p/a", "01-a.md", "todo", "f2"));
    });

    // 原本守的是就地更新的專案歸屬（Codex R2）。改狀態不再就地更新（Codex R5）後，這條守的是
    // 「A 的晚到 PATCH 回應無論如何不碰 B 的清單」——有人把就地更新加回來又沒帶專案守衛，這裡會紅
    it("在 a 改狀態後切到 b，晚到的 PATCH 回應不動 b 的清單", async () => {
      let resolvePatch!: (v: TaskRow) => void;
      updateTask.mockImplementationOnce(() => new Promise((r) => { resolvePatch = r; }));
      fetchTasksOverview.mockResolvedValue({ projects: [proj(), proj({ path: "/p/b", name: "b" })], permission_error: false, recent_days: 7 });
      fetchTasks.mockImplementation((_, p) => Promise.resolve({ project: p, tasks_status: "ok", tasks: [ticket({ title: p === "/p/a" ? "A 的票" : "B 的票" })], next_step: "", handoff_command: "" }));
      render(<Tasks port={1234} isActive />);
      await openProject("a"); await screen.findByText("A 的票");
      fireEvent.click(screen.getByTitle(en.status.todo));                                  // PATCH 卡住
      await openProject("b"); await screen.findByText("B 的票");
      // 扣住 PATCH 成功後 bump 觸發的重讀：不扣的話正確的 B 清單會馬上把污染修好，拿掉守衛也看不出紅（Codex plan R1）
      fetchTasks.mockImplementationOnce(() => new Promise(() => {}));
      resolvePatch(ticket({ title: "A 的票（已改）", status: "doing", fingerprint: "f2" }));
      await waitFor(() => expect(fetchTasks).toHaveBeenCalledTimes(3));                     // bump 已發出（被扣住）
      expect(screen.queryByText("A 的票（已改）")).toBeNull();                            // B 的清單沒被 A 的回應污染
      expect(screen.getByText("B 的票")).toBeTruthy();
    });

    // Codex R5：就地更新與較舊的在途 GET 在同一個 React 批次落地時，舊快照會蓋掉就地更新。
    // 砍掉改狀態的就地更新後沒有東西可被蓋——PATCH 回應本身不改畫面，真相只來自 bump 的重讀。
    it("改狀態不就地更新：PATCH 回應不改畫面，重讀回來才變", async () => {
      render(<Tasks port={1234} isActive />);
      await openProject();
      let resolveReload!: (v: TasksListResponse) => void;
      fetchTasks.mockImplementationOnce(() => new Promise((r) => { resolveReload = r; }));   // 扣住 bump 觸發的重讀
      fireEvent.click(screen.getByTitle(en.status.todo));
      await waitFor(() => expect(fetchTasks).toHaveBeenCalledTimes(2));                    // PATCH 已回、bump 已發出
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(screen.getByTitle(en.status.todo)).toBeTruthy();                              // 畫面還是 todo：沒有就地更新
      expect(screen.queryByTitle(en.status.doing)).toBeNull();
      resolveReload({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ status: "doing", fingerprint: "f2" })], next_step: "", handoff_command: "" });
      await screen.findByTitle(en.status.doing);                                            // 重讀落地才變
    });
  });

  describe("編輯中（spec §5.7／§5.8）", () => {
    const startEditing = async () => {
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByText("第一件"));
      // 清單與右欄各有一顆編輯鍵，限定在右欄那顆
      fireEvent.click(within(document.querySelector(".tasks-col-detail") as HTMLElement).getByLabelText(en.list.edit));
      await screen.findByLabelText(en.list.editorBody);
    };

    it("右欄沒選票時按清單的編輯：右欄變成那張票的編輯器、列反白", async () => {
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(within(document.querySelector(".tasks-col-list") as HTMLElement).getByLabelText(en.list.edit));
      await screen.findByLabelText(en.list.editorBody);
      expect(document.querySelector(".tk-row.active")).not.toBeNull();
    });

    it("正在看 A 時按 B 的編輯：編輯的是 B", async () => {
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "第二件", body: "B body" })], next_step: "", handoff_command: "" });
      render(<Tasks port={1234} isActive />);
      await openProject();
      fireEvent.click(screen.getByText("第一件"));
      const rowB = screen.getByText("第二件").closest(".tk") as HTMLElement;
      fireEvent.click(within(rowB).getByLabelText(en.list.edit));
      expect(await screen.findByDisplayValue("B body")).toBeTruthy();
    });

    it("先展開刪除確認再進編輯：確認鍵消失，不會送 DELETE", async () => {
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "第二件" })], next_step: "", handoff_command: "" });
      render(<Tasks port={1234} isActive />);
      await openProject();
      const rowB = screen.getByText("第二件").closest(".tk") as HTMLElement;
      fireEvent.click(within(rowB).getByLabelText(en.list.delete));
      expect(rowB.querySelector(".tk-confirm")).not.toBeNull();
      fireEvent.click(within(screen.getByText("第一件").closest(".tk") as HTMLElement).getByLabelText(en.list.edit));
      await screen.findByLabelText(en.list.editorBody);
      expect(rowB.querySelector(".tk-confirm")).toBeNull();
      expect(deleteTask).not.toHaveBeenCalled();
    });

    it("編輯 A → 點 B 離開 → 在 B 按編輯：B 留在編輯模式（leaveRequest 不重播）", async () => {
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "第二件", body: "B body" })], next_step: "", handoff_command: "" });
      await startEditing();
      fireEvent.click(screen.getByText("第二件"));
      await waitFor(() => expect(document.querySelector(".d-title")?.textContent).toBe("第二件"));
      fireEvent.click(within(document.querySelector(".tasks-col-detail") as HTMLElement).getByLabelText(en.list.edit));
      await screen.findByDisplayValue("B body");
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByDisplayValue("B body")).toBeTruthy();   // 沒有被舊的 leaveRequest 踢出去
    });

    // 樹掛在編輯器旁邊之後的那條路（原過渡期測試的正式版）：編輯 A 的票時點樹上的 B，
    // 一律走 TaskEditor.leave()——草稿寫成功才離開並切專案，不從樹直接 setEditing(false)（Codex R1）
    it("編輯中點樹上的另一個專案：草稿寫成功 → 離開並切到那個專案", async () => {
      fetchTasksOverview.mockResolvedValue({ projects: [proj(), proj({ path: "/p/b", name: "b" })], permission_error: false, recent_days: 7 });
      await startEditing();
      fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "typed" } });
      fireEvent.click(tree().getByText("b"));
      await waitFor(() => expect(fetchTasks).toHaveBeenLastCalledWith(1234, "/p/b"));
      expect(screen.queryByLabelText(en.list.editorBody)).toBeNull();
      expect(loadDraft("/p/a", "01-a.md")?.body).toBe("typed");
    });

    it("進入編輯就 bump 一次重讀（淘汰在途 GET），且編輯中不再發請求", async () => {
      await startEditing();
      const o = fetchTasksOverview.mock.calls.length, l = fetchTasks.mock.calls.length;
      fireEvent(window, new Event("focus"));
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchTasksOverview).toHaveBeenCalledTimes(o);
      expect(fetchTasks).toHaveBeenCalledTimes(l);
    });

    it("進編輯前的在途 GET 帶回缺票的清單，編輯器仍在、字仍在", async () => {
      let resolveStale!: (v: TasksListResponse) => void;
      render(<Tasks port={1234} isActive />);
      await openProject();
      fetchTasks.mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }));
      fireEvent(window, new Event("focus"));                     // 在途 GET
      fireEvent.click(screen.getByText("第一件"));
      fireEvent.click(within(document.querySelector(".tasks-col-detail") as HTMLElement).getByLabelText(en.list.edit));
      const ta = await screen.findByLabelText(en.list.editorBody);
      fireEvent.change(ta, { target: { value: "typing" } });
      resolveStale({ project: "/p/a", tasks_status: "ok", tasks: [], next_step: "", handoff_command: "" });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByDisplayValue("typing")).toBeTruthy();   // 沒被卸載
    });

    it("編輯中清單唯讀：輸入框與寫入鍵 disabled", async () => {
      await startEditing();
      expect((screen.getByPlaceholderText(en.list.newPlaceholder) as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTitle(en.status.todo) as HTMLButtonElement).disabled).toBe(true);
    });

    it("編輯中切到別張票：草稿寫成功→離開並切換；寫失敗→留在原畫面直到仍要離開", async () => {
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "第二件" })], next_step: "", handoff_command: "" });
      await startEditing();
      fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "typed" } });
      fireEvent.click(screen.getByText("第二件"));
      await waitFor(() => expect(document.querySelector(".d-title")?.textContent).toBe("第二件"));
      expect(loadDraft("/p/a", "01-a.md")?.body).toBe("typed");
      // 寫失敗的路徑
      cleanup(); vi.clearAllMocks(); localStorage.clear();
      fetchTasksOverview.mockResolvedValue({ projects: [proj()], permission_error: false, recent_days: 7 });
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "第二件" })], next_step: "", handoff_command: "" });
      await startEditing();
      // vitest.setup.ts 把 localStorage 換成 own-property 的 in-memory 物件，spy 要打在實例上，Storage.prototype 攔不到
      const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
      try {
        fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "typed2" } });
        fireEvent.click(screen.getByText("第二件"));
        await screen.findByText(en.list.leaveAnyway);
        expect(screen.getByDisplayValue("typed2")).toBeTruthy();
        fireEvent.click(screen.getByText(en.list.leaveAnyway));
        await waitFor(() => expect(document.querySelector(".d-title")?.textContent).toBe("第二件"));
      } finally { setItem.mockRestore(); }
    });

    // nav 觸發的離開寫草稿失敗後，被攔下的導覽還掛在 pendingNav 上；使用者改按編輯器自己的取消
    // 是「離開 → pane 不變」（spec §5.7），不得把那個過期的導覽消耗掉、跳去 B（Codex R5 medium）
    it("編輯中點 B 但草稿寫失敗 → 改按編輯器的取消且這次寫成功 → 留在 A 的票檢視，不跳到 B", async () => {
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "第二件" })], next_step: "", handoff_command: "" });
      await startEditing();
      const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
      try {
        fireEvent.change(screen.getByLabelText(en.list.editorBody), { target: { value: "typed" } });
        fireEvent.click(screen.getByText("第二件"));
        await screen.findByText(en.list.leaveAnyway);
      } finally { setItem.mockRestore(); }                          // 這次寫得成功
      fireEvent.click(within(document.querySelector(".lb-detail.is-editing") as HTMLElement).getByText(en.list.cancel));
      await waitFor(() => expect(document.querySelector(".d-title")?.textContent).toBe("第一件"));
      expect(screen.queryByText("第二件", { selector: ".d-title" })).toBeNull();
      expect(loadDraft("/p/a", "01-a.md")?.body).toBe("typed");   // 取消走的是 leave()：草稿有 flush
    });

    it("儲存成功：右欄回到票檢視顯示新內容，並重讀一次", async () => {
      updateTaskContent.mockResolvedValue(ticket({ title: "改過的標題", fingerprint: "f2" }));
      await startEditing();
      // 儲存後的重讀要回已儲存的版本——否則 GET 會把「改過的標題」蓋回舊的（Codex plan R1）
      fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket({ title: "改過的標題", fingerprint: "f2" })], next_step: "", handoff_command: "" });
      const o = fetchTasksOverview.mock.calls.length;
      fireEvent.click(screen.getByText(en.list.save));
      await waitFor(() => expect(document.querySelector(".d-title")?.textContent).toBe("改過的標題"));
      await waitFor(() => expect(fetchTasksOverview).toHaveBeenCalledTimes(o + 1));
    });
  });
});

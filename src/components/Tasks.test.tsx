// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import { TaskConflictError, type TaskRow, type TasksListResponse, type TasksOverview } from "../lib/sidecar";
import { Tasks } from "./Tasks";

const fetchTasksOverview = vi.fn<(port: number) => Promise<TasksOverview>>();
const fetchTasks = vi.fn<(port: number, project: string) => Promise<TasksListResponse>>();
const createTask = vi.fn<(port: number, project: string, title: string) => Promise<TaskRow>>();
const updateTask = vi.fn<(p: number, proj: string, name: string, status: string, fp: string) => Promise<TaskRow>>();
const deleteTask = vi.fn<(p: number, proj: string, name: string, fp: string) => Promise<void>>();
const openFile = vi.fn<(port: number, p: string) => Promise<{ status: string }>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchTasksOverview: (port: number) => fetchTasksOverview(port),
  fetchTasks: (port: number, project: string) => fetchTasks(port, project),
  createTask: (port: number, project: string, title: string) => createTask(port, project, title),
  updateTask: (p: number, proj: string, n: string, st: string, fp: string) => updateTask(p, proj, n, st, fp),
  deleteTask: (p: number, proj: string, n: string, fp: string) => deleteTask(p, proj, n, fp),
  openFile: (port: number, path: string) => openFile(port, path),
}));

const proj = (over: Partial<TasksOverview["projects"][number]> = {}) => ({
  path: "/p/a", name: "a", account: "work", unfinished: 1, doing: 0,
  tasks_status: "ok" as const, next_step: "", ...over,
});
// 狀態按鈕的可及名稱是組出來的：「現在是什麼，點下去變什麼」
const statusLabel = (current: string, next: string) =>
  en.a11y.statusCycle.replace("{{current}}", current).replace("{{next}}", next);
const ticket = (over: Partial<TaskRow> = {}): TaskRow => ({
  name: "01-a.md", number: 1, title: "第一件", status: "todo", source: "me",
  created: "2026-08-29", anomalies: [], fingerprint: "f", path: "/p/a/.fledge/tasks/01-a.md", ...over,
});

describe("Tasks 面板", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    fetchTasksOverview.mockResolvedValue({ projects: [proj()], permission_error: false });
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "ok", tasks: [ticket()], next_step: "" });
    createTask.mockResolvedValue(ticket({ name: "02-b.md", number: 2, title: "新的" }));
    updateTask.mockResolvedValue(ticket({ status: "doing", fingerprint: "f2" }));
    deleteTask.mockResolvedValue(undefined);
    openFile.mockResolvedValue({ status: "ok" });
  });
  afterEach(cleanup);   // vitest 未開 globals → testing-library 不會自動 cleanup

  // design §5.5：切到本面板時重讀 ＋ 視窗重新取得焦點時重讀。
  // T6 的「叫 AI 開票後切回面板看到它」全靠這條——後端全綠也證明不了它。
  it("視窗重新取得焦點時 refetch，且畫面跟著更新", async () => {
    const { container } = render(<Tasks port={1234} isActive />);
    // 只認列上的未完成數。分組標頭的計數也是數字，用 getByText 會兩邊都命中而炸掉
    const n = () => container.querySelector(".tov-row .tov-n")?.textContent;
    await waitFor(() => expect(n()).toBe("1"));

    fetchTasksOverview.mockResolvedValue({ projects: [proj({ unfinished: 3 })], permission_error: false });
    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(n()).toBe("3"));
    expect(fetchTasksOverview).toHaveBeenCalledTimes(2);
  });

  it("分頁不在前景時不打 API；切到前景才讀", async () => {
    const { rerender } = render(<Tasks port={1234} isActive={false} />);
    expect(fetchTasksOverview).not.toHaveBeenCalled();
    rerender(<Tasks port={1234} isActive />);
    await waitFor(() => expect(fetchTasksOverview).toHaveBeenCalledTimes(1));
  });

  // design §6.3：把「讀不到」顯示成「沒有」，正是這個功能存在的理由的反面
  it("總覽收到 unavailable 時畫成讀不到，不是 0", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [proj({ unfinished: null, tasks_status: "unavailable" })], permission_error: false,
    });
    render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText(en.overview.unavailable)).toBeTruthy());
    expect(screen.queryByText("0")).toBeNull();
  });

  // 分組判準是「這個專案有沒有話要說」。absent 但帶著 state.md 的下一步時那句話必須留著
  it("總覽分兩層：有話要說的展開，只有名字的收成 chip", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [
        proj({ path: "/p/a", name: "有票", unfinished: 3, tasks_status: "ok", next_step: "先修這個" }),
        proj({ path: "/p/b", name: "做完了", unfinished: 0, tasks_status: "ok" }),
        proj({ path: "/p/c", name: "沒用過", unfinished: 0, tasks_status: "absent" }),
        proj({ path: "/p/d", name: "壞掉的", unfinished: null, tasks_status: "unavailable" }),
      ],
      permission_error: false,
    });
    const { container } = render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("有票")).toBeTruthy());

    expect([...container.querySelectorAll(".tov-row .tov-name")].map((n) => n.textContent))
      .toEqual(["有票", "做完了", "壞掉的"]);
    expect([...container.querySelectorAll(".tov-chip")].map((n) => n.textContent))
      .toEqual(["沒用過"]);
    expect(container.querySelector('.tov-chip[title="/p/d"]')).toBeNull();   // 警告不可被降級
  });

  // absent 也可能帶 next_step（state.md 住在 .fledge/ 不是 tasks/）。
  // 同一份 fixture 一定要放一個 absent-但沒有下一步的兄弟，否則「全部都畫成列」
  // 的現況也會通過這條測試（R2 抓到的假綠）
  it("absent 但有下一步的展開，absent 且沒有下一步的收成 chip", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [
        proj({ path: "/p/e", name: "只有下一步", unfinished: 0, tasks_status: "absent",
               next_step: "先把環境裝起來" }),
        proj({ path: "/p/f", name: "什麼都沒有", unfinished: 0, tasks_status: "absent" }),
      ],
      permission_error: false,
    });
    const { container } = render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("先把環境裝起來")).toBeTruthy());
    expect(container.querySelector('.tov-row[title="/p/e"]')).toBeTruthy();
    expect(container.querySelector('.tov-chip[title="/p/e"]')).toBeNull();
    expect(container.querySelector('.tov-chip[title="/p/f"]')).toBeTruthy();   // 這行讓現況變紅
    expect(container.querySelector('.tov-row[title="/p/f"]')).toBeNull();
  });

  // runtime JSON 沒有驗證。fail-safe 必須落在警告那一側，而且頁首計數也要跟著
  it("認不得的 tasks_status 畫成警告，不算進未完成總數", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [
        proj({ path: "/p/a", name: "正常", unfinished: 2, tasks_status: "ok" }),
        proj({ path: "/p/x", name: "未來狀態", unfinished: null, tasks_status: "brand-new" as never }),
      ],
      permission_error: false,
    });
    const { container } = render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("未來狀態")).toBeTruthy());
    expect(container.querySelector('.tov-row[title="/p/x"] .tov-n')).toBeNull();   // 沒有數字
    // 頁首摘要也要正確——只修列不修 reducer 的實作必須被擋下來
    const sum = container.querySelector(".tasks-sum")!.textContent!;
    expect(sum).toContain("2");                                  // 總數只算 ok
    expect(sum).toContain(en.overview.summaryUnreadable.replace("{{n}}", "1"));
  });

  // 同一個 fail-safe 用在 unfinished 上：ok 但數字是壞的，不可被壓成 0
  it("ok 但 unfinished 不是非負整數時當成警告，不畫成 0", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [proj({ path: "/p/y", name: "壞數字", unfinished: null, tasks_status: "ok" })],
      permission_error: false,
    });
    const { container } = render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("壞數字")).toBeTruthy());
    expect(container.querySelector('.tov-row[title="/p/y"] .tov-n')).toBeNull();
    expect(screen.getByText(en.overview.unavailable)).toBeTruthy();
  });

  it("下一步是空字串時顯示提示，不是留白", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [proj({ path: "/p/g", name: "沒設下一步", unfinished: 1, tasks_status: "ok", next_step: "" })],
      permission_error: false,
    });
    const { container } = render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("沒設下一步")).toBeTruthy());
    const cell = container.querySelector('.tov-row[title="/p/g"] .tov-next.is-none');
    expect(cell).toBeTruthy();                        // 先確認節點存在，不要讓 undefined 比 undefined
    expect(cell!.textContent).toBe(en.overview.noNextStep);
  });

  // 票 02：刻度分狀態上色。doing 是 unfinished 的子集合，只決定前幾根上色
  it("進行中的張數畫成上色刻度，其餘維持一般刻度", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [proj({ path: "/p/a", name: "有進行中", unfinished: 5, doing: 2 })],
      permission_error: false,
    });
    const { container } = render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("有進行中")).toBeTruthy());
    const marks = [...container.querySelectorAll(".tov-marks i")];
    expect(marks).toHaveLength(5);
    expect(marks.filter((m) => m.classList.contains("is-doing"))).toHaveLength(2);
    // 上色的必須排在前面，否則兩色會交錯而看不出比例
    expect(marks.slice(0, 2).every((m) => m.classList.contains("is-doing"))).toBe(true);
  });

  // runtime JSON 沒有驗證。doing 壞掉時退回「全部一般刻度」——
  // 刻度總數來自 unfinished，仍然可信，只有拆分不可信，不必整列降級成警告
  it.each([
    ["null", null],
    ["超過 unfinished", 9],
    ["負數", -1],
    ["不是整數", 1.5],
  ])("doing 是 %s 時不上色，刻度總數不受影響", async (_label, doing) => {
    fetchTasksOverview.mockResolvedValue({
      projects: [proj({ path: "/p/a", name: "壞的 doing", unfinished: 3, doing: doing as number })],
      permission_error: false,
    });
    const { container } = render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("壞的 doing")).toBeTruthy());
    expect(container.querySelectorAll(".tov-marks i")).toHaveLength(3);
    expect(container.querySelectorAll(".tov-marks i.is-doing")).toHaveLength(0);
  });

  it("點 chip 只進入該專案，不建立任何東西", async () => {
    fetchTasksOverview.mockResolvedValue({
      projects: [proj({ path: "/p/c", name: "沒用過", unfinished: 0, tasks_status: "absent" })],
      permission_error: false,
    });
    fetchTasks.mockResolvedValue({ project: "/p/c", tasks_status: "absent", tasks: [], next_step: "" });
    const { container } = render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(container.querySelector('.tov-chip[title="/p/c"]')).toBeTruthy());
    expect(container.querySelector('.tov-row[title="/p/c"]')).toBeNull();

    fireEvent.click(container.querySelector('.tov-chip[title="/p/c"]')!);
    await waitFor(() => expect(fetchTasks).toHaveBeenCalledWith(1234, "/p/c"));
    expect(createTask).not.toHaveBeenCalled();
    expect(screen.getByText(en.list.empty)).toBeTruthy();   // 空清單，不是錯誤態
  });

  it("單一專案收到 unavailable 時畫成錯誤態，不是空清單", async () => {
    fetchTasks.mockResolvedValue({ project: "/p/a", tasks_status: "unavailable", tasks: null, next_step: "" });
    render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
    await waitFor(() => expect(screen.getByText(en.list.unavailable)).toBeTruthy());
    expect(screen.queryByText(en.list.empty)).toBeNull();   // 不得退化成「沒有待辦」
  });

  it("第二層：未完成在上、done 預設收起，展開才看得到", async () => {
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "",
      tasks: [ticket(), ticket({ name: "02-b.md", number: 2, title: "做完的", status: "done", source: "ai" })],
    });
    render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
    await waitFor(() => expect(screen.getByText("第一件")).toBeTruthy());
    expect(screen.queryByText("做完的")).toBeNull();                 // done 預設摺疊
    fireEvent.click(screen.getByLabelText(en.a11y.expandDone));
    expect(screen.getByText("做完的")).toBeTruthy();
    expect(screen.getByText(en.source.ai)).toBeTruthy();             // 來源標記
  });

  // A1：未完成拆成「進行中／待辦」兩區，進行中永遠浮在最上面；空的區整段不畫
  it("三區分組：進行中在待辦之上，沒有進行中時不留空標頭", async () => {
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "",
      tasks: [
        ticket({ name: "01-a.md", number: 1, title: "待做的", status: "todo" }),
        ticket({ name: "02-b.md", number: 2, title: "在做的", status: "doing" }),
      ],
    });
    const { container, rerender } = render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
    await waitFor(() => expect(screen.getByText("在做的")).toBeTruthy());
    // 後端給的順序是 01 在前，畫面上必須是「在做的」先出現——分組有真的改變排序
    const titles = [...container.querySelectorAll(".tk-title")].map((n) => n.textContent);
    expect(titles).toEqual(["在做的", "待做的"]);
    expect(screen.getByText(en.list.doing)).toBeTruthy();

    // 沒有 doing 的票時，「進行中」整段不該出現（留一個 0 的標頭只是噪音）
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "",
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
      project: "/p/a", tasks_status: "ok", next_step: "",
      tasks: [
        ticket({ name: "01-a.md", title: "有日期", created: "2026-08-29" }),
        ticket({ name: "02-b.md", number: 2, title: "壞日期", created: "2026/08/29" }),
      ],
    });
    const { container } = render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
    await waitFor(() => expect(screen.getByText("有日期")).toBeTruthy());
    expect([...container.querySelectorAll(".tk-date")].map((n) => n.textContent)).toEqual(["08-29"]);
  });

  // design §6.2：「異常」不是「隱藏」——票照常出現，點記號才說明哪裡不對
  it("異常票照常顯示，點記號展開檔名與原因", async () => {
    fetchTasks.mockResolvedValue({
      project: "/p/a", tasks_status: "ok", next_step: "",
      tasks: [ticket({ name: "壞的.md", number: null, title: "壞的", anomalies: ["number_missing", "status_invalid"] })],
    });
    render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
    await waitFor(() => expect(screen.getByText("壞的")).toBeTruthy());   // 沒有被隱藏
    fireEvent.click(screen.getByLabelText(en.anomaly.label));
    expect(screen.getByText("壞的.md")).toBeTruthy();
    expect(screen.getByText(en.anomaly.number_missing)).toBeTruthy();
    expect(screen.getByText(en.anomaly.status_invalid)).toBeTruthy();
  });

  // design §5.2：一行輸入建票。source/status/created 都由 sidecar 決定，前端只送標題。
  it("打字送出會建票並重讀清單", async () => {
    render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
    const input = await screen.findByLabelText(en.list.newPlaceholder);
    fireEvent.change(input, { target: { value: "  新的一件事  " } });
    fireEvent.click(screen.getByText(en.list.add));

    await waitFor(() => expect(createTask).toHaveBeenCalledWith(1234, "/p/a", "新的一件事"));
    await waitFor(() => expect(fetchTasks).toHaveBeenCalledTimes(2));   // 建完重讀
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("空白標題不送出", async () => {
    render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
    const input = await screen.findByLabelText(en.list.newPlaceholder);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("建票失敗顯示錯誤，不清空使用者打的字", async () => {
    createTask.mockRejectedValue(new Error("400"));
    render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
    const input = await screen.findByLabelText(en.list.newPlaceholder);
    fireEvent.change(input, { target: { value: "會失敗的" } });
    fireEvent.click(screen.getByText(en.list.add));
    await waitFor(() => expect(screen.getByText(en.list.createError)).toBeTruthy());
    expect((input as HTMLInputElement).value).toBe("會失敗的");
  });

  // ── T4：切狀態、刪除、開編輯器、衝突偵測 ──────────────────

  async function openList() {
    render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
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
      project: "/p/a", tasks_status: "ok", next_step: "",
      tasks: [
        ticket({ name: "01-a.md", title: "待辦的", status: "todo" }),
        ticket({ name: "02-b.md", number: 2, title: "在做的", status: "doing" }),
        ticket({ name: "03-c.md", number: 3, title: "做完的", status: "done" }),
      ],
    });
    render(<Tasks port={1234} isActive />);
    fireEvent.click(await screen.findByTitle("/p/a"));
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
});

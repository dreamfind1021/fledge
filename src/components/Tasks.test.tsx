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
const openPath = vi.fn<(p: string) => Promise<void>>();

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: (p: string) => openPath(p) }));

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchTasksOverview: (port: number) => fetchTasksOverview(port),
  fetchTasks: (port: number, project: string) => fetchTasks(port, project),
  createTask: (port: number, project: string, title: string) => createTask(port, project, title),
  updateTask: (p: number, proj: string, n: string, st: string, fp: string) => updateTask(p, proj, n, st, fp),
  deleteTask: (p: number, proj: string, n: string, fp: string) => deleteTask(p, proj, n, fp),
}));

const proj = (over: Partial<TasksOverview["projects"][number]> = {}) => ({
  path: "/p/a", name: "a", account: "work", unfinished: 1,
  tasks_status: "ok" as const, next_step: "", ...over,
});
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
    openPath.mockResolvedValue(undefined);
  });
  afterEach(cleanup);   // vitest 未開 globals → testing-library 不會自動 cleanup

  // design §5.5：切到本面板時重讀 ＋ 視窗重新取得焦點時重讀。
  // T6 的「叫 AI 開票後切回面板看到它」全靠這條——後端全綠也證明不了它。
  it("視窗重新取得焦點時 refetch，且畫面跟著更新", async () => {
    render(<Tasks port={1234} isActive />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());

    fetchTasksOverview.mockResolvedValue({ projects: [proj({ unfinished: 3 })], permission_error: false });
    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(screen.getByText("3")).toBeTruthy());
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
    fireEvent.click(screen.getByLabelText(en.a11y.cycleStatus));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(1234, "/p/a", "01-a.md", "doing", "f"));
    await waitFor(() => expect(screen.getByText(en.status.doing)).toBeTruthy());
  });

  // design §7.2：成功回應要帶回新 fingerprint、前端要用它取代本地狀態，
  // 否則第二次操作會被錯誤地判成 409。單次點擊的測試抓不到這個。
  it("連續兩次切狀態，第二次用的是回傳的新 fingerprint", async () => {
    await openList();
    fireEvent.click(screen.getByLabelText(en.a11y.cycleStatus));
    await waitFor(() => expect(screen.getByText(en.status.doing)).toBeTruthy());

    updateTask.mockResolvedValue(ticket({ status: "done", fingerprint: "f3" }));
    fireEvent.click(screen.getByLabelText(en.a11y.cycleStatus));
    await waitFor(() => expect(updateTask).toHaveBeenLastCalledWith(1234, "/p/a", "01-a.md", "done", "f2"));
  });

  it("收到 409 顯示已被改過並重新載入", async () => {
    updateTask.mockRejectedValue(new TaskConflictError());
    await openList();
    fireEvent.click(screen.getByLabelText(en.a11y.cycleStatus));
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

  it("用編輯器打開走 sidecar 給的絕對路徑，前端不拼路徑", async () => {
    await openList();
    fireEvent.click(screen.getByLabelText(en.a11y.openInEditor));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/p/a/.fledge/tasks/01-a.md"));
  });
});

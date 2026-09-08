import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  TaskConflictError, createTask, deleteTask, fetchTasks, fetchTasksOverview, openFile, updateTask,
  type TaskRow, type TasksListResponse, type TasksOverview as TasksOverviewData,
} from "../lib/sidecar";
import { NEXT_STATUS, TasksList } from "./TasksList";
import { TasksOverview } from "./TasksOverview";
import "./Tasks.css";

// 待辦面板（design §5）。兩層導覽：總覽 → 單一專案。
// 所有 HTTP 一律經 src/lib/sidecar.ts 的 wrapper（plan §1.0）：直接 fetch 會漏掉
// X-Fledge-Token，dev 看似正常、打包版整個死掉。
export function Tasks({ port, isActive }: { port: number | null; isActive: boolean }) {
  const { t } = useTranslation("tasks");
  const [selected, setSelected] = useState<string | null>(null);
  const [overview, setOverview] = useState<TasksOverviewData | null>(null);
  const [list, setList] = useState<TasksListResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState("");   // i18n key，空字串＝不顯示
  // 在途的改狀態請求（鍵＝專案路徑＋票檔名）。用 ref 不用 state：它只擋重複送出，
  // 不影響畫面，進 state 會多一輪不必要的 re-render。
  const inFlight = useRef(new Set<string>());

  // design §5.5：切到本面板時重讀（isActive 進到依賴陣列）＋ 視窗重新取得焦點時重讀。
  // 不做即時檔案監看——使用者的節奏是「叫 AI 開票 → 之後才去看」，中間必然經過切換面板。
  useEffect(() => {
    if (!isActive) return;
    const bump = () => setReloadKey((k) => k + 1);
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, [isActive]);

  const select = useCallback((path: string) => { setList(null); setSelected(path); }, []);
  const back = useCallback(() => { setSelected(null); }, []);
  // 建完重讀整份清單：新票的編號由 sidecar 配（最大號 +1），前端不自己算
  const create = useCallback(async (title: string) => {
    if (port == null || selected == null) return;
    await createTask(port, selected, title);
    setReloadKey((k) => k + 1);
  }, [port, selected]);

  // 失敗處理共用：409 是「已被改過」，其餘一律通用錯誤。兩者都重讀，讓畫面回到真實狀態。
  const onActionError = useCallback((e: unknown) => {
    setNotice(e instanceof TaskConflictError ? "list.conflict" : "list.actionError");
    setReloadKey((k) => k + 1);
  }, []);

  const cycle = useCallback((task: TaskRow) => {
    if (port == null || selected == null) return;
    // 同一張票同時只讓一個改狀態的請求在路上。少了這道鎖，快速連點會用**同一個
    // fingerprint** 送出兩次 PATCH：第一次成功後檔案的 fingerprint 就變了，第二次必然
    // 被判成 stale 而彈出「這張票已被改過」——使用者什麼都沒做錯卻看到錯誤訊息。
    // 鍵帶上專案路徑：切到別的專案時，同名票不該被上一個專案的在途請求擋住。
    const key = `${selected}\n${task.name}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setNotice("");
    updateTask(port, selected, task.name, NEXT_STATUS[task.status] ?? "todo", task.fingerprint)
      // 用回傳的票取代本地狀態（含新 fingerprint）。少了這步，改一次之後本地的 fingerprint
      // 就過期了，下一次改狀態或刪除會被錯誤地判成 409（design §7.2）。
      .then((updated) => setList((cur) => (cur && cur.tasks
        ? { ...cur, tasks: cur.tasks.map((x) => (x.name === updated.name ? updated : x)) }
        : cur)))
      .catch(onActionError)
      .finally(() => inFlight.current.delete(key));
  }, [port, selected, onActionError]);

  const remove = useCallback((task: TaskRow) => {
    if (port == null || selected == null) return;
    setNotice("");
    deleteTask(port, selected, task.name, task.fingerprint)
      .then(() => setReloadKey((k) => k + 1))
      .catch(onActionError);
  }, [port, selected, onActionError]);

  // 用編輯器打開（design §5.2）。path 由 sidecar 組，前端不拼 `.fledge/tasks` 這個佈局。
  //
  // 票 01 起改走 sidecar 的 POST /api/open，**不再用 Tauri 的 openPath**。
  // capability 的白名單已一併移除，改回去會直接被拒。原因：glob 寫不出真正的邊界——
  // `$HOME/**` 放行整個家目錄，又讓家目錄以外的 root 用不了；而且 Tauri 在 Unix 上
  // require_literal_leading_dot 預設為 true，`$HOME/**` 連 `.fledge/` 都匹配不到，
  // 當時得再補一條寫死點目錄的規則才會動。
  const openInEditor = useCallback((task: TaskRow) => {
    if (port == null) return;                    // sidecar 還沒起來，與其他三個 handler 同一套守衛
    // 走 sidecar 而不是 Tauri 的 openPath：邊界要與檔案樹同一套（票 01）。
    // status 非 ok（擋掉、檔案不見、平台不支援）也要報，否則使用者點了完全沒反應
    openFile(port, task.path)
      .then((r) => { if (r.status !== "ok") setNotice("list.actionError"); })
      .catch(() => setNotice("list.actionError"));
  }, [port]);

  useEffect(() => {
    if (port == null || !isActive) return;
    let cancelled = false;
    setFailed(false);
    const done = selected == null
      ? fetchTasksOverview(port).then((o) => { if (!cancelled) setOverview(o); })
      : fetchTasks(port, selected).then((l) => { if (!cancelled) setList(l); });
    done.catch(() => { if (!cancelled) setFailed(true); });   // 失敗顯錯誤態，不留空白
    return () => { cancelled = true; };
  }, [port, isActive, selected, reloadKey]);

  // 第二層的標題是專案名。名字從已載入的總覽推導，不另存一份 state——
  // 存兩份就會有一份過期，而且進到第二層的唯一入口就是總覽那一列。
  const projectName = overview?.projects.find((p) => p.path === selected)?.name ?? t("tabTitle");

  return (
    <div className="tasks-root" data-testid="tasks-panel">
      {selected == null
        ? <TasksOverview data={overview} failed={failed} onSelect={select} t={t} />
        : <TasksList data={list} projectName={projectName} failed={failed} notice={notice}
            onBack={back} onCreate={create}
            onCycle={cycle} onDelete={remove} onOpen={openInEditor}
            onEdit={() => {}} // TODO(Task 11): 接 TaskEditor
            t={t} />}
    </div>
  );
}

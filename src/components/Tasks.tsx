import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  TaskConflictError, createTask, deleteTask, fetchTasks, fetchTasksOverview, openFile, updateTask,
  type TaskRow, type TasksListResponse, type TasksOverview as TasksOverviewData,
} from "../lib/sidecar";
import { clearDraft, listDrafts } from "../lib/taskDraft";
import { NEXT_STATUS, TasksList } from "./TasksList";
import { TasksOverview } from "./TasksOverview";
import { TasksTree } from "./TasksTree";
import { TaskEditor } from "./TaskEditor";
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
  const [editing, setEditing] = useState<TaskRow | null>(null);       // 正在編輯的票，非 null＝第三層
  const [expandedName, setExpandedName] = useState<string | null>(null);   // 展開哪一張票，父層管才能跨編輯器返回保留
  // 在途的改狀態請求（鍵＝專案路徑＋票檔名）。用 ref 不用 state：它只擋重複送出，
  // 不影響畫面，進 state 會多一輪不必要的 re-render。
  const inFlight = useRef(new Set<string>());

  // design §5.5：切到本面板時重讀（isActive 進到依賴陣列）＋ 視窗重新取得焦點時重讀。
  // 不做即時檔案監看——使用者的節奏是「叫 AI 開票 → 之後才去看」，中間必然經過切換面板。
  // 編輯中（editing 非 null）兩條都要擋（spec §6.2）：否則切走再切回會用伺服器版本
  // 蓋掉正在打的字。
  useEffect(() => {
    if (!isActive || editing) return;
    const bump = () => setReloadKey((k) => k + 1);
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, [isActive, editing]);

  // 切專案要重置展開狀態：票檔名在專案之間會撞名（每個專案都有 01-*.md），
  // 不清的話 A 展開的那張票的檔名剛好也在 B 出現，B 進來就無端展開了一張票。
  const select = useCallback((path: string) => { setList(null); setSelected(path); setExpandedName(null); }, []);
  const back = useCallback(() => { setSelected(null); setExpandedName(null); }, []);
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

  // 刪票時一併清草稿（spec §7.6：使用者自己刪的才清；票是外部消失的孤兒草稿不動）
  const remove = useCallback((task: TaskRow) => {
    if (port == null || selected == null) return;
    setNotice("");
    deleteTask(port, selected, task.name, task.fingerprint)
      .then(() => { clearDraft(selected, task.name); setReloadKey((k) => k + 1); })
      .catch(onActionError);
  }, [port, selected, onActionError]);

  const edit = useCallback((task: TaskRow) => setEditing(task), []);
  const saved = useCallback((updated: TaskRow) => {
    setList((cur) => (cur && cur.tasks
      ? { ...cur, tasks: cur.tasks.map((x) => (x.name === updated.name ? updated : x)) }
      : cur));
    setExpandedName(updated.name);   // 返回後保持展開（spec §6.2）：剛改完要立刻看到 render 結果
    setEditing(null);
  }, []);
  // reload=true 只有 TaskEditor 的「捨棄我的版本」會傳（plan R2 F4）：把清單打成 loading
  // (setList(null)) 再重讀——不這樣做的話舊清單還在畫面上，使用者可以立刻再點編輯、
  // 帶著舊 fingerprint 再送一次，保證又是一次 409。
  const leaveEditor = useCallback((reload: boolean) => {
    setEditing(null);
    if (reload) { setList(null); setReloadKey((k) => k + 1); }
  }, []);

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
    if (port == null || !isActive || editing) return;   // editing：同上，擋掉重讀（spec §6.2）
    let cancelled = false;
    setFailed(false);
    const done = selected == null
      ? fetchTasksOverview(port).then((o) => { if (!cancelled) setOverview(o); })
      : fetchTasks(port, selected).then((l) => { if (!cancelled) setList(l); });
    done.catch(() => { if (!cancelled) setFailed(true); });   // 失敗顯錯誤態，不留空白
    return () => { cancelled = true; };
    // editing 刻意不放進依賴陣列：這裡只需要「編輯中擋掉這一次重讀」，不需要「離開編輯這件事
    // 本身觸發一次新的重讀」。若放進依賴陣列，存檔成功離開編輯（editing 從票物件變成 null）
    // 會被 React 視為依賴變動而重跑整個 effect body——那一刻 editing 已經是 null，guard 讓
    // 它直接發出一次重讀，把 saved() 剛才本地更新好的新內容（新 fingerprint／新內文）蓋掉。
    // 真正該觸發重讀的時機（切分頁、切專案、reloadKey 被主動 bump）都已經在別的依賴裡了；
    // 「捨棄我的版本」也是靠 reloadKey 觸發，不靠 editing 本身。
    // 編輯期間被擋下的那次重讀不會補跑，要等下一次切換或 focus——spec §6.2 只要求編輯中
    // 不能被蓋掉，沒有要求那次被擋的重讀事後要補回來。
  }, [port, isActive, selected, reloadKey]);

  // 第二層的標題是專案名。名字從已載入的總覽推導，不另存一份 state——
  // 存兩份就會有一份過期，而且進到第二層的唯一入口就是總覽那一列。
  const projectName = overview?.projects.find((p) => p.path === selected)?.name ?? t("tabTitle");

  // 孤兒草稿：草稿的檔名不在目前清單裡（spec §7.4）。list 還沒回來（null）時不知道哪些
  // 草稿是孤兒，一律不算；tasks_status 是 unavailable 時 list.tasks 是 null，`?.some` 短路成
  // undefined，全部草稿都算孤兒——但不清掉任何東西，只讓 TasksList 的 `data.tasks == null`
  // 分支顯示 orphanUnavailable 提示，不會走到下面會渲染逐張刪除鍵的正常清單路徑。
  // tasks_status 是 absent 時 list.tasks 是空陣列 `[]`——**不是 null**——上面那條 null 短路
  // 救不到它：naive 比對會讓每一份草稿都被判成「票已經不在了」的孤兒，配上一鍵不可逆的
  // 〔丟棄草稿〕，而 spec §7.4 明講 absent 跟 unavailable 要同一套待遇（現在讀不到，草稿留著，
  // 不做任何清除）。排除 absent（whole-branch review M3）：unavailable 沿用原本的 null 短路
  // 不動，只有 absent 額外被擋下來，兩者互不影響。
  const allDrafts = selected && list ? listDrafts(selected) : [];
  const orphanDrafts = allDrafts.filter((d) =>
    list?.tasks_status !== "absent" && !list?.tasks?.some((x) => x.name === d.name));
  // 票還活著但寫壞了（update_content 非原子寫入中途失敗 → can_round_trip 失敗 → editable:
  // false）：TasksList 正確地藏起編輯入口，但草稿的檔名還在清單裡、不是孤兒，不會出現在上面
  // 那份孤兒草稿列——沒有這份對照表，草稿會卡在 localStorage 裡，介面上完全看不到也複製不出來。
  // K6「寫壞檔＋沒有草稿不可能同時發生」的安全網在這個情境下事實上打不開（Codex 全鏈路審查 high）。
  const draftsByName = new Map(allDrafts.map((d) => [d.name, d.draft]));

  // 票 19 過渡期：樹先掛上讓導覽有入口，狀態機留給 Task 9
  const shell = (inner: ReactNode) => (
    <div className="tasks-root" data-testid="tasks-panel">
      <div className="tasks-split">
        <TasksTree data={overview} selected={selected} t={t}
          onSelect={(p) => {
            // 票 19 過渡期護欄：編輯中樹不動作。select() 不清 editing，放行的話編輯器會以另一個
            // project 重掛、存檔與草稿落到錯的專案；也不能從這裡 setEditing(null)／leaveEditor——
            // 那會繞過 TaskEditor.leave() 的離開流程（Codex R1）。Task 9 換成走編輯器離開流程。
            if (editing != null) return;
            if (p === null) back(); else select(p);
          }} />
        <div className="tasks-col">{inner}</div>
      </div>
    </div>
  );
  if (editing && selected != null && port != null) {
    return shell(
      // 目前兩個 return 讓返回必經型別切換（TaskEditor → TasksList），React 本來就會重掛，
      // 所以這把 key 現在不是唯一防線。留著是為未來「編輯器內直接換票」（editing 由 A 直接
      // 變 B、不經清單）預留——那條路徑一旦出現，草稿那半會自癒（unmount cleanup 的 deps 是
      // [project, task.name]），但 title／body／baseFp 只在 mount 初始化
      // （TaskEditor.tsx:44-48），沒有 key 就會讓 B 顯示 A 打的字（plan R3 F2）。
      <TaskEditor key={`${selected}:${editing.name}`}
        port={port} project={selected} projectName={projectName} task={editing}
        onSaved={saved} onLeave={leaveEditor} t={t} />,
    );
  }

  return shell(selected == null
    ? <TasksOverview data={overview} failed={failed} onSelect={select} t={t} />
    : <TasksList data={list} projectName={projectName} failed={failed} notice={notice}
        expandedName={expandedName} onExpand={setExpandedName}
        orphanDrafts={orphanDrafts} draftsByName={draftsByName}
        onOrphanDiscard={(name) => { clearDraft(selected, name); setReloadKey((k) => k + 1); }}
        onBack={back} onCreate={create}
        onCycle={cycle} onDelete={remove} onOpen={openInEditor} onEdit={edit}
        t={t} />);
}

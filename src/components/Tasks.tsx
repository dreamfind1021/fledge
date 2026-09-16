import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  TaskConflictError, createTask, deleteTask, fetchTasks, fetchTasksNote, fetchTasksOverview, openFile, updateTask,
  type TaskRow, type TaskStatus, type TasksListResponse, type TasksNote, type TasksOverview as TasksOverviewData,
} from "../lib/sidecar";
import { clearDraft, listDrafts } from "../lib/taskDraft";
import { NEXT_STATUS, TasksList } from "./TasksList";
import { TasksOverview } from "./TasksOverview";
import { TasksTree } from "./TasksTree";
import { TaskDetail, type DetailView } from "./TaskDetail";
import "./Tasks.css";

type Pane = null | { kind: "ticket"; name: string } | { kind: "note" };

// 待辦面板（票 19，spec §5.7）：樹｜清單｜票內容。所有 HTTP 一律經 src/lib/sidecar.ts。
// 直接 fetch 會漏掉 X-Fledge-Token，dev 看似正常、打包版整個死掉（plan §1.0）。
export function Tasks({ port, isActive }: { port: number | null; isActive: boolean }) {
  const { t } = useTranslation("tasks");
  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>(null);
  const [editing, setEditing] = useState(false);
  const [overview, setOverview] = useState<TasksOverviewData | null>(null);
  const [list, setList] = useState<TasksListResponse | null>(null);
  const [note, setNote] = useState<TasksNote | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState("");   // i18n key，空字串＝不顯示
  const [leaveRequest, setLeaveRequest] = useState(0);
  const pendingNav = useRef<(() => void) | null>(null);   // 編輯中被攔下的導覽，等編輯器放行再套用
  // 在途的改狀態請求（鍵＝專案路徑＋票檔名）。用 ref 不用 state：它只擋重複送出，
  // 不影響畫面，進 state 會多一輪不必要的 re-render。
  const inFlight = useRef(new Set<string>());
  const bump = useCallback(() => setReloadKey((k) => k + 1), []);

  // 視窗焦點重讀（design §5.5）；編輯中擋（spec §5.8）。
  // 不做即時檔案監看——使用者的節奏是「叫 AI 開票 → 之後才去看」，中間必然經過切換面板。
  // 編輯中不擋的話，切走再切回會用伺服器版本蓋掉正在打的字。
  useEffect(() => {
    if (!isActive || editing) return;
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, [isActive, editing, bump]);

  // 一條抓取路徑：總覽每次都抓，selected 非 null 時多抓清單（spec §5.8）。
  // cleanup 的 cancelled 就是請求世代——較舊的在途回應一律丟棄，不另造機制（Codex R3）。
  // editing 刻意不進依賴陣列（同舊註解：離開編輯不該自動觸發一次重讀；編輯結束的重讀由 onLeave/saved 主動 bump）。
  // 舊註解：這裡只需要「編輯中擋掉這一次重讀」，不需要「離開編輯這件事本身觸發一次新的重讀」。
  // 若放進依賴陣列，存檔成功離開編輯（editing 變回 false）會被 React 視為依賴變動而重跑整個
  // effect body——那一刻 editing 已經是 false，guard 讓它直接發出一次重讀，把 saved() 剛才本地
  // 更新好的新內容（新 fingerprint／新內文）蓋掉。真正該觸發重讀的時機（切分頁、切專案、
  // reloadKey 被主動 bump）都已經在別的依賴裡了。
  useEffect(() => {
    if (port == null || !isActive || editing) return;
    let cancelled = false;
    setFailed(false);
    const jobs: Promise<unknown>[] = [fetchTasksOverview(port).then((o) => { if (!cancelled) setOverview(o); })];
    if (selected != null) jobs.push(fetchTasks(port, selected).then((l) => { if (!cancelled) setList(l); }));
    Promise.all(jobs).catch(() => { if (!cancelled) setFailed(true); });   // 失敗顯錯誤態，不留空白
    return () => { cancelled = true; };
  }, [port, isActive, selected, reloadKey]);

  // 離場筆記：點「下一步」才打，不快取（spec §4.4）
  const noteOpen = pane?.kind === "note";
  useEffect(() => {
    if (port == null || selected == null || !noteOpen) { setNote(null); return; }
    let cancelled = false;
    setNote(null);
    fetchTasksNote(port, selected)
      .then((n) => { if (!cancelled) setNote(n); })
      .catch(() => { if (!cancelled) setNote({ status: "unavailable", content: null, mtime: null, path: null }); });
    return () => { cancelled = true; };
  }, [port, selected, noteOpen, reloadKey]);

  // 右欄的票永遠來自清單那份。清單回來但找不到那個檔名（外部刪了）→ 清 pane，**只在非編輯時**（Codex R4）
  const task = pane?.kind === "ticket" && list?.project === selected && list.tasks ? list.tasks.find((x) => x.name === pane.name) : undefined;
  useEffect(() => {
    if (editing || pane?.kind !== "ticket") return;
    if (list?.project === selected && list.tasks && !list.tasks.some((x) => x.name === pane.name)) setPane(null);
  }, [list, selected, pane, editing]);

  // 導覽：編輯中先交給編輯器的離開流程，草稿寫成功才套用（spec §5.7，Codex R1）
  const nav = useCallback((fn: () => void) => {
    if (editing) { pendingNav.current = fn; setLeaveRequest((k) => k + 1); }
    else fn();
  }, [editing]);
  // 切專案要重置 pane：票檔名在專案之間會撞名（每個專案都有 01-*.md），
  // 不清的話 A 選中的那張票的檔名剛好也在 B 出現，B 進來就無端反白了一張票。
  const selectProject = useCallback((path: string | null) => {
    if (path === selected) return;
    nav(() => { setList(null); setSelected(path); setPane(null); setNotice(""); });
  }, [nav, selected]);
  const selectTicket = useCallback((name: string) => nav(() => setPane((p) => (p?.kind === "ticket" && p.name === name ? null : { kind: "ticket", name }))), [nav]);
  const selectFromOverview = useCallback((path: string, name: string) => nav(() => { if (path !== selected) { setList(null); setSelected(path); } setPane({ kind: "ticket", name }); setNotice(""); }), [nav, selected]);
  const toggleNote = useCallback(() => nav(() => setPane((p) => (p?.kind === "note" ? null : { kind: "note" }))), [nav]);
  const closePane = useCallback(() => nav(() => setPane(null)), [nav]);

  // 進入編輯：同時 bump 一次——effect 重跑、cleanup 取消在途 GET、新 body 因 editing 直接返回（Codex R4）
  // 編輯鍵帶票：右欄沒選票、或正在看 A 卻按 B 的編輯，都要先把 pane 指到那張票（Codex plan R1 high）。
  // 編輯中所有編輯鍵都 disabled，所以這裡不會撞到「編輯中再編輯」
  const edit = useCallback((task: TaskRow) => { setPane({ kind: "ticket", name: task.name }); setEditing(true); bump(); }, [bump]);
  // 用回傳的票取代清單裡對應那筆（含新 fingerprint／新內容）。只在清單仍是發出請求時那個
  // 專案時才就地更新：回應晚到、使用者已切到 B，B 的同名票不能被 A 的回應蓋掉（Codex R2）。
  const replaceTask = useCallback((origin: string, updated: TaskRow) => {
    setList((cur) => (cur && cur.project === origin && cur.tasks
      ? { ...cur, tasks: cur.tasks.map((x) => (x.name === updated.name ? updated : x)) }
      : cur));
  }, []);
  // 編輯結束（儲存／離開／切走）都 bump 一次重讀（D12）。onSaved 的就地更新帶專案歸屬（Codex R2）
  const saved = useCallback((updated: TaskRow, origin: string) => {
    replaceTask(origin, updated);
    pendingNav.current = null;       // 使用者選擇留下並儲存，之前被攔的導覽作廢
    setEditing(false);
    bump();
  }, [bump, replaceTask]);
  // reload=true 只有 TaskEditor 的「捨棄我的版本」會傳（plan R2 F4）：把清單打成 loading
  // (setList(null)) 再重讀——不這樣做的話舊清單還在畫面上，使用者可以立刻再點編輯、
  // 帶著舊 fingerprint 再送一次，保證又是一次 409。
  const leaveEditor = useCallback((reload: boolean) => {
    setEditing(false);
    const fn = pendingNav.current;
    pendingNav.current = null;
    if (reload) setList(null);       // 「捨棄我的版本」：清單進 loading，重讀完才能再操作（plan R2 F4）
    if (fn) fn();
    bump();
  }, [bump]);

  // 寫入：成功就 bump（D12）；改狀態的就地更新帶專案歸屬（Codex R2）
  // 失敗處理共用：409 是「已被改過」，其餘一律通用錯誤。兩者都重讀，讓畫面回到真實狀態。
  const onActionError = useCallback((e: unknown) => {
    setNotice(e instanceof TaskConflictError ? "list.conflict" : "list.actionError");
    bump();
  }, [bump]);
  // 改狀態的共用底層（spec §5.6）：循環（記號）與擱置／取回（動作鍵）都走這裡，目標狀態由呼叫端決定
  const setStatus = useCallback((task: TaskRow, next: TaskStatus) => {
    if (port == null || selected == null || editing) return;   // 編輯中清單唯讀（D12）：按鈕 disabled 之外的第二道
    const origin = selected;
    // 同一張票同時只讓一個改狀態的請求在路上。少了這道鎖，快速連點會用**同一個
    // fingerprint** 送出兩次 PATCH：第一次成功後檔案的 fingerprint 就變了，第二次必然
    // 被判成 stale 而彈出「這張票已被改過」——使用者什麼都沒做錯卻看到錯誤訊息。
    // 鍵帶上專案路徑：切到別的專案時，同名票不該被上一個專案的在途請求擋住。
    const key = `${origin}\n${task.name}`;
    if (inFlight.current.has(key)) return;   // 同一張票同時只讓一個改狀態的請求在路上（既有）
    inFlight.current.add(key);
    setNotice("");
    updateTask(port, origin, task.name, next, task.fingerprint)
      // 用回傳的票取代本地狀態（含新 fingerprint）。少了這步，改一次之後本地的 fingerprint
      // 就過期了，下一次改狀態或刪除會被錯誤地判成 409（design §7.2）。
      .then((updated) => { replaceTask(origin, updated); bump(); })
      .catch(onActionError)
      .finally(() => inFlight.current.delete(key));
  }, [port, selected, editing, onActionError, bump, replaceTask]);
  const cycle = useCallback((task: TaskRow) => setStatus(task, NEXT_STATUS[task.status]), [setStatus]);
  // 擱置／取回：parked→todo、其餘→parked（spec §5.6）
  const park = useCallback((task: TaskRow) => setStatus(task, task.status === "parked" ? "todo" : "parked"), [setStatus]);
  // 建完重讀整份清單：新票的編號由 sidecar 配（最大號 +1），前端不自己算
  const create = useCallback(async (title: string) => {
    if (port == null || selected == null || editing) return;
    await createTask(port, selected, title);
    bump();
  }, [port, selected, editing, bump]);
  // 刪票時一併清草稿（spec §7.6：使用者自己刪的才清；票是外部消失的孤兒草稿不動）
  const remove = useCallback((task: TaskRow) => {
    if (port == null || selected == null || editing) return;
    const origin = selected;
    setNotice("");
    deleteTask(port, origin, task.name, task.fingerprint)
      .then(() => {
        clearDraft(origin, task.name);
        // 不在這裡清 pane：回應可能晚到、使用者已在看別張（spec §5.7）。刪掉之後 bump 重讀，
        // 上面那個「清單找不到選中的票 → pane = null」的 effect 會在非編輯時把它關掉——刪票只可能在非編輯時發生
        bump();
      })
      .catch(onActionError);
  }, [port, selected, editing, onActionError, bump]);

  // 用編輯器打開（design §5.2）。path 由 sidecar 組，前端不拼 `.fledge/tasks` 這個佈局。
  //
  // 票 01 起改走 sidecar 的 POST /api/open，**不再用 Tauri 的 openPath**。
  // capability 的白名單已一併移除，改回去會直接被拒。原因：glob 寫不出真正的邊界——
  // `$HOME/**` 放行整個家目錄，又讓家目錄以外的 root 用不了；而且 Tauri 在 Unix 上
  // require_literal_leading_dot 預設為 true，`$HOME/**` 連 `.fledge/` 都匹配不到，
  // 當時得再補一條寫死點目錄的規則才會動。
  // 收 path 不收票：離場筆記的「用編輯器打開」也走這裡（TaskDetail 的 onOpenNote）。
  const openInEditor = useCallback((path: string) => {
    if (port == null) return;                    // sidecar 還沒起來，與其他 handler 同一套守衛
    // status 非 ok（擋掉、檔案不見、平台不支援）也要報，否則使用者點了完全沒反應
    openFile(port, path)
      .then((r) => { if (r.status !== "ok") setNotice("list.actionError"); })
      .catch(() => setNotice("list.actionError"));
  }, [port]);

  // 清單與右欄的標題是專案名。名字從已載入的總覽推導，不另存一份 state——
  // 存兩份就會有一份過期，而且進到專案頁的入口都經過總覽（樹）那一列。
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
  const orphanDrafts = allDrafts.filter((d) => list?.tasks_status !== "absent" && !list?.tasks?.some((x) => x.name === d.name));
  const rescueDraft = task ? (allDrafts.find((d) => d.name === task.name)?.draft ?? null) : null;

  const view: DetailView =
    pane == null ? { kind: "empty" }
    : pane.kind === "note" ? { kind: "note", note }
    : task ? { kind: "ticket", task, rescueDraft }
    : { kind: "loading" };

  return (
    <div className="tasks-root" data-testid="tasks-panel">
      <div className="tasks-split" data-pane={pane ? "open" : "none"}>
        <TasksTree data={overview} selected={selected} onSelect={selectProject} t={t} />
        {selected == null ? (
          <div className="tasks-col tasks-col-all">
            {/* 窄等級：樹攤成一頁（CSS 只在窄時顯示） */}
            <TasksTree data={overview} selected={null} onSelect={selectProject} t={t} asPage />
            <TasksOverview data={overview} failed={failed} onSelect={selectFromOverview} t={t} />
          </div>
        ) : (
          <>
            <div className="tasks-col tasks-col-list">
              {/* key 綁專案：四區摺疊與輸入框在切專案時歸零（spec §5.4 第 7 點） */}
              <TasksList key={selected} data={list} projectName={projectName} failed={failed} notice={notice}
                selectedName={pane?.kind === "ticket" ? pane.name : null} onSelectTicket={selectTicket}
                showNote={noteOpen} onToggleNote={toggleNote} readOnly={editing}
                orphanDrafts={orphanDrafts}
                onOrphanDiscard={(name) => { clearDraft(selected, name); bump(); }}
                onBack={() => selectProject(null)} onCreate={create}
                onCycle={cycle} onPark={park} onDelete={remove} onOpen={(x) => openInEditor(x.path)} onEdit={edit}
                t={t} />
            </div>
            <div className="tasks-col tasks-col-detail">
              {port != null && (
                // key 綁專案＋檢視＋票：換票／換成筆記／切專案整個重掛，本地的確認／異常／已複製狀態不會沿用（Codex plan R2 high）
                <TaskDetail key={`${selected}\n${pane?.kind ?? "empty"}\n${pane?.kind === "ticket" ? pane.name : ""}`}
                  port={port} project={selected} projectName={projectName}
                  view={view} editing={editing && view.kind === "ticket"} leaveRequest={leaveRequest}
                  backLabel={projectName} onBack={closePane}
                  onCycle={cycle} onPark={park} onDelete={remove} onOpen={(x) => openInEditor(x.path)} onEdit={edit}
                  onOpenNote={openInEditor}
                  onSaved={(u) => saved(u, selected)} onLeave={leaveEditor} t={t} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, SquarePen, Trash2, TriangleAlert } from "lucide-react";
import { renderMarkdownLite } from "../lib/markdownLite";
import type { TaskRow, TasksListResponse } from "../lib/sidecar";

type T = (k: string, o?: Record<string, unknown>) => string;

// 點一下的循環（design §5.2）。三種狀態少到不需要下拉選單。
// 住在這裡是因為狀態按鈕的可及名稱要講出「點下去會變成什麼」——Tasks.tsx 從這裡 import。
export const NEXT_STATUS: Record<string, string> = { todo: "doing", doing: "done", done: "todo" };

// created 是 YYYY-MM-DD，判不出來時 sidecar 回空字串。只顯示月-日：backlog 幾乎都是當年的，
// 年份佔四個字寬卻幾乎不帶資訊。認不得的格式一律不畫，不做猜測性的切字。
const monthDay = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : "");

function Ticket({ task, onCycle, onDelete, onOpen, onEdit, t }: {
  task: TaskRow;
  onCycle: (task: TaskRow) => void;
  onDelete: (task: TaskRow) => void;
  onOpen: (task: TaskRow) => void;
  onEdit: (task: TaskRow) => void;
  t: T;
}) {
  const [openFlag, setOpenFlag] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const date = monthDay(task.created);
  // runtime JSON 沒驗證：缺欄、非布林一律當不可編輯，fail-safe 落在不給編輯那側（spec §3）
  const editable = task.editable === true;
  // 列上原有的按鈕不得因此被觸發兩次行為（spec §6.1）：每顆都 stopPropagation
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div className={`tk is-${task.status}`}>
      <div className="tk-row" role="button" tabIndex={0}
        aria-label={expanded ? t("a11y.collapseTicket") : t("a11y.expandTicket")}
        aria-expanded={expanded}
        onClick={() => setExpanded((x) => !x)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;   // 巢狀按鈕自己的鍵盤啟動不該被列吃掉：
                                                        // 在冒泡途中 preventDefault 會取消瀏覽器合成 click，
                                                        // 那顆按鈕的 onClick 連觸發的機會都沒有
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((x) => !x); }
        }}>
        {/* 狀態記號＝狀態按鈕：點一下循環 todo → doing → done → todo（design §5.2）。
            三態要有三種**輪廓**：空心方／實心方／打勾。只差顏色不夠——doing 與 done 若都是
            實心方塊，色覺障礙或單色顯示下就分不開（Codex 審查 medium）。
            可及名稱必須帶「現在是什麼」＋「點下去會變什麼」：aria-label 會蓋掉 title 與內文，
            光寫「切換狀態」會讓報讀使用者完全聽不出這張票的狀態。 */}
        <button className={`tk-mark is-${task.status}`}
          aria-label={t("a11y.statusCycle", {
            current: t(`status.${task.status}`),
            next: t(`status.${NEXT_STATUS[task.status] ?? "todo"}`),
          })}
          title={t(`status.${task.status}`)} onClick={stop(() => onCycle(task))}>
          {task.status === "done" ? <Check size={12} strokeWidth={3} /> : null}
        </button>
        <span className="tk-num">{task.number ?? t("list.noNumber")}</span>
        <span className="tk-title">{task.title}</span>
        {task.anomalies.length > 0 && (
          <button className="tk-flag" aria-label={t("anomaly.label")} title={t("anomaly.label")}
            onClick={stop(() => setOpenFlag((o) => !o))}>
            <TriangleAlert size={12} strokeWidth={2} />
          </button>
        )}
        {task.source ? <span className={`tk-src is-${task.source}`}>{t(`source.${task.source}`)}</span> : null}
        {date ? <span className="tk-date">{date}</span> : null}
        {/* 動作滑過才顯形（用 opacity，不是 display：位置得留著，否則整列會在 hover 時跳動）。
            CSS 另有 :focus-within，鍵盤 Tab 進來一樣看得到。 */}
        <span className="tk-acts">
          {editable && (
            <button className="tk-act" aria-label={t("list.edit")} title={t("list.edit")} onClick={stop(() => onEdit(task))}>
              <Pencil size={13} strokeWidth={2} />
            </button>
          )}
          {/* 要寫內文就開檔案（design §5.2）——刻意不做票詳情編輯表單 */}
          <button className="tk-act" aria-label={t("a11y.openInEditor")} title={t("a11y.openInEditor")}
            onClick={stop(() => onOpen(task))}>
            <SquarePen size={13} strokeWidth={2} />
          </button>
          <button className="tk-act is-danger" aria-label={t("list.delete")} title={t("list.delete")}
            onClick={stop(() => setConfirming(true))}>
            <Trash2 size={13} strokeWidth={2} />
          </button>
        </span>
      </div>
      {expanded && (
        <div className="tk-body">
          {task.body
            ? <div className="tk-md">{renderMarkdownLite(task.body)}</div>
            : <div className="tk-empty">{t("list.noBody")}</div>}
          {!editable && <div className="tk-noedit">{t("list.notEditable")}</div>}
        </div>
      )}
      {/* 以下兩個區塊（刪除確認、異常說明）與現有程式碼完全相同，原封保留 */}
      {confirming && (
        // 先跳確認（design §5.2）：檔案直接消失，而 .fledge/ 不進 git，刪了救不回
        <div className="tk-confirm">
          <span>{t("list.confirmDelete")}</span>
          <button className="tk-confirm-yes" onClick={() => { setConfirming(false); onDelete(task); }}>
            {t("list.delete")}
          </button>
          <button className="tk-confirm-no" onClick={() => setConfirming(false)}>{t("list.cancel")}</button>
        </div>
      )}
      {openFlag && (
        // design §6.2：「標記異常」＝ 照常顯示該票、用預設值、在該列加一個記號，
        // **點開說明是哪個檔案、哪裡不對**。異常不是隱藏。
        <div className="tk-flagbody">
          <div className="tk-file">{task.name}</div>
          <ul>{task.anomalies.map((a) => <li key={a}>{t(`anomaly.${a}`)}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// 第二層：進行中 → 待辦 → 已完成（摺疊）。**做完不刪檔案**——
// 上一版的第一條結構性缺陷就是「完成即移除在燒資產」。
export function TasksList({ data, projectName, failed, notice, onBack, onCreate, onCycle, onDelete, onOpen, onEdit, t }: {
  data: TasksListResponse | null;
  projectName: string;
  failed: boolean;
  notice: string;
  onBack: () => void;
  onCreate: (title: string) => Promise<void>;
  onCycle: (task: TaskRow) => void;
  onDelete: (task: TaskRow) => void;
  onOpen: (task: TaskRow) => void;
  onEdit: (task: TaskRow) => void;
  t: T;
}) {
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  // 一行輸入建票（design §5.2）。要寫內文得開檔案——刻意不做票詳情編輯表單。
  const submit = () => {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true); setCreateFailed(false);
    onCreate(title)
      .then(() => setDraft(""))
      .catch(() => setCreateFailed(true))
      .finally(() => setBusy(false));
  };

  const back = (
    <button className="tasks-back" onClick={onBack}>
      <ChevronLeft size={14} strokeWidth={2} />{t("list.back")}
    </button>
  );
  const head = (sum?: string) => (
    <div className="tasks-head">
      <h1>{projectName}</h1>
      {sum ? <span className="tasks-sum">{sum}</span> : null}
    </div>
  );

  if (failed) return <div className="tasks-pane">{back}{head()}<div className="tasks-note is-error">{t("overview.loadError")}</div></div>;
  if (data == null) return <div className="tasks-pane">{back}{head()}<div className="tasks-note">{t("overview.loading")}</div></div>;
  if (data.tasks == null) {
    // 讀不到 → 錯誤態，**不是空清單**（design §6.3）：空清單與「這個專案沒待辦」長得一樣
    return <div className="tasks-pane">{back}{head()}<div className="tasks-note is-error">{t("list.unavailable")}</div></div>;
  }

  const doing = data.tasks.filter((x) => x.status === "doing");
  const done = data.tasks.filter((x) => x.status === "done");
  // 用「兩者皆非」而不是 === "todo"：三個分區加起來必須覆蓋整份清單，
  // 否則哪天多一個狀態值，那些票會從畫面上無聲消失。
  const todo = data.tasks.filter((x) => x.status !== "doing" && x.status !== "done");
  const row = (x: TaskRow) => (
    <Ticket key={x.name} task={x} onCycle={onCycle} onDelete={onDelete} onOpen={onOpen} onEdit={onEdit} t={t} />
  );
  const section = (label: string, n: number) => (
    <div className="tasks-sec">
      <span className="tasks-sec-lab">{label}</span>
      <span className="tasks-sec-line" />
      <span className="tasks-sec-n">{n}</span>
    </div>
  );

  return (
    <div className="tasks-pane">
      {back}
      {head(t("list.summary", { doing: doing.length, todo: todo.length, done: done.length }))}
      {data.next_step ? (
        <div className="tasks-next">
          <div className="tasks-next-lab">{t("overview.nextStep")}</div>
          <div className="tasks-next-tx">{data.next_step}</div>
        </div>
      ) : null}
      <form className="tasks-new" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input
          className="tasks-new-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("list.newPlaceholder")}
          aria-label={t("list.newPlaceholder")}
        />
        <button className="tasks-new-btn" type="submit" disabled={!draft.trim() || busy}>{t("list.add")}</button>
      </form>
      {createFailed ? <div className="tasks-note is-error">{t("list.createError")}</div> : null}
      {notice ? <div className="tasks-note is-error">{t(notice)}</div> : null}
      {data.tasks.length === 0 ? (
        <div className="tasks-note">{t("list.empty")}</div>
      ) : (
        <>
          {/* 空的區整段不畫——留一個 0 的標頭只是噪音 */}
          {doing.length > 0 && <>{section(t("list.doing"), doing.length)}{doing.map(row)}</>}
          {todo.length > 0 && <>{section(t("list.todo"), todo.length)}{todo.map(row)}</>}
          {done.length > 0 && (
            <>
              <button className="tasks-sec is-toggle" onClick={() => setShowDone((s) => !s)}
                aria-label={showDone ? t("a11y.collapseDone") : t("a11y.expandDone")}>
                {showDone ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="tasks-sec-lab">{t("list.done")}</span>
                <span className="tasks-sec-line" />
                <span className="tasks-sec-n">{done.length}</span>
              </button>
              {showDone && done.map(row)}
            </>
          )}
        </>
      )}
    </div>
  );
}

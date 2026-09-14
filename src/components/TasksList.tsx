import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Pencil, SquarePen, Trash2, TriangleAlert } from "lucide-react";
import { renderMarkdownLite } from "../lib/markdownLite";
import { writeClipboard } from "../lib/clipboard";
import type { TaskDraft } from "../lib/taskDraft";
import type { TaskRow, TasksListResponse } from "../lib/sidecar";

type T = (k: string, o?: Record<string, unknown>) => string;

// 點一下的循環（design §5.2）。三種狀態少到不需要下拉選單。
// 住在這裡是因為狀態按鈕的可及名稱要講出「點下去會變成什麼」——Tasks.tsx 從這裡 import。
export const NEXT_STATUS: Record<string, string> = { todo: "doing", doing: "done", done: "todo" };

// created 是 YYYY-MM-DD，判不出來時 sidecar 回空字串。只顯示月-日：backlog 幾乎都是當年的，
// 年份佔四個字寬卻幾乎不帶資訊。認不得的格式一律不畫，不做猜測性的切字。
const monthDay = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : "");

function Ticket({ task, expanded, onToggle, onCycle, onDelete, onOpen, onEdit, rescueDraft, t }: {
  task: TaskRow;
  expanded: boolean;
  onToggle: () => void;
  onCycle: (task: TaskRow) => void;
  onDelete: (task: TaskRow) => void;
  onOpen: (task: TaskRow) => void;
  onEdit: (task: TaskRow) => void;
  rescueDraft: TaskDraft | null;
  t: T;
}) {
  const [openFlag, setOpenFlag] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // 這張票的救援草稿是否已複製——票寫壞（editable:false）時編輯入口沒了，
  // 這是唯一救得回內容的地方，複製回饋不能像 onClick 直丟一樣悄悄失敗。
  const [rescueCopied, setRescueCopied] = useState(false);
  // 展開狀態改由父層（Tasks.tsx 的 expandedName）控制，不再是本地 state——
  // 從編輯器返回時這個 Ticket 會重新 mount，本地 state 會被重置成收起，
  // 「保持展開」（spec §6.2）就做不到。
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
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;   // 巢狀按鈕自己的鍵盤啟動不該被列吃掉：
                                                        // 在冒泡途中 preventDefault 會取消瀏覽器合成 click，
                                                        // 那顆按鈕的 onClick 連觸發的機會都沒有
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
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
          {/* 票寫壞了但檔名還在清單裡：草稿不是孤兒，不會出現在孤兒草稿列，這裡是唯一救得回
              內容的地方（Codex 全鏈路審查 high）。不給丟棄——這張票還在，檔案可能還救得回來，
              在壞檔旁邊放一顆一鍵刪除使用者文字唯一副本的按鈕，跟「救援」的目的正相反。 */}
          {!editable && rescueDraft && (
            <div className="tk-banner is-draft">
              <span className="btext">{t("list.draftFound")}</span>
              {rescueCopied && <span className="btext">{t("list.copied")}</span>}
              <span className="bacts">
                <button className="bbtn"
                  onClick={() => writeClipboard(`# ${rescueDraft.title}\n\n${rescueDraft.body}`).then((ok) => ok && setRescueCopied(true))}>
                  {t("list.copyMine")}
                </button>
              </span>
            </div>
          )}
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
const COPIED_FEEDBACK_MS = 2000;

// 票 21：state.md 末尾的「貼進新對話的指令」（handoff skill 寫的，一般收工不會有）。
// 預設摺疊只露第一行——這一頁的主角是票清單，指令只在要換對話那一刻才用到。
// 全文一直在 DOM 裡、靠樣式截斷，所以複製永遠拿到整段，不是露出的那一行。
// 互動跟一張票同一套（使用者驗收時要求）：整個框是按鈕、點了展開／收合；
// 複製是框尾的圖示、滑過才亮、沒有文字。複製成功換成勾兩秒，可及名稱換成「已複製」。
function HandoffCommand({ text, t }: { text: string; t: T }) {
  const [folded, setFolded] = useState(true);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  const toggle = () => setFolded((f) => !f);
  const copy = () => writeClipboard(text).then((ok) => {
    // 卸載可能發生在寫入完成前——cleanup 已經跑過，此時再排 timer 就沒人清得掉
    if (!ok || !mounted.current) return;   // 失敗不謊稱已複製
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  });
  const copyLabel = t(copied ? "list.copied" : "list.handoffCopy");
  return (
    <div className={folded ? "tasks-cmd is-folded" : "tasks-cmd"}>
      <div className="tasks-cmd-lab">{t("list.handoffLabel")}</div>
      <div className="tasks-cmd-row" role="button" tabIndex={0} aria-expanded={!folded}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;   // 同 .tk-row：巢狀按鈕的鍵盤啟動不該被框吃掉
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        }}>
        <pre className="tasks-cmd-pre">{text}</pre>
        <span className="tasks-cmd-acts">
          <button className={copied ? "tasks-cmd-act is-done" : "tasks-cmd-act"} aria-label={copyLabel} title={copyLabel}
            onClick={(e) => { e.stopPropagation(); copy(); }}>
            {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2} />}
          </button>
        </span>
      </div>
    </div>
  );
}

export function TasksList({
  data, projectName, failed, notice, onBack, onCreate, onCycle, onDelete, onOpen, onEdit,
  expandedName, onExpand, orphanDrafts, draftsByName, onOrphanDiscard, t,
}: {
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
  expandedName: string | null;
  onExpand: (name: string | null) => void;
  orphanDrafts: Array<{ name: string; draft: TaskDraft }>;
  draftsByName: Map<string, TaskDraft>;
  onOrphanDiscard: (name: string) => void;
  t: T;
}) {
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  // 孤兒草稿的複製回饋。writeClipboard 永不 throw，失敗只在自己檔案裡 console.warn——
  // 呼叫端不接回傳值就等於使用者按了複製、畫面完全沒反應，而正右邊就是不可回復的
  // 「丟棄」，靜默失敗會讓使用者誤以為已經存到剪貼簿而放心丟棄，內容就真的救不回來了。
  const [copiedDraft, setCopiedDraft] = useState<string | null>(null);

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
    // 目錄讀不到時（spec §7.4）：草稿留著，但不列出、不提供丟棄——沒有清單可以比對，
    // 分不出哪些是真孤兒、哪些只是暫時讀不到，這種情況下什麼都不動最安全。
    return <div className="tasks-pane">{back}{head()}
      <div className="tasks-note is-error">{t("list.unavailable")}</div>
      {orphanDrafts.length > 0 && <div className="tasks-note">{t("list.orphanUnavailable")}</div>}
    </div>;
  }

  const doing = data.tasks.filter((x) => x.status === "doing");
  const done = data.tasks.filter((x) => x.status === "done");
  // 用「兩者皆非」而不是 === "todo"：三個分區加起來必須覆蓋整份清單，
  // 否則哪天多一個狀態值，那些票會從畫面上無聲消失。
  const todo = data.tasks.filter((x) => x.status !== "doing" && x.status !== "done");
  const row = (x: TaskRow) => (
    <Ticket key={x.name} task={x} expanded={expandedName === x.name}
      onToggle={() => onExpand(expandedName === x.name ? null : x.name)}
      rescueDraft={draftsByName.get(x.name) ?? null}
      onCycle={onCycle} onDelete={onDelete} onOpen={onOpen} onEdit={onEdit} t={t} />
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
      {/* key 綁專案：換專案時摺疊與「已複製」都歸零，不把上一個專案的展開態帶過來 */}
      {data.handoff_command ? <HandoffCommand key={data.project} text={data.handoff_command} t={t} /> : null}
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
      {/* 孤兒草稿（spec §7.4）：票已不在清單裡，只給複製與丟棄，不提供「重建成新票」——
          清單頂端，一張票一條，跟其他票列分開，使用者一眼能看出這不是正常的票 */}
      {orphanDrafts.map(({ name, draft }) => (
        <div key={name} className="tk-banner is-draft">
          <span className="btext">{t("list.orphanDraft", { title: draft.title })}</span>
          {copiedDraft === name && <span className="btext">{t("list.copied")}</span>}
          <span className="bacts">
            <button className="bbtn"
              onClick={() => writeClipboard(`# ${draft.title}\n\n${draft.body}`).then((ok) => ok && setCopiedDraft(name))}>
              {t("list.copyMine")}
            </button>
            <button className="bbtn" onClick={() => onOrphanDiscard(name)}>{t("list.draftDiscard")}</button>
          </span>
        </div>
      ))}
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

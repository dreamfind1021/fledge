import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Pause, Pencil, SquarePen, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { writeClipboard } from "../lib/clipboard";
import type { TaskDraft } from "../lib/taskDraft";
import type { TaskRow, TaskStatus, TasksListResponse } from "../lib/sidecar";

type T = (k: string, o?: Record<string, unknown>) => string;

// 點一下的循環（design §5.2）：三態不變。parked 不在環裡，但點它的記號回 todo（＝取回），
// 所以 `NEXT_STATUS[status]` 對四種值都有定義，不再需要 `?? "todo"` 的 fallback（spec §5.6）。
// 住在這裡是因為狀態按鈕的可及名稱要講出「點下去會變成什麼」——Tasks.tsx 從這裡 import。
export const NEXT_STATUS: Record<TaskStatus, TaskStatus> = { todo: "doing", doing: "done", done: "todo", parked: "todo" };

// created 是 YYYY-MM-DD，判不出來時 sidecar 回空字串。只顯示月-日：backlog 幾乎都是當年的，
// 年份佔四個字寬卻幾乎不帶資訊。認不得的格式一律不畫，不做猜測性的切字。
const monthDay = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : "");

function Ticket({ task, active, readOnly, onSelect, onCycle, onPark, onDelete, onOpen, onEdit, t }: {
  task: TaskRow; active: boolean; readOnly: boolean;
  onSelect: (task: TaskRow) => void; onCycle: (task: TaskRow) => void; onPark: (task: TaskRow) => void;
  onDelete: (task: TaskRow) => void; onOpen: (task: TaskRow) => void; onEdit: (task: TaskRow) => void; t: T;
}) {
  const [openFlag, setOpenFlag] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // 編輯中清單唯讀（D12）連已經展開的刪除確認也要收掉：否則先展開確認、再進編輯，確認鍵仍能送 DELETE
  // ——甚至刪掉正在編輯的票（Codex plan R1 high）
  useEffect(() => { if (readOnly) setConfirming(false); }, [readOnly]);
  const date = monthDay(task.created);
  // runtime JSON 沒驗證：缺欄、非布林一律當不可編輯，fail-safe 落在不給編輯那側（spec §3）
  const editable = task.editable === true;
  // 列上原有的按鈕不得因此被觸發兩次行為（spec §6.1）：每顆都 stopPropagation
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  const parked = task.status === "parked";
  return (
    <div className={`tk is-${task.status}`}>
      {/* 點列＝選中（右欄顯示它），不再原地展開（spec §5.4）。同一張再點由父層變 null */}
      <div className={`tk-row${active ? " active" : ""}`} role="button" tabIndex={0}
        aria-label={t(active ? "a11y.deselectTicket" : "a11y.selectTicket")} aria-pressed={active}
        onClick={() => onSelect(task)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;   // 巢狀按鈕自己的鍵盤啟動不該被列吃掉：
                                                        // 在冒泡途中 preventDefault 會取消瀏覽器合成 click，
                                                        // 那顆按鈕的 onClick 連觸發的機會都沒有
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(task); }
        }}>
        {/* 狀態記號＝狀態按鈕：點一下循環 todo → doing → done → todo（design §5.2）；parked 點了回 todo。
            四態要有四種**輪廓**：空心方／實心方／打勾／虛線空心方。只差顏色不夠——doing 與 done 若都是
            實心方塊，色覺障礙或單色顯示下就分不開（Codex 審查 medium）。
            可及名稱必須帶「現在是什麼」＋「點下去會變什麼」：aria-label 會蓋掉 title 與內文，
            光寫「切換狀態」會讓報讀使用者完全聽不出這張票的狀態。 */}
        <button className={`tk-mark is-${task.status}`} disabled={readOnly}
          aria-label={t("a11y.statusCycle", { current: t(`status.${task.status}`), next: t(`status.${NEXT_STATUS[task.status]}`) })}
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
        {/* 四顆動作（spec §5.4）。編輯中（readOnly）全部 disabled：清單唯讀（D12）。
            滑過才顯形（用 opacity，不是 display：位置得留著，否則整列會在 hover 時跳動）。
            CSS 另有 :focus-within，鍵盤 Tab 進來一樣看得到。 */}
        <span className="tk-acts">
          {editable && (
            <button className="tk-act" disabled={readOnly} aria-label={t("list.edit")} title={t("list.edit")} onClick={stop(() => onEdit(task))}>
              <Pencil size={13} strokeWidth={2} />
            </button>
          )}
          {/* 要寫內文就開檔案（design §5.2）——刻意不做票詳情編輯表單 */}
          <button className="tk-act" disabled={readOnly} aria-label={t("a11y.openInEditor")} title={t("a11y.openInEditor")} onClick={stop(() => onOpen(task))}>
            <SquarePen size={13} strokeWidth={2} />
          </button>
          <button className="tk-act" disabled={readOnly} aria-label={t(parked ? "list.unpark" : "list.park")} title={t(parked ? "list.unpark" : "list.park")}
            onClick={stop(() => onPark(task))}>
            {parked ? <Undo2 size={13} strokeWidth={2} /> : <Pause size={13} strokeWidth={2} />}
          </button>
          <button className="tk-act is-danger" disabled={readOnly} aria-label={t("list.delete")} title={t("list.delete")} onClick={stop(() => setConfirming(true))}>
            <Trash2 size={13} strokeWidth={2} />
          </button>
        </span>
      </div>
      {confirming && !readOnly && (
        // 先跳確認（design §5.2）：檔案直接消失，而 .fledge/ 不進 git，刪了救不回
        <div className="tk-confirm">
          <span>{t("list.confirmDelete")}</span>
          <button className="tk-confirm-yes" disabled={readOnly} onClick={() => { setConfirming(false); onDelete(task); }}>{t("list.delete")}</button>
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

// 第二層：進行中 → 待辦 → 擱置 → 已完成，四區都可摺疊（spec §5.4）。**做完不刪檔案**——
// 上一版的第一條結構性缺陷就是「完成即移除在燒資產」。
const COPIED_FEEDBACK_MS = 2000;
// 摺疊標頭的 a11y key 是 `a11y.expandDoing`／`a11y.collapseDoing` 這種型式：區名首字大寫接在後面
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

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
  data, projectName, failed, notice, selectedName, onSelectTicket, showNote, onToggleNote, readOnly,
  orphanDrafts, onOrphanDiscard, onBack, onCreate, onCycle, onPark, onDelete, onOpen, onEdit, t,
}: {
  data: TasksListResponse | null;
  projectName: string;
  failed: boolean;
  notice: string;
  selectedName: string | null;               // 反白哪張票（右欄正在顯示的）
  onSelectTicket: (name: string) => void;    // 點列；同一張再點＝父層負責變 null
  showNote: boolean;
  onToggleNote: () => void;
  readOnly: boolean;                         // 編輯中：一行輸入、狀態記號、四顆動作全部 disabled
  orphanDrafts: Array<{ name: string; draft: TaskDraft }>;
  onOrphanDiscard: (name: string) => void;
  onBack: () => void;
  onCreate: (title: string) => Promise<void>;
  onCycle: (task: TaskRow) => void;
  onPark: (task: TaskRow) => void;           // parked→todo、其餘→parked，目標由父層決定
  onDelete: (task: TaskRow) => void;
  onOpen: (task: TaskRow) => void;
  onEdit: (task: TaskRow) => void;
  t: T;
}) {
  // 四區各自摺疊：進行中／待辦預設展開，擱置／已完成預設收起（spec §5.4）
  const [open, setOpen] = useState({ doing: true, todo: true, parked: false, done: false });
  const toggle = (k: keyof typeof open) => setOpen((o) => ({ ...o, [k]: !o[k] }));
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
  const parked = data.tasks.filter((x) => x.status === "parked");
  const done = data.tasks.filter((x) => x.status === "done");
  // 用「三者皆非」而不是 === "todo"：四個分區加起來必須覆蓋整份清單，多一個狀態值時那些票才不會無聲消失
  const todo = data.tasks.filter((x) => x.status !== "doing" && x.status !== "parked" && x.status !== "done");
  const row = (x: TaskRow) => (
    <Ticket key={x.name} task={x} active={selectedName === x.name} readOnly={readOnly}
      onSelect={(task) => onSelectTicket(task.name)}
      onCycle={onCycle} onPark={onPark} onDelete={onDelete} onOpen={onOpen} onEdit={onEdit} t={t} />
  );
  // 空的區整段不畫——留一個 0 的標頭只是噪音
  const fold = (k: keyof typeof open, label: string, items: TaskRow[]) => items.length > 0 && (
    <>
      <button className="tasks-sec is-toggle" onClick={() => toggle(k)}
        aria-label={t(open[k] ? `a11y.collapse${cap(k)}` : `a11y.expand${cap(k)}`)} aria-expanded={open[k]}>
        {open[k] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="tasks-sec-lab">{label}</span><span className="tasks-sec-line" /><span className="tasks-sec-n">{items.length}</span>
      </button>
      {open[k] && items.map(row)}
    </>
  );

  return (
    <div className="tasks-pane">
      {back}
      {head(t("list.summary", { doing: doing.length, todo: todo.length, parked: parked.length, done: done.length }))}
      {data.next_step ? (
        // 整塊可點 → 右欄顯示離場筆記（spec §5.4 第 3 點）。右上只有一個「›」，沒有文字（使用者要求）
        <div className={`tasks-next${showNote ? " is-on" : ""}`} role="button" tabIndex={0}
          aria-label={t(showNote ? "a11y.hideNote" : "a11y.showNote")} aria-pressed={showNote}
          onClick={onToggleNote}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleNote(); } }}>
          <div className="tasks-next-lab">{t("overview.nextStep")}<span className="tasks-next-more" aria-hidden="true">›</span></div>
          <div className="tasks-next-tx">{data.next_step}</div>
        </div>
      ) : null}
      {/* key 綁專案：換專案時摺疊與「已複製」都歸零，不把上一個專案的展開態帶過來 */}
      {data.handoff_command ? <HandoffCommand key={data.project} text={data.handoff_command} t={t} /> : null}
      <form className="tasks-new" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input className="tasks-new-input" value={draft} disabled={readOnly} onChange={(e) => setDraft(e.target.value)}
          placeholder={t("list.newPlaceholder")} aria-label={t("list.newPlaceholder")} />
        <button className="tasks-new-btn" type="submit" disabled={readOnly || !draft.trim() || busy}>{t("list.add")}</button>
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
      {data.tasks.length === 0 ? <div className="tasks-note">{t("list.empty")}</div> : (
        <>
          {fold("doing", t("list.doing"), doing)}
          {fold("todo", t("list.todo"), todo)}
          {fold("parked", t("list.parked"), parked)}
          {fold("done", t("list.done"), done)}
        </>
      )}
    </div>
  );
}

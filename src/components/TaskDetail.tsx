import { useEffect, useState } from "react";
import { Check, ChevronLeft, Pause, Pencil, SquarePen, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { renderMarkdownLite } from "../lib/markdownLite";
import { writeClipboard } from "../lib/clipboard";
import type { TaskDraft } from "../lib/taskDraft";
import type { TaskRow, TasksNote } from "../lib/sidecar";
import { NEXT_STATUS } from "./TasksList";
import { TaskEditor } from "./TaskEditor";

type T = (k: string, o?: Record<string, unknown>) => string;

export type DetailView =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "ticket"; task: TaskRow; rescueDraft: TaskDraft | null }
  | { kind: "note"; note: TasksNote | null };

const pad2 = (n: number | null, dash: string) => (n == null ? dash : String(n).padStart(2, "0"));

// 右欄（spec §5.5）。資料一律由父層解好再傳進來——這裡不 fetch、不找票；
// 「清單找不到票就清右欄」那條規則住在 Tasks.tsx（編輯中不適用，Codex R4）。
export function TaskDetail({
  port, project, projectName, view, editing, leaveRequest, backLabel, onBack,
  onCycle, onPark, onDelete, onOpen, onEdit, onOpenNote, onSaved, onLeave, t,
}: {
  port: number; project: string; projectName: string;
  view: DetailView; editing: boolean; leaveRequest: number;
  backLabel: string; onBack: () => void;
  onCycle: (task: TaskRow) => void; onPark: (task: TaskRow) => void; onDelete: (task: TaskRow) => void;
  onOpen: (task: TaskRow) => void; onEdit: (task: TaskRow) => void; onOpenNote: (path: string) => void;
  onSaved: (updated: TaskRow) => void; onLeave: (reload: boolean, viaRequest: boolean) => void;
  t: T;
}) {
  const [confirming, setConfirming] = useState(false);
  const [openFlag, setOpenFlag] = useState(false);
  const [copied, setCopied] = useState(false);
  // 確認、異常說明、已複製都是「這一張票、這一種檢視」的本地狀態：換票、換成筆記、進出編輯都要歸零。
  // 父層另用 key 讓元件整個重掛（Task 9），這裡是第二道——確認鍵的 onDelete(task) 指向的是當下的票，
  // 沿用上一張票的確認等於讓使用者刪掉沒發起刪除的票（Codex plan R2 high）
  const identity = view.kind === "ticket" ? `ticket:${view.task.name}` : view.kind;
  useEffect(() => { setConfirming(false); setOpenFlag(false); setCopied(false); }, [identity, editing]);
  const back = <button className="tasks-back" onClick={onBack}><ChevronLeft size={14} strokeWidth={2} />{backLabel}</button>;

  if (view.kind === "empty") return <div className="lb-detail is-empty"><div className="d-hint">{t("detail.hint")}</div></div>;
  if (view.kind === "loading") return <div className="lb-detail">{back}<div className="tasks-note">{t("detail.loading")}</div></div>;

  if (view.kind === "note") {
    const { note } = view;
    return (
      <div className="lb-detail">
        {back}
        <div className="d-crumb">{projectName} / .fledge/state.md</div>
        <h2 className="d-title">{t("detail.noteTitle")}</h2>
        {note == null ? <div className="tasks-note">{t("detail.loading")}</div> : note.status === "ok" && note.content != null ? (
          <>
            <div className="d-meta">
              <span>{t("detail.noteUpdated", { date: note.mtime ?? "" })}</span>
              {note.path && (
                <span className="d-acts">
                  <button className="tk-act" aria-label={t("a11y.openInEditor")} title={t("a11y.openInEditor")} onClick={() => onOpenNote(note.path!)}>
                    <SquarePen size={13} strokeWidth={2} />
                  </button>
                </span>
              )}
            </div>
            <div className="d-body"><div className="tk-md">{renderMarkdownLite(note.content)}</div></div>
          </>
        ) : <div className="tasks-note is-error">{t("detail.noteUnavailable")}</div>}
      </div>
    );
  }

  const { task, rescueDraft } = view;
  if (editing) {
    return (
      <div className="lb-detail is-editing">
        {/* key 綁專案＋檔名：編輯器內直接換票的路徑現在存在了（spec §5.5.3） */}
        <TaskEditor key={`${project}:${task.name}`} port={port} project={project} projectName={projectName} task={task}
          onSaved={onSaved} onLeave={onLeave} leaveRequest={leaveRequest} t={t} />
      </div>
    );
  }
  const editable = task.editable === true;
  const parked = task.status === "parked";
  return (
    <div className="lb-detail">
      {back}
      <div className="d-crumb">{projectName} / {pad2(task.number, t("list.noNumber"))}</div>
      <h2 className="d-title">{task.title}</h2>
      <div className="d-meta">
        <span className="st">
          <button className={`tk-mark is-${task.status}`}
            aria-label={t("a11y.statusCycle", { current: t(`status.${task.status}`), next: t(`status.${NEXT_STATUS[task.status]}`) })}
            title={t(`status.${task.status}`)} onClick={() => onCycle(task)}>
            {task.status === "done" ? <Check size={12} strokeWidth={3} /> : null}
          </button>
          {t(`status.${task.status}`)}
        </span>
        {task.source ? <span>{t("detail.source", { who: t(`source.${task.source}`) })}</span> : null}
        {task.created ? <span>{t("detail.created", { date: task.created })}</span> : null}
        {task.anomalies.length > 0 && (
          <button className="tk-flag" aria-label={t("anomaly.label")} title={t("anomaly.label")} onClick={() => setOpenFlag((o) => !o)}>
            <TriangleAlert size={12} strokeWidth={2} />
          </button>
        )}
        {/* 四顆動作在資訊列右側（D7）：內文再長也壓不到它們。常駐顯示——這裡只有一張票 */}
        <span className="d-acts">
          {editable && (
            <button className="tk-act" aria-label={t("list.edit")} title={t("list.edit")} onClick={() => onEdit(task)}><Pencil size={13} strokeWidth={2} /></button>
          )}
          <button className="tk-act" aria-label={t("a11y.openInEditor")} title={t("a11y.openInEditor")} onClick={() => onOpen(task)}><SquarePen size={13} strokeWidth={2} /></button>
          <button className="tk-act" aria-label={t(parked ? "list.unpark" : "list.park")} title={t(parked ? "list.unpark" : "list.park")} onClick={() => onPark(task)}>
            {parked ? <Undo2 size={13} strokeWidth={2} /> : <Pause size={13} strokeWidth={2} />}
          </button>
          <button className="tk-act is-danger" aria-label={t("list.delete")} title={t("list.delete")} onClick={() => setConfirming(true)}><Trash2 size={13} strokeWidth={2} /></button>
        </span>
      </div>
      {confirming && (
        <div className="tk-confirm">
          <span>{t("list.confirmDelete")}</span>
          <button className="tk-confirm-yes" onClick={() => { setConfirming(false); onDelete(task); }}>{t("list.delete")}</button>
          <button className="tk-confirm-no" onClick={() => setConfirming(false)}>{t("list.cancel")}</button>
        </div>
      )}
      {openFlag && (
        <div className="tk-flagbody">
          <div className="tk-file">{task.name}</div>
          <ul>{task.anomalies.map((a) => <li key={a}>{t(`anomaly.${a}`)}</li>)}</ul>
        </div>
      )}
      <div className="d-body">
        {task.body ? <div className="tk-md">{renderMarkdownLite(task.body)}</div> : <div className="tk-empty">{t("list.noBody")}</div>}
        {!editable && <div className="tk-noedit">{t("list.notEditable")}</div>}
      </div>
      {/* 票寫壞了但草稿還在：唯一救得回內容的地方，只給複製不給丟棄（票 3 spec；Codex 全鏈路審查 high） */}
      {!editable && rescueDraft && (
        <div className="tk-banner is-draft">
          <span className="btext">{t("list.draftFound")}</span>
          {copied && <span className="btext">{t("list.copied")}</span>}
          <span className="bacts">
            <button className="bbtn" onClick={() => writeClipboard(`# ${rescueDraft.title}\n\n${rescueDraft.body}`).then((ok) => ok && setCopied(true))}>
              {t("list.copyMine")}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

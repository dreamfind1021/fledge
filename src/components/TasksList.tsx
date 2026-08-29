import { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import type { TaskRow, TasksListResponse } from "../lib/sidecar";

function Ticket({ task, t }: { task: TaskRow; t: (k: string) => string }) {
  const [openFlag, setOpenFlag] = useState(false);
  return (
    <div className="tk">
      <div className="tk-row">
        <span className="tk-num">{task.number ?? t("list.noNumber")}</span>
        <span className="tk-title">{task.title}</span>
        <span className={`tk-status is-${task.status}`}>{t(`status.${task.status}`)}</span>
        {task.source ? <span className={`tk-src is-${task.source}`}>{t(`source.${task.source}`)}</span> : null}
        {task.anomalies.length > 0 && (
          <button className="tk-flag" aria-label={t("anomaly.label")} title={t("anomaly.label")}
            onClick={() => setOpenFlag((o) => !o)}>
            <TriangleAlert size={12} strokeWidth={2} />
          </button>
        )}
      </div>
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

// 第二層：未完成區在上，done 摺疊在下（design §5.3）。**做完不刪檔案**——
// 上一版的第一條結構性缺陷就是「完成即移除在燒資產」。
export function TasksList({ data, failed, onBack, onCreate, t }: {
  data: TasksListResponse | null;
  failed: boolean;
  onBack: () => void;
  onCreate: (title: string) => Promise<void>;
  t: (k: string) => string;
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
  if (failed) return <div className="tasks-pane">{back}<div className="tasks-note is-error">{t("overview.loadError")}</div></div>;
  if (data == null) return <div className="tasks-pane">{back}<div className="tasks-note">{t("overview.loading")}</div></div>;
  if (data.tasks == null) {
    // 讀不到 → 錯誤態，**不是空清單**（design §6.3）：空清單與「這個專案沒待辦」長得一樣
    return <div className="tasks-pane">{back}<div className="tasks-note is-error">{t("list.unavailable")}</div></div>;
  }

  const unfinished = data.tasks.filter((x) => x.status !== "done");
  const done = data.tasks.filter((x) => x.status === "done");
  return (
    <div className="tasks-pane">
      {back}
      {data.next_step ? <div className="tasks-next">{data.next_step}</div> : null}
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
      {data.tasks.length === 0 ? (
        <div className="tasks-note">{t("list.empty")}</div>
      ) : (
        <>
          <div className="tasks-sec">{t("list.unfinished")}</div>
          {unfinished.map((x) => <Ticket key={x.name} task={x} t={t} />)}
          {done.length > 0 && (
            <>
              <button className="tasks-sec is-toggle" onClick={() => setShowDone((s) => !s)}
                aria-label={showDone ? t("a11y.collapseDone") : t("a11y.expandDone")}>
                {showDone ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {t("list.done")}<span className="tasks-sec-n">{done.length}</span>
              </button>
              {showDone && done.map((x) => <Ticket key={x.name} task={x} t={t} />)}
            </>
          )}
        </>
      )}
    </div>
  );
}

import { Check } from "lucide-react";
import type { ReactNode } from "react";
import type { TaskRow, TasksOverview as TasksOverviewData, TasksProjectRow } from "../lib/sidecar";
import { okCount } from "./TasksTree";

type T = (k: string, o?: Record<string, unknown>) => string;

export type XTicket = { project: TasksProjectRow; task: TaskRow };

// 兩段的資料（spec §5.3）。進行中照 payload 順序串接（專案順序→編號，sidecar 已排好），前端不自己排。
// 最近新增是逐專案的陣列，跨專案的時間順序只有合併之後才排得出來——這是前端唯一自己排的地方：
// created 降冪，比較函式只看 created，Array.prototype.sort 保證穩定，同日維持插入順序（＝專案順序→編號）。
export function collectHighlights(projects: TasksProjectRow[]): { doing: XTicket[]; recent: XTicket[] } {
  const doing: XTicket[] = [];
  const recent: XTicket[] = [];
  for (const project of projects) {
    if (project.tasks_status !== "ok") continue;          // absent 是 []、unavailable 是 null，兩者都沒東西可列
    for (const task of project.doing_tasks ?? []) doing.push({ project, task });
    for (const task of project.recent_tasks ?? []) recent.push({ project, task });
  }
  recent.sort((a, b) => (a.task.created < b.task.created ? 1 : a.task.created > b.task.created ? -1 : 0));
  return { doing, recent };
}

// created 是 YYYY-MM-DD；只顯示月-日，認不得就不畫（同 TasksList 的規則）
const monthDay = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : "");

// 跨專案的一列：記號是純顯示（不是按鈕）、沒有動作鍵——動作在專案頁做（spec §2.2）
function XRow({ x, onSelect, t }: { x: XTicket; onSelect: (path: string, name: string) => void; t: T }) {
  const { project, task } = x;
  const date = monthDay(task.created);
  return (
    <div className={`tk is-${task.status}`}>
      <button className="tk-row tk-xrow" title={task.path} onClick={() => onSelect(project.path, task.name)}>
        <span className={`tk-mark is-${task.status}`} aria-hidden="true">
          {task.status === "done" ? <Check size={12} strokeWidth={3} /> : null}
        </span>
        <span className="tk-num">{task.number ?? t("list.noNumber")}</span>
        <span className="tk-title">{task.title}</span>
        <span className="tk-proj">{project.name}</span>
        {task.source ? <span className={`tk-src is-${task.source}`}>{t(`source.${task.source}`)}</span> : null}
        {date ? <span className="tk-date">{date}</span> : null}
      </button>
    </div>
  );
}

function Section({ label, n, children }: { label: string; n: number; children: ReactNode }) {
  return (
    <>
      <div className="tasks-sec"><span className="tasks-sec-lab">{label}</span><span className="tasks-sec-line" /><span className="tasks-sec-n">{n}</span></div>
      {children}
    </>
  );
}

// 「所有專案」頁（spec §5.3）：列的是票不是專案——專案清單是樹的事，這裡不再重複。
export function TasksOverview({ data, failed, onSelect, t }: {
  data: TasksOverviewData | null;
  failed: boolean;
  onSelect: (path: string, name: string) => void;
  t: T;
}) {
  const head = (extra?: ReactNode) => (
    <div className="tasks-head"><h1>{t("tree.allProjects")}</h1>{extra}</div>
  );
  if (failed) return <>{head()}<div className="tasks-note is-error">{t("overview.loadError")}</div></>;
  if (data == null) return <>{head()}<div className="tasks-note">{t("overview.loading")}</div></>;
  if (data.projects.length === 0) return <>{head()}<div className="tasks-note">{t("overview.empty")}</div></>;

  // 讀不到的專案不併進總數也不當成 0（design §6.3）：單獨報「N 個讀不到」
  const total = data.projects.reduce((s, p) => s + (okCount(p) ?? 0), 0);
  const unreadable = data.projects.filter((p) => okCount(p) === null && p.tasks_status !== "absent").length;
  const { doing, recent } = collectHighlights(data.projects);

  return (
    <>
      {head(
        <span className="tasks-sum">
          {t("overview.summary", { n: total })}
          {unreadable > 0 && <span className="is-warn"> · {t("overview.summaryUnreadable", { n: unreadable })}</span>}
        </span>,
      )}
      <Section label={t("overview.doingAll")} n={doing.length}>
        {doing.length === 0
          ? <div className="tasks-note">{t("overview.noDoing")}</div>
          : doing.map((x) => <XRow key={`${x.project.path}\n${x.task.name}`} x={x} onSelect={onSelect} t={t} />)}
      </Section>
      <Section label={t("overview.recent", { days: data.recent_days })} n={recent.length}>
        {recent.length === 0
          ? <div className="tasks-note">{t("overview.noRecent")}</div>
          : recent.map((x) => <XRow key={`${x.project.path}\n${x.task.name}`} x={x} onSelect={onSelect} t={t} />)}
      </Section>
    </>
  );
}

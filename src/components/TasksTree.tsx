import { LayoutGrid } from "lucide-react";
import type { TasksOverview as TasksOverviewData, TasksProjectRow } from "../lib/sidecar";

type T = (k: string, o?: Record<string, unknown>) => string;

// 只有非負整數才是真的條數。runtime JSON 沒有驗證，壞值不可被 ?? 0 壓成「沒有待辦」（design §6.3）。
// 從 TasksOverview.tsx 搬來：樹與所有專案頁都要用，留一份。
export const okCount = (p: TasksProjectRow) =>
  p.tasks_status === "ok" && Number.isInteger(p.unfinished) && (p.unfinished as number) >= 0
    ? (p.unfinished as number)
    : null;

// 「這個專案在總覽上有沒有話要說」。absent 但帶著 state.md 的下一步時仍然展開——
// scanner.py 刻意讓 absent 也抽得到 next_step，只看 tasks_status 會把那句話丟掉。
// 反面不成立：next_step 為空不代表這個專案沒動靜。
export const speaks = (p: TasksProjectRow) => p.tasks_status !== "absent" || Boolean(p.next_step);

// 擱置與進行中的張數：壞值退回 0（不畫記號），不把整列降級成警告——刻度總數來自 unfinished 仍可信
const safeCount = (n: number | null) => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 0);

// 專案樹（spec §5.2）：只有專案名＋數字，沒有第二行（D2）。
// asPage：窄等級把樹攤成一頁（等於現在的總覽），列寬拉滿、藏頂端與「所有專案」。
export function TasksTree({ data, selected, onSelect, t, asPage = false }: {
  data: TasksOverviewData | null;
  selected: string | null;
  onSelect: (path: string | null) => void;
  t: T;
  asPage?: boolean;
}) {
  const projects = data?.projects ?? [];
  const rows = projects.filter(speaks);
  const chips = projects.filter((p) => !speaks(p));
  const total = projects.reduce((s, p) => s + (okCount(p) ?? 0), 0);
  const unreadable = projects.filter((p) => okCount(p) === null && p.tasks_status !== "absent").length;

  const item = (p: TasksProjectRow, dim: boolean) => {
    const n = okCount(p);
    return (
      <button key={p.path} className={`tree-item${selected === p.path ? " active" : ""}${dim ? " is-dim" : ""}`}
        title={p.path} onClick={() => onSelect(p.path)}>
        <span className="tree-name">{p.name}</span>
        {dim ? null : n !== null ? (
          <span className="tree-n">
            {safeCount(p.doing) > 0 ? <i /> : null}
            {n}
            {safeCount(p.parked) > 0 ? <span className="pk">+{safeCount(p.parked)}</span> : null}
          </span>
        ) : p.tasks_status === "absent" ? null : (
          // unavailable、認不得的狀態、ok 但數字是壞的，全部走這一支：fail-safe 落在警告那一側
          <span className="tree-una">{t("overview.unavailable")}</span>
        )}
      </button>
    );
  };

  return (
    <aside className={`tree${asPage ? " as-page" : ""}`} data-testid={asPage ? "tree-page" : "tree"}>
      <div className="tree-head">
        <h1>{t("tabTitle")}</h1>
        <span className="s">
          {t("overview.summary", { n: total })}
          {unreadable > 0 && <span className="is-warn"> · {t("overview.summaryUnreadable", { n: unreadable })}</span>}
        </span>
      </div>
      <button className={`tree-item is-all${selected === null ? " active" : ""}`} onClick={() => onSelect(null)}>
        <LayoutGrid size={13} strokeWidth={1.8} />
        <span className="tree-name">{t("tree.allProjects")}</span>
      </button>
      {rows.length > 0 && <div className="tree-grp">{t("overview.groupInUse")}</div>}
      {rows.map((p) => item(p, false))}
      {chips.length > 0 && <div className="tree-grp">{t("overview.notUsing")}</div>}
      {chips.map((p) => item(p, true))}
    </aside>
  );
}

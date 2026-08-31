import type { TasksOverview as TasksOverviewData } from "../lib/sidecar";

// 第一層：所有已知專案的未完成條數 ＋ 下一步（design §5.1）。
// 沒有待辦的專案也要列出——隱藏了使用者就不知道那個專案可以開票。
export function TasksOverview({ data, failed, onSelect, t }: {
  data: TasksOverviewData | null;
  failed: boolean;
  onSelect: (path: string) => void;
  t: (k: string) => string;
}) {
  if (failed) return <div className="tasks-note is-error">{t("overview.loadError")}</div>;
  if (data == null) return <div className="tasks-note">{t("overview.loading")}</div>;
  if (data.projects.length === 0) return <div className="tasks-note">{t("overview.empty")}</div>;
  return (
    <div className="tasks-overview">
      <div className="tov-row is-head">
        <span className="tov-name">{t("overview.colProject")}</span>
        <span className="tov-count">{t("overview.colUnfinished")}</span>
        <span className="tov-next">{t("overview.colNextStep")}</span>
      </div>
      {data.projects.map((p) => (
        <button className="tov-row" key={p.path} title={p.path} onClick={() => onSelect(p.path)}>
          <span className="tov-name">{p.name}</span>
          {p.tasks_status === "unavailable" ? (
            // 讀不到不可畫成 0（design §6.3）：把不可讀顯示成「沒有」，正是這個功能存在的理由的反面
            <span className="tov-count is-unavailable">{t("overview.unavailable")}</span>
          ) : (
            <span className="tov-count">{p.unfinished}</span>
          )}
          <span className="tov-next">{p.next_step}</span>
        </button>
      ))}
    </div>
  );
}

import type { ReactNode } from "react";
import type { TasksOverview as TasksOverviewData } from "../lib/sidecar";

type T = (k: string, o?: Record<string, unknown>) => string;

// 未完成條數的刻度：一根＝一張票。超過 CAP 就不再加根，數量交給旁邊的數字說。
// **刻意不畫進度條**——overview 的 payload 只有 unfinished、沒有總數，比例的分母只能是編出來的。
// 同理刻度也不分狀態上色：payload 沒有 doing/todo 的拆分，上色等於畫一個後端沒說的事實。
const TALLY_CAP = 12;

function Tally({ n }: { n: number }) {
  // 純視覺編碼，語意由旁邊的數字承擔（螢幕報讀讀數字就好，不需要聽 12 根刻度）
  return (
    <span className="tov-marks" aria-hidden="true">
      {Array.from({ length: Math.min(n, TALLY_CAP) }, (_, i) => <i key={i} />)}
    </span>
  );
}

// 第一層：所有已知專案的未完成條數 ＋ 下一步（design §5.1）。
// 沒有待辦的專案也要列出——隱藏了使用者就不知道那個專案可以開票。
export function TasksOverview({ data, failed, onSelect, t }: {
  data: TasksOverviewData | null;
  failed: boolean;
  onSelect: (path: string) => void;
  t: T;
}) {
  const head = (extra?: ReactNode) => (
    <div className="tasks-head"><h1>{t("tabTitle")}</h1>{extra}</div>
  );

  if (failed) return <>{head()}<div className="tasks-note is-error">{t("overview.loadError")}</div></>;
  if (data == null) return <>{head()}<div className="tasks-note">{t("overview.loading")}</div></>;
  if (data.projects.length === 0) return <>{head()}<div className="tasks-note">{t("overview.empty")}</div></>;

  // 讀不到的專案 unfinished 是 null，不併進總數也不當成 0（design §6.3）：
  // 它們單獨報「N 個讀不到」，否則整份摘要會把不可讀說成沒有。
  const total = data.projects.reduce((s, p) => s + (p.unfinished ?? 0), 0);
  const unreadable = data.projects.filter((p) => p.tasks_status === "unavailable").length;

  return (
    <>
      {head(
        <span className="tasks-sum">
          {t("overview.summary", { n: total })}
          {unreadable > 0 && (
            <span className="is-warn"> · {t("overview.summaryUnreadable", { n: unreadable })}</span>
          )}
        </span>,
      )}
      <div className="tasks-overview">
        <div className="tov-head">
          <span className="tov-name">{t("overview.colProject")}</span>
          <span className="tov-count">{t("overview.colUnfinished")}</span>
          <span className="tov-next">{t("overview.colNextStep")}</span>
        </div>
        {data.projects.map((p) => (
          <button className="tov-row" key={p.path} title={p.path} onClick={() => onSelect(p.path)}>
            <span className="tov-name">{p.name}</span>
            <span className="tov-count">
              {p.tasks_status === "unavailable" ? (
                // 讀不到不可畫成 0（design §6.3）：把不可讀顯示成「沒有」，正是這個功能存在的理由的反面
                <span className="tov-una">{t("overview.unavailable")}</span>
              ) : (
                <>
                  <Tally n={p.unfinished ?? 0} />
                  <span className={p.unfinished ? "tov-n" : "tov-n is-zero"}>{p.unfinished ?? 0}</span>
                </>
              )}
            </span>
            <span className="tov-next">{p.next_step}</span>
          </button>
        ))}
      </div>
    </>
  );
}

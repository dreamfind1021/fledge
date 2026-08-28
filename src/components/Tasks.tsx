import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchTasksOverview, type TasksOverview } from "../lib/sidecar";
import "./Tasks.css";

// 待辦面板（design §5）。T1 只有第一層總覽——第二層清單、建票、切狀態、刪除、開編輯器
// 依序在 T2–T4。所有 HTTP 一律經 src/lib/sidecar.ts 的 wrapper（plan §1.0）：直接 fetch
// 會漏掉 X-Fledge-Token，dev 看似正常、打包版整個死掉。
export function Tasks({ port }: { port: number | null }) {
  const { t } = useTranslation("tasks");
  const [data, setData] = useState<TasksOverview | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    if (port == null) return;
    let cancelled = false;
    setFailed(false);
    fetchTasksOverview(port)
      .then((o) => { if (!cancelled) setData(o); })
      .catch(() => { if (!cancelled) setFailed(true); });   // 失敗顯錯誤態，不留空白
    return () => { cancelled = true; };
  }, [port]);

  useEffect(load, [load]);

  return (
    <div className="tasks-root" data-testid="tasks-panel">
      <div className="tasks-head">
        <h1>{t("tabTitle")}</h1>
      </div>
      {failed ? (
        <div className="tasks-note is-error">{t("overview.loadError")}</div>
      ) : data == null ? (
        <div className="tasks-note">{t("overview.loading")}</div>
      ) : data.projects.length === 0 ? (
        <div className="tasks-note">{t("overview.empty")}</div>
      ) : (
        <div className="tasks-overview">
          <div className="tov-row is-head">
            <span className="tov-name">{t("overview.colProject")}</span>
            <span className="tov-count">{t("overview.colUnfinished")}</span>
          </div>
          {/* 所有已知專案都列出，沒有待辦的顯示 0——隱藏了使用者就不知道那個專案可以開票（design §5.1） */}
          {data.projects.map((p) => (
            <div className="tov-row" key={p.path}>
              <span className="tov-name" title={p.path}>{p.name}</span>
              {p.tasks_status === "unavailable" ? (
                // 讀不到不可畫成 0（design §6.3）：把不可讀顯示成「沒有」，正是這個功能存在的理由的反面
                <span className="tov-count is-unavailable">{t("overview.unavailable")}</span>
              ) : (
                <span className="tov-count">{p.unfinished}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

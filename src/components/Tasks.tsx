import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createTask, fetchTasks, fetchTasksOverview, type TasksListResponse, type TasksOverview as TasksOverviewData } from "../lib/sidecar";
import { TasksList } from "./TasksList";
import { TasksOverview } from "./TasksOverview";
import "./Tasks.css";

// 待辦面板（design §5）。兩層導覽：總覽 → 單一專案。
// 所有 HTTP 一律經 src/lib/sidecar.ts 的 wrapper（plan §1.0）：直接 fetch 會漏掉
// X-Fledge-Token，dev 看似正常、打包版整個死掉。
export function Tasks({ port, isActive }: { port: number | null; isActive: boolean }) {
  const { t } = useTranslation("tasks");
  const [selected, setSelected] = useState<string | null>(null);
  const [overview, setOverview] = useState<TasksOverviewData | null>(null);
  const [list, setList] = useState<TasksListResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // design §5.5：切到本面板時重讀（isActive 進到依賴陣列）＋ 視窗重新取得焦點時重讀。
  // 不做即時檔案監看——使用者的節奏是「叫 AI 開票 → 之後才去看」，中間必然經過切換面板。
  useEffect(() => {
    if (!isActive) return;
    const bump = () => setReloadKey((k) => k + 1);
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, [isActive]);

  const select = useCallback((path: string) => { setList(null); setSelected(path); }, []);
  const back = useCallback(() => { setSelected(null); }, []);
  // 建完重讀整份清單：新票的編號由 sidecar 配（最大號 +1），前端不自己算
  const create = useCallback(async (title: string) => {
    if (port == null || selected == null) return;
    await createTask(port, selected, title);
    setReloadKey((k) => k + 1);
  }, [port, selected]);

  useEffect(() => {
    if (port == null || !isActive) return;
    let cancelled = false;
    setFailed(false);
    const done = selected == null
      ? fetchTasksOverview(port).then((o) => { if (!cancelled) setOverview(o); })
      : fetchTasks(port, selected).then((l) => { if (!cancelled) setList(l); });
    done.catch(() => { if (!cancelled) setFailed(true); });   // 失敗顯錯誤態，不留空白
    return () => { cancelled = true; };
  }, [port, isActive, selected, reloadKey]);

  return (
    <div className="tasks-root" data-testid="tasks-panel">
      <div className="tasks-head"><h1>{t("tabTitle")}</h1></div>
      {selected == null
        ? <TasksOverview data={overview} failed={failed} onSelect={select} t={t} />
        : <TasksList data={list} failed={failed} onBack={back} onCreate={create} t={t} />}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchMemoryRelated, type MemoryRelated } from "../lib/sidecar";
import "./RelatedFloat.css";

// 終端機右下角懸浮的「相關」浮現：收合時是一顆 FAB pill，展開為右下錨定 popover，
// 顯示該專案已連結的相關專案 + 自動建議的 KMS topic。count 為 0 時回 null（隱形、no-op）。
export function RelatedFloat({ port, projectPath }: { port: number | null; projectPath: string }) {
  const { t } = useTranslation("memory");
  const [data, setData] = useState<MemoryRelated | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (port == null || !projectPath) return;
    fetchMemoryRelated(port, projectPath).then(setData).catch(() => {});
  }, [port, projectPath]);
  const count = (data?.related.length ?? 0) + (data?.suggestions.length ?? 0);
  if (!data || count === 0) return null;
  if (!open) return (
    <button className="rf-fab" onClick={() => setOpen(true)}>◈ {t("related.title")}<span className="rf-n">{count}</span></button>
  );
  return (
    <div className="rf-panel">
      <div className="rf-h">◈ {t("related.title")}<span className="rf-x" onClick={() => setOpen(false)}>✕</span></div>
      {data.related.length > 0 && <div className="rf-sec">{t("related.projects")}</div>}
      {data.related.map((r) => <div key={r} className="rf-link">{r.split("/").pop()}</div>)}
      {data.suggestions.length > 0 && <div className="rf-sec">{t("related.topics")}</div>}
      {data.suggestions.map((s) => (
        <div key={s.topic} className="rf-link">{s.topic_name}<span className="rf-sug">{t("related.suggest")}</span></div>
      ))}
    </div>
  );
}

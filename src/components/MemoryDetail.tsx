import { useTranslation } from "react-i18next";
import { SuggestionChip } from "./SuggestionChip";
import type { MemoryItem, MemoryProject } from "../lib/sidecar";

// 右欄三態：空 / item 全文 / 專案脈絡。容器負責由 selection+data 解出 selItem/selBody/selProject。
export function MemoryDetail({ port, selItem, selBody, selProject, onAfterWrite }: {
  port: number | null;
  selItem: MemoryItem | null; selBody: string | null;
  selProject: MemoryProject | null; onAfterWrite: () => void;
}) {
  const { t } = useTranslation("memory");
  if (selProject) {
    const name = selProject.project.split("/").pop();
    return (
      <div className="md">
        <div className="md-crumb"><span aria-hidden="true">📁</span> {selProject.project}</div>
        <div className="md-title">{name}</div>
        {selProject.related.length > 0 && <div className="md-h">{t("detail.related")}</div>}
        <div className="md-chips">
          {selProject.related.map((r) => (
            <span key={r} className="relchip proj"><span className="ic" aria-hidden="true">📁</span>{r.split("/").pop()}</span>
          ))}
        </div>
        {selProject.suggestions.length > 0 && <div className="md-h">{t("detail.suggested")}</div>}
        <div className="md-chips">
          {selProject.suggestions.map((s) => (
            <SuggestionChip key={s.topic} port={port} projectPath={s.project} topic={s.topic}
              topicName={s.topic_name} onAfterWrite={onAfterWrite} />
          ))}
        </div>
        {selProject.related.length === 0 && selProject.suggestions.length === 0 &&
          <div className="md-empty">{t("related.none")}</div>}
      </div>
    );
  }
  if (selItem) {
    const badge = selItem.source === "native" ? "b-native" : "b-kms";
    const sub = selItem.source === "native" ? selItem.type : selItem.domain;
    return (
      <div className="md">
        <div className="md-crumb">
          <span className={`badge ${badge}`}>{selItem.source === "native" ? t("filter.native") : t("filter.kms")}</span>
          <span>{sub}{selItem.project ? " · " + selItem.project.split("/").pop() : ""}</span>
        </div>
        <div className="md-title">{selItem.title}</div>
        <div className="md-meta">{selItem.summary}</div>
        <pre className="md-body">{selBody ?? "…"}</pre>
      </div>
    );
  }
  return <div className="md-empty big">{t("detail.empty")}</div>;
}

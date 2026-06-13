import { useTranslation } from "react-i18next";
import { MemoryRow } from "./MemoryRow";
import type { MemoryGroupVM, Selection } from "../lib/memoryView";

const ICON: Record<string, string> = {
  global: "🌐", project: "📁", kb: "📚", unattributed: "⚠", unknown: "?",
};

// 可收合 group：caret（獨立按鈕、stopPropagation 只收合）+ 選取區（其餘 header：專案→選專案）+ 計數 + 建議 badge。
export function MemoryGroup({ group, open, onToggle, onSelectProject, onSelectItem, selection }: {
  group: MemoryGroupVM; open: boolean; onToggle: () => void;
  onSelectProject: (projectKey: string) => void;
  onSelectItem: (path: string, groupKey: string) => void;
  selection: Selection;
}) {
  const { t } = useTranslation("memory");
  const isProject = group.kind === "project";
  const projectSelected = isProject && selection?.kind === "project" && selection.projectKey === group.projectKey;
  const label = isProject
    ? (group.projectKey || "").split("/").pop()
    : t(`section.${group.kind}`);   // section.global/kb/unattributed/unknown 皆存在，無硬編預設
  const suggestN = group.suggestions?.length ?? 0;
  const headCls = group.kind === "unattributed" || group.kind === "unknown" ? "warn" : group.kind;

  const onHeader = () => { if (isProject && group.projectKey) onSelectProject(group.projectKey); else onToggle(); };
  return (
    <div className="grp">
      <div className={`grp-h ${headCls}${projectSelected ? " sel" : ""}`}>
        <button type="button" className="car" aria-expanded={open}
          aria-label={open ? t("a11y.collapse") : t("a11y.expand")}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}>{open ? "▾" : "▸"}</button>
        <button type="button" className="grp-label" aria-current={projectSelected || undefined}
          onClick={onHeader}>
          <span className="gic" aria-hidden="true">{ICON[group.kind]}</span>{label}
        </button>
        {suggestN > 0 ? <span className="reln">{suggestN} {t("related.suggest")}</span> : null}
        <span className="cnt">{group.items.length}</span>
      </div>
      {open ? (
        <div className="grp-body">
          {group.items.map((it) => (
            <MemoryRow key={`${group.key}|${it.path}`} item={it}
              active={selection?.kind === "item" && selection.path === it.path && selection.groupKey === group.key}
              onClick={() => onSelectItem(it.path, group.key)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

import { useTranslation } from "react-i18next";
import { MemoryGroup } from "./MemoryGroup";
import { applyFacet, type MemoryGroupVM, type Facet, type Selection } from "../lib/memoryView";
import type { MemoryOverview } from "../lib/sidecar";

const SOURCE_FACETS = ["native", "kms"] as const;
const TYPE_FACETS = ["user", "feedback", "project", "reference", "library", "topics"] as const;

// 左欄：標題+scan_meta、搜尋框（後端 q）、facet chips（前端過濾）、可收合 groups。
export function MemoryIndex({ data, groups, q, setQ, facet, setFacet, expanded, onToggle,
  selection, onSelectItem, onSelectProject }: {
  data: MemoryOverview; groups: MemoryGroupVM[];
  q: string; setQ: (v: string) => void;
  facet: Facet; setFacet: (f: Facet) => void;
  expanded: Set<string>; onToggle: (key: string) => void;
  selection: Selection;
  onSelectItem: (path: string, groupKey: string) => void;
  onSelectProject: (projectKey: string) => void;
}) {
  const { t } = useTranslation("memory");
  const view = applyFacet(groups, facet);
  const toggleFacet = (dim: "source" | "type", v: string) => {
    const cur = facet[dim];
    const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
    setFacet({ ...facet, [dim]: next });
  };
  const chip = (dim: "source" | "type", v: string, label: string) => (
    <button type="button" key={dim + v} className={`fchip${facet[dim].includes(v) ? " on" : ""}`}
      aria-pressed={facet[dim].includes(v)} onClick={() => toggleFacet(dim, v)}>{label}</button>
  );
  return (
    <div className="mem-index">
      <div className="mi-head">
        {/* header stat = scan_meta（掃描/搜尋總數，後端 q 已在算 total 前過濾，故反映搜尋結果）；
            各 group 的計數則是 facet 後的可見列數（MemoryGroup 顯示 group.items.length，items 已被 applyFacet 過濾）——兩者語意不同 */}
        <h1>{t("tabTitle")} <span className="mi-stat">{data.scan_meta.total} · unknown {data.scan_meta.unknown_count}</span></h1>
        <input className="mi-search" placeholder={t("search")} value={q}
          onChange={(e) => setQ(e.target.value)} aria-label={t("search")} />
        <div className="mi-facets">
          {SOURCE_FACETS.map(s => chip("source", s, s === "native" ? t("filter.native") : t("filter.kms")))}
          <span className="fchip sep" aria-hidden="true">|</span>
          {TYPE_FACETS.map(ty => chip("type", ty, ty))}
        </div>
      </div>
      <div className="mi-scroll">
        {view.map(g => (
          <MemoryGroup key={g.key} group={g} open={expanded.has(g.key)} onToggle={() => onToggle(g.key)}
            onSelectItem={onSelectItem} onSelectProject={onSelectProject} selection={selection} />
        ))}
        {view.length === 0 ? <div className="mi-empty">{t("empty")}</div> : null}
      </div>
    </div>
  );
}

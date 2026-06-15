import { X, SquareTerminal, ChartColumn, Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore } from "../store/useAppStore";
import { accountColor } from "../lib/accountColor";
import { tabDotState } from "../lib/tabDotState";
import "./TabBar.css";

function SortableTab({
  t,
  isActive,
  onSelect,
  onClose,
  tDash,
  tMem,
  tSide,
}: {
  t: ReturnType<typeof useAppStore.getState>["tabs"][number];
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  tDash: (k: string) => string;
  tMem: (k: string) => string;
  tSide: (k: string) => string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: t.id,
    data: { type: "tab" },
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      className={`tabbar-tab${isActive ? " is-active" : ""}`}
    >
      {t.kind === "terminal" ? (
        <span className="tabbar-term-ico" aria-label={tSide("tabBar.terminal")}><SquareTerminal size={13} strokeWidth={1.75} /></span>
      ) : t.kind === "dashboard" ? (
        <span className="tabbar-term-ico" aria-label={tDash("tabTitle")}><ChartColumn size={13} strokeWidth={1.75} /></span>
      ) : t.kind === "memory" ? (
        <span className="tabbar-term-ico" aria-label={tMem("tabTitle")}><Brain size={13} strokeWidth={1.75} /></span>
      ) : (
        <span className={`tab-dot is-${tabDotState(t)}`} />
      )}
      <span className="tabbar-tab-title">
        {t.kind === "dashboard" ? tDash("tabTitle") : t.kind === "memory" ? tMem("tabTitle") : t.title}
      </span>
      {t.account && (
        <span className="tabbar-chip" style={{ background: accountColor(t.account) }}>{t.account}</span>
      )}
      <button
        className="tabbar-close"
        aria-label={tSide("tabBar.close")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}

export function TabBar() {
  const { t: tDash } = useTranslation("dashboard");
  const { t: tMem } = useTranslation("memory");
  const { t: tSide } = useTranslation("sidebar");
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActive = useAppStore((s) => s.setActive);
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);

  return (
    <div className="tabbar">
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        {tabs.map((t) => (
          <SortableTab
            key={t.id}
            t={t}
            isActive={t.id === activeTabId}
            onSelect={() => setActive(t.id)}
            onClose={() => requestCloseTab(t.id)}
            tDash={tDash}
            tMem={tMem}
            tSide={tSide}
          />
        ))}
      </SortableContext>
    </div>
  );
}

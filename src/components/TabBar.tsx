import { X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { accountColor } from "../lib/accountColor";
import { tabDotState } from "../lib/tabDotState";
import "./TabBar.css";

export function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActive = useAppStore((s) => s.setActive);
  const closeTab = useAppStore((s) => s.closeTab);

  return (
    <div className="tabbar">
      {tabs.map((t) => {
        const isActive = t.id === activeTabId;
        return (
          <div
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`tabbar-tab${isActive ? " is-active" : ""}`}
          >
            <span className={`tab-dot is-${tabDotState(t)}`} />
            <span className="tabbar-tab-title">{t.title}</span>
            <span
              className="tabbar-chip"
              style={{ background: accountColor(t.account) }}
            >
              {t.account}
            </span>
            <button
              className="tabbar-close"
              onClick={(e) => {
                e.stopPropagation();
                // 直接關（window.confirm 在 Tauri webview 不彈出；與 Cmd+W 行為一致）。
                // claude 對話可 claude --resume 救回，誤關代價有限。確認 UX 留 Plan 03 評估。
                closeTab(t.id);
              }}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

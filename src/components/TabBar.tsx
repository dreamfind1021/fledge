import { X, SquareTerminal, ChartColumn, Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store/useAppStore";
import { accountColor } from "../lib/accountColor";
import { tabDotState } from "../lib/tabDotState";
import "./TabBar.css";

export function TabBar() {
  const { t: tDash } = useTranslation("dashboard");
  const { t: tMem } = useTranslation("memory");
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActive = useAppStore((s) => s.setActive);
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);

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
            {t.kind === "terminal" ? (
              <span className="tabbar-term-ico" aria-label="終端機">
                <SquareTerminal size={13} strokeWidth={1.75} />
              </span>
            ) : t.kind === "dashboard" ? (
              <span className="tabbar-term-ico" aria-label={tDash("tabTitle")}>
                <ChartColumn size={13} strokeWidth={1.75} />
              </span>
            ) : t.kind === "memory" ? (
              <span className="tabbar-term-ico" aria-label={tMem("tabTitle")}>
                <Brain size={13} strokeWidth={1.75} />
              </span>
            ) : (
              <span className={`tab-dot is-${tabDotState(t)}`} />
            )}
            <span className="tabbar-tab-title">
              {t.kind === "dashboard" ? tDash("tabTitle") : t.kind === "memory" ? tMem("tabTitle") : t.title}
            </span>
            {t.account && (
              <span
                className="tabbar-chip"
                style={{ background: accountColor(t.account) }}
              >
                {t.account}
              </span>
            )}
            <button
              className="tabbar-close"
              onClick={(e) => {
                e.stopPropagation();
                // 經守門：AI 執行中會跳確認框（app 內 modal，非 window.confirm——後者在 Tauri webview 不彈），
                // 其餘直接關。與 Cmd+W 走同一條 requestCloseTab。
                requestCloseTab(t.id);
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

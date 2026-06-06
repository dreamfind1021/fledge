import { TabBar } from "./TabBar";
import { Terminal } from "./Terminal";
import { useAppStore } from "../store/useAppStore";
import "./Workspace.css";

// TabBar + 終端機合成一體的工作區面板（merged-panel）。
// ⚠ 終端機區塊保留「全 tab 同時 mount + display 切換」——這是 xterm scrollback
// 跨 tab 切換不被銷毀的唯一原因；勿改成「只 render active tab 的 Terminal」。
export function Workspace({ connError }: { connError: string | null }) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const port = useAppStore((s) => s.port);

  return (
    <div className="ws-main">
      <div className="workspace">
        <TabBar />
        <div className="ws-term-area">
          {port == null ? (
            /* 連線中 / 連線失敗（backend 尚未就緒）*/
            <div className="ws-status">
              {connError ? (
                <span className="ws-conn-error">
                  {`無法連線到 sidecar：${connError}。請重新啟動 app。`}
                </span>
              ) : (
                <span className="ws-connecting-text">連線中…</span>
              )}
            </div>
          ) : (
            tabs.map((t) => (
              <div
                key={t.id}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: t.id === activeTabId ? "block" : "none",
                  padding: 4,
                }}
              >
                {(t.status === "ready" || t.status === "offline") && t.sessionId ? (
                  <div style={{ position: "absolute", inset: 0 }}>
                    <Terminal
                      port={port}
                      sessionId={t.sessionId}
                      tabId={t.id}
                      isActive={t.id === activeTabId}
                    />
                    {t.status === "offline" && (
                      /* offline badge：連線中斷 warning pill（§5 offline — --dim + 標記）*/
                      <div className="ws-offline-badge">
                        連線中斷，重連中…
                      </div>
                    )}
                  </div>
                ) : t.status === "ended" ? (
                  /* ended：faint text（§5）+ primary 重啟入口（§5 重啟入口）*/
                  <div className="ws-status">
                    <div className="ws-ended-text">Session 已結束</div>
                    <button
                      className="ws-restart-btn"
                      onClick={() => useAppStore.getState().restartTab(t.id)}
                    >
                      重啟
                    </button>
                  </div>
                ) : (
                  /* creating / error */
                  <div className="ws-status">
                    {t.status === "creating" ? (
                      <span className="ws-creating-text">正在開啟 session…</span>
                    ) : (
                      <span className="ws-error-text">{`開啟失敗：${t.error ?? ""}`}</span>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

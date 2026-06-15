import { useDroppable } from "@dnd-kit/core";
import { TabBar } from "./TabBar";
import { Terminal } from "./Terminal";
import Dashboard from "./Dashboard";
import { Memory } from "./Memory";
import { RelatedFloat } from "./RelatedFloat";
import { useAppStore } from "../store/useAppStore";
import "./Workspace.css";

// TabBar + 終端機合成一體的工作區面板（merged-panel）。
// ⚠ 終端機區塊保留「全 tab 同時 mount + display 切換」——這是 xterm scrollback
// 跨 tab 切換不被銷毀的唯一原因；勿改成「只 render active tab 的 Terminal」。
export function Workspace({ connError }: { connError: string | null }) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const port = useAppStore((s) => s.port);

  // 終端機區 drop target（需求 4）；useDroppable 只標記區域、不綁 pointer listener，不影響 xterm
  const { setNodeRef: setDropRef } = useDroppable({ id: "terminal-drop" });

  return (
    <div className="ws-main">
      <div className="workspace">
        <TabBar />
        <div className="ws-term-area" ref={setDropRef}>
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
            // 用穩定順序（by id）渲染、與 TabBar 顯示順序解耦：分頁拖曳排序（reorderTabs）只改
            // tabs 陣列順序，不該重排這裡的 DOM——否則 React 會 move 含 xterm 的 subtree、破壞
            // 終端機渲染（內容遺失）。display 控制 active 顯示，故 DOM 順序不影響視覺。
            [...tabs].sort((a, b) => a.id.localeCompare(b.id)).map((t) => (
              <div
                key={t.id}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: t.id === activeTabId ? "block" : "none",
                  padding: 4,
                }}
              >
                {t.kind === "memory" ? (
                  <Memory port={port} isActive={t.id === activeTabId} />
                ) : t.kind === "dashboard" ? (
                  <Dashboard port={port} isActive={t.id === activeTabId} />
                ) : (t.status === "ready" || t.status === "offline") && t.sessionId ? (
                  // 左側 inset 12px 讓終端機文字不貼著 sidebar——縫隙露出 ws-term-area 的 --term-bg。
                  // 不用外層 padding：本 div 是 absolute、會以外層 padding box 為基準填滿而蓋掉 padding，
                  // 故間距要寫在這層的 inset 上。FitAddon 依縮小後寬度自動重算欄數。
                  <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 12 }}>
                    <Terminal
                      port={port}
                      sessionId={t.sessionId}
                      tabId={t.id}
                      isActive={t.id === activeTabId}
                    />
                    {/* 右下懸浮「相關」：只給有 projectPath 的 session 分頁（claude／terminal）；
                        此 div 已是 position:absolute（即定位包覆塊），float 以它為錨點、不改終端機尺寸 */}
                    {(t.kind === "claude" || t.kind === "terminal") && t.projectPath && (
                      <RelatedFloat port={port} projectPath={t.projectPath} />
                    )}
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

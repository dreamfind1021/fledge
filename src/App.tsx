import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { fetchHealth, rawHealth, restartSidecar } from "./lib/sidecar";
import { getTerminal } from "./lib/terminalRegistry";
import { formatPathsForPaste } from "./lib/dropPath";
import { useAppStore } from "./store/useAppStore";
import { isLiveClaudeTab } from "./lib/liveTab";
import { displayTabTitle } from "./lib/tabTitle";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { Settings } from "./components/Settings";
import { ProjectPicker } from "./components/ProjectPicker";
import { Onboarding } from "./components/Onboarding";
import type { MigrationResume } from "./components/RestoreCard";
import { Splash } from "./components/Splash";
import "./App.css";

// 關閉存活 session 的確認框（app 內 modal——window.confirm 在 Tauri webview 不彈）。
// 只在 requestCloseTab 判定分頁有 live session 時掛載；Enter＝確認（autofocus 鈕原生觸發）、Esc／點背景＝取消。
function CloseConfirm({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // 一次性 autofocus（deps=[]）：與 Escape listener 分開，避免父層 re-render 重觸發、把焦點從「取消」拉回危險鈕（Codex Area 6）
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  // Escape 取消：window listener（焦點離開鈕後仍能關，與既有 Settings/Picker modal 一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div
        className="confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-confirm-title"
        aria-describedby="close-confirm-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-row">
          <span className="confirm-ico"><AlertTriangle size={18} /></span>
          <div className="confirm-content">
            <div className="confirm-title" id="close-confirm-title">關閉這個 session？</div>
            <p className="confirm-desc" id="close-confirm-desc">
              「{title}」的 session 尚未結束。若 AI 仍在處理或等待回覆，關閉會中斷正在執行的程序、目前進度不會保留；若只是階段性停止（回覆結束／等待輸入），關閉後仍可用 <code>/resume</code> 恢復對話。確定要關閉嗎？
            </p>
          </div>
        </div>
        <div className="confirm-foot">
          <button className="confirm-btn-ghost" onClick={onCancel}>取消</button>
          <button ref={confirmRef} className="confirm-btn-danger" onClick={onConfirm}>關閉 session</button>
        </div>
      </div>
    </div>
  );
}

// 把拖曳路徑貼到 active 終端機（需求 4）；gate 對齊 design §8.4（與既有 OS drop 對稱）。
function dropPathsToActiveTerminal(paths: string[]): void {
  const st = useAppStore.getState();
  if (st.modalOpen) return;                                       // modal 未開
  const id = st.activeTabId;
  const tab = st.tabs.find((t) => t.id === id);
  if (!id || !tab) return;
  if (tab.kind !== "claude" && tab.kind !== "terminal") return;   // 分頁種類
  if (tab.status !== "ready") return;                             // ready
  if (paths.length === 0) return;                                 // 有路徑
  const handle = getTerminal(id);
  if (!handle || handle.isComposing()) return;                    // IME 未組字
  const text = formatPathsForPaste(paths);
  if (!text) return;                                              // 格式化非空
  handle.paste(text);
}

function App() {
  const { t } = useTranslation("app");
  const [splashDone, setSplashDone] = useState(false);
  // 專案掃描失敗（非致命）的呈現由 App 持有：它是「這一次啟動的結果」，不是要跨元件訂閱的狀態
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // 續作（票 07）：非 null＝這次開精靈是要接續上次沒完成的移機，直接落在安裝頁並預填
  const [resumeMigration, setResumeMigration] = useState<MigrationResume | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const backendStatus = useAppStore((s) => s.backendStatus);
  const recordHealth = useAppStore((s) => s.recordHealth);
  const setBackendStatus = useAppStore((s) => s.setBackendStatus);
  const markAllTabsEnded = useAppStore((s) => s.markAllTabsEnded);
  const port = useAppStore((s) => s.port);
  const setPort = useAppStore((s) => s.setPort);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const setActive = useAppStore((s) => s.setActive);
  const closeTab = useAppStore((s) => s.closeTab);
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);
  const pendingCloseTabId = useAppStore((s) => s.pendingCloseTabId);
  const setPendingCloseTab = useAppStore((s) => s.setPendingCloseTab);
  const setModalOpen = useAppStore((s) => s.setModalOpen);
  // 只取 pending tab 的標題（primitive string|null，避免訂閱整個 tabs 陣列、在 activity churn 時狂 re-render）。
  // 回 null＝框該收掉：驅動「框是否顯示」與下方懸空清理。判斷式與 store requestCloseTab 一致：
  // status==="ready" && sessionId（working/idle 等 ready 子狀態都續顯示）；tab 變 offline/ended/消失 → null
  // → 框自動收掉並清 pending（修 Codex 抓的懸空鎖死）。
  const pendingTitle = useAppStore((s) => {
    const id = s.pendingCloseTabId;
    if (!id) return null;
    const t = s.tabs.find((x) => x.id === id);
    return t && isLiveClaudeTab(t) ? displayTabTitle(s.tabs, t) : null;
  });
  const claudeFound = useAppStore((s) => s.claudeFound);
  const permissionError = useAppStore((s) => s.permissionError);

  // 拖曳殘影用：記錄拖曳中的標的（tab 顯示用 title）。distance:5 隔離點擊/右鍵/xterm（design §4.2）。
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current;
    if (d?.type === "tab") {
      const tabs = useAppStore.getState().tabs;
      const t = tabs.find((x) => x.id === e.active.id);
      setDragLabel(t ? displayTabTitle(tabs, t) : null);
    } else if (d?.type === "path") {
      setDragLabel(typeof d.label === "string" ? d.label : null);
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragLabel(null);
    const { active, over } = e;
    if (!over) return;
    const type = active.data.current?.type;
    if (type === "tab") {
      if (active.id !== over.id) useAppStore.getState().reorderTabs(String(active.id), String(over.id));
    } else if (type === "path") {
      if (over.id === "terminal-drop") {
        dropPathsToActiveTerminal((active.data.current?.paths as string[]) ?? []);
      }
    }
  };

  // 啟動序列的唯一消費路徑（design §4.1.5）。
  //
  // ⚠ 不變式：bootstrap 的回傳值只有這裡會處理，所以**所有**觸發啟動的入口都必須經過它——
  // 初次掛載的 effect 如此，Splash 的重試也如此。曾經讓 Splash 直接呼叫 bootstrap，結果是
  // 重試成功時 firstRun 沒人接（淡出到一個還沒設定過的主畫面）、projectsError 也沒人接。
  const runStartup = useCallback(
    async (opts?: { restart?: boolean }) => {
      setProjectsError(null); // 每次開跑先清上一輪
      const r = await bootstrap(opts);
      if (!r) return; // null＝失敗；狀態已在 store，由 Splash 呈現錯誤與重試
      setProjectsError(r.projectsError);
      if (r.firstRun) {
        setShowSettings(false); // 清掉 sidecar 啟動等待期間使用者可能開的 modal（Codex F-6）
        setShowPicker(false);
        setShowOnboarding(true);
      }
    },
    [bootstrap],
  );

  useEffect(() => {
    void runStartup();
  }, [runStartup]);

  // 快捷鍵：Cmd+W 關當前（執行中先確認）、Cmd+1~9 切 tab
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const handled =
        e.key === "," ||
        e.key === "t" ||
        e.key === "r" ||
        e.key === "w" ||
        (e.key >= "1" && e.key <= "9");
      if (!handled) return;
      // 先擋掉 Tauri/webview 對這些 meta key 的預設（Cmd+W 關視窗、Cmd+R reload…），
      // 再決定是否執行 app 邏輯——否則 modal 開時 bail 會讓 Cmd+W 直接關掉整個程式。
      e.preventDefault();
      // ⚠ 這道 gate 必須在 preventDefault 之後：放在 handler 開頭直接 return 的話，事件會落回
      // Tauri 預設行為，Splash 期間按 Cmd+W 會直接關掉整個 app。
      if (!splashDone) return;
      if (showOnboarding) return; // onboarding 強制完成，期間吃掉所有 meta 快捷鍵（Codex F-6）
      // 確認框「實際顯示時」才吃掉 meta 快捷鍵（用 pendingTitle 而非 raw id，避免懸空 id 在 cleanup effect
      // 執行前那一 render tick 仍鎖死快捷鍵——與下方 render 的顯示條件一致）。Enter/Esc 交給框自己處理。
      if (pendingCloseTabId && pendingTitle !== null) return;
      if (showSettings || showPicker) {
        // modal 開啟時 Cmd+W 關掉 modal（符合「關當前東西」直覺）；其餘快捷鍵不作用
        if (e.key === "w") {
          setShowSettings(false);
          setShowPicker(false);
        }
        return;
      }
      if (e.key === ",") {
        setShowSettings(true);
      } else if (e.key === "t") {
        setShowPicker(true);
      } else if (e.key === "r") {
        useAppStore.getState().loadProjects();
        setToast("已重新掃描專案");
        window.setTimeout(() => setToast(null), 1500);
      } else if (e.key === "w") {
        const id = useAppStore.getState().activeTabId;
        if (id) requestCloseTab(id); // 經守門：live session 跳確認框，其餘直接關
      } else if (e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key) - 1;
        const t = useAppStore.getState().tabs[idx];
        if (t) setActive(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestCloseTab, setActive, showSettings, showPicker, showOnboarding, pendingCloseTabId, pendingTitle, splashDone]);

  // 懸空清理：pending 指向的 tab 若已消失或不再是 live session（pendingTitle 回 null，如 sidecar 重啟 markAllTabsEnded），
  // 清掉 pendingCloseTabId——否則框不顯示卻仍讓上面的守門吃掉 Cmd+W/R/1-9，造成快捷鍵被靜默鎖死（Codex Area 3）。
  useEffect(() => {
    if (pendingCloseTabId && pendingTitle === null) setPendingCloseTab(null);
  }, [pendingCloseTabId, pendingTitle, setPendingCloseTab]);

  // 任一 modal 開啟 → 寫進 store 單一旗標，供 Terminal 的拖檔 drop gate 判定（modal 期間 drop no-op，
  // design §5；drop 穿透背景 terminal 會破壞 modal 語義）。App 是所有 modal 的開關來源 → 唯一寫入者。
  // 關閉確認框的「開啟」＝ pendingCloseTabId 有值且 pendingTitle 仍為 live（與 render 顯示條件一致）。
  // 用 useLayoutEffect：paint 前同步更新旗標，避免「modal 開啟到旗標寫入」之間的 drop 漏判（Codex 階段3）。
  useLayoutEffect(() => {
    const open =
      !splashDone || showSettings || showPicker || showOnboarding || (pendingCloseTabId !== null && pendingTitle !== null);
    setModalOpen(open);
  }, [splashDone, showSettings, showPicker, showOnboarding, pendingCloseTabId, pendingTitle, setModalOpen]);

  // 每 5s raw health poll → 餵 backendStatus 狀態機（suspect/down + up-hysteresis）
  useEffect(() => {
    if (port == null) return;
    const id = window.setInterval(async () => {
      if (useAppStore.getState().backendStatus === "restarting") return; // restart 期間不 poll
      const h = await rawHealth(port);
      recordHealth(h !== null);
      if (h) useAppStore.getState().setClaudeFound(h.claude_found);
    }, 5000);
    return () => window.clearInterval(id);
  }, [port, recordHealth]);

  const onRestartSidecar = async () => {
    if (restarting) return;
    setRestarting(true);
    setBackendStatus("restarting"); // 停 poll/重連
    try {
      const newPort = await restartSidecar(); // Rust kill+respawn+新 port
      // 原子轉移：markAllTabsEnded 與 setPort 是連續同步 set()、會 batch 在同一次 render——
      // Terminal 一次就看到「ended + 新 port」→ ended tab 不 mount Terminal，不會用舊 sessionId 連新 port。
      // ⚠ 勿在這兩行間插入 await（否則 React 會先 flush、破壞原子性）。
      markAllTabsEnded();
      setPort(newPort);
      await fetchHealth(newPort); // restart-owned gate（與背景 poll 不同路徑）
      await useAppStore.getState().loadConfig();
      await useAppStore.getState().loadProjects();
      setBackendStatus("up"); // 恢復背景 poll
    } catch (e) {
      console.error("restart sidecar 失敗", e);
      // restartSidecar 失敗時 Rust 已先 kill 舊 sidecar（先 kill 再 spawn）→ 舊 session 必死。
      // 標 ended 避免 tab 卡在 ready/offline 指向死掉的 session（Codex 階段10 HIGH）。
      markAllTabsEnded();
      setBackendStatus("down"); // 失敗留在 down、banner 續顯示可重試
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="app-root">
      {(backendStatus === "down" || backendStatus === "restarting") && (
        <div className="app-banner app-banner--error" role="alert">
          <span className="app-banner-icon"><AlertTriangle size={15} /></span>
          <span className="app-banner-msg">{restarting ? "正在重啟 sidecar…" : "後端斷線（sidecar 無回應）"}</span>
          <button
            onClick={onRestartSidecar}
            disabled={restarting}
            className="app-banner-btn--error"
          >
            {restarting ? "重啟中…" : "重啟 sidecar"}
          </button>
        </div>
      )}
      {!claudeFound && (
        <div className="app-banner app-banner--warning app-banner--warning-top" role="status">
          <span className="app-banner-icon"><AlertTriangle size={15} /></span>
          <span className="app-banner-msg">找不到 Claude Code（claude）。請先安裝。</span>
          <button onClick={() => { import("@tauri-apps/plugin-opener").then((m) => m.openUrl("https://docs.claude.com/en/docs/claude-code/setup")).catch(() => {}); }} className="app-banner-btn--warning">安裝說明</button>
        </div>
      )}
      {/* 底部 banner 堆疊：兩條可能同時出現，交給容器排序而非各自 fixed 疊在一起 */}
      {(projectsError || permissionError) && (
        <div className="app-banner-stack--bottom">
          {projectsError && (
            <div className="app-banner app-banner--warning app-banner--warning-bottom" role="status">
              <span className="app-banner-icon"><AlertTriangle size={15} /></span>
              <span className="app-banner-msg">{t("banners.projects_failed")}</span>
              <button
                onClick={() => {
                  setProjectsError(null);
                  void useAppStore.getState().loadProjects().catch((e) => setProjectsError(String(e)));
                }}
                className="app-banner-btn--warning"
              >
                {t("banners.rescan")}
              </button>
            </div>
          )}
          {permissionError && (
            <div className="app-banner app-banner--warning app-banner--warning-bottom" role="status">
              <span className="app-banner-icon"><AlertTriangle size={15} /></span>
              <span className="app-banner-msg">無法讀取部分資料夾。請到「系統設定 → 隱私權與安全性 → 檔案與資料夾／App 管理」允許 Fledge。</span>
            </div>
          )}
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <Sidebar onOpenPicker={() => setShowPicker(true)} onOpenSettings={() => setShowSettings(true)} />
        <Workspace />
        <DragOverlay>{dragLabel ? <div className="drag-overlay-chip">{dragLabel}</div> : null}</DragOverlay>
      </DndContext>
      {!splashDone && (
        <Splash onDone={() => setSplashDone(true)} onRetry={() => void runStartup({ restart: true })} />
      )}
      {showOnboarding && (
        <Onboarding
          onClose={() => {
            setShowOnboarding(false);
            setResumeMigration(null);   // 續作是一次性的入口，關掉就不再套用
          }}
          resume={resumeMigration ?? undefined}
        />
      )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          // 重跑引導：關掉設定頁再開精靈，兩個 modal 不疊在一起
          onRerunOnboarding={() => {
            setShowSettings(false);
            setResumeMigration(null);   // 重跑引導是從頭走，不是續作
            setShowOnboarding(true);
          }}
          // 接續上次沒完成的移機（票 07）：同樣關掉設定頁再開精靈，兩個 modal 不疊在一起
          onResumeMigration={(resume) => {
            setShowSettings(false);
            setResumeMigration(resume);
            setShowOnboarding(true);
          }}
        />
      )}
      {showPicker && <ProjectPicker onClose={() => setShowPicker(false)} />}
      {pendingCloseTabId && pendingTitle !== null && (
        <CloseConfirm
          title={pendingTitle}
          onConfirm={() => {
            const id = pendingCloseTabId;
            setPendingCloseTab(null);
            closeTab(id);
          }}
          onCancel={() => setPendingCloseTab(null)}
        />
      )}
      {toast && (
        <div className="app-toast">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;

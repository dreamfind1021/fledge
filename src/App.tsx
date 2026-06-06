import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { waitForSidecarPort, waitForSidecarToken, setAuthToken, fetchHealth, rawHealth, restartSidecar } from "./lib/sidecar";
import { useAppStore } from "./store/useAppStore";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { Settings } from "./components/Settings";
import { ProjectPicker } from "./components/ProjectPicker";
import { Onboarding } from "./components/Onboarding";
import "./App.css";

function App() {
  const [connError, setConnError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const backendStatus = useAppStore((s) => s.backendStatus);
  const recordHealth = useAppStore((s) => s.recordHealth);
  const setBackendStatus = useAppStore((s) => s.setBackendStatus);
  const markAllTabsEnded = useAppStore((s) => s.markAllTabsEnded);
  const port = useAppStore((s) => s.port);
  const setPort = useAppStore((s) => s.setPort);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const loadConfig = useAppStore((s) => s.loadConfig);
  const setActive = useAppStore((s) => s.setActive);
  const closeTab = useAppStore((s) => s.closeTab);
  const claudeFound = useAppStore((s) => s.claudeFound);
  const permissionError = useAppStore((s) => s.permissionError);

  // 啟動：拿 port → 等 server ready（health gate）→ 載入專案清單
  useEffect(() => {
    (async () => {
      try {
        const p = await waitForSidecarPort();
        // 先拿 token 並 setAuthToken，之後所有受保護請求才帶得了 header（fail-closed 下無 token = 全 401）。
        const token = await waitForSidecarToken();
        setAuthToken(token);
        // sidecar 先印 FLEDGE_PORT 再啟 uvicorn（~0.5s gap）；先 fetchHealth retry 到 200
        // 再 loadProjects，否則 GET /api/projects 會撞 server startup（連線被拒、sidebar 空）。
        const h0 = await fetchHealth(p);
        useAppStore.getState().setClaudeFound(h0.claude_found);
        setPort(p); // 最後才設 → 觸發 5s health poll effect 時 token 必已 set
        await loadConfig();
        // 先判首次再決定要不要載專案：首次直接進 onboarding、跳過 loadProjects（避免閃空 sidebar）；
        // onboarding 完成時 completeOnboarding 內會 loadProjects。非首次才正常載入。
        if (useAppStore.getState().config?.is_first_run) {
          setShowSettings(false); // 清掉 sidecar 啟動等待期間使用者可能開的 modal（Codex F-6）
          setShowPicker(false);
          setShowOnboarding(true);
        } else {
          await loadProjects();
        }
      } catch (e) {
        // 逾時／連線失敗：顯示可見錯誤（完整重連／重啟留 Plan 04 的錯誤處理）
        console.error("sidecar 連線失敗", e);
        setConnError(String(e));
      }
    })();
  }, [setPort, loadProjects, loadConfig]);

  // 快捷鍵：Cmd+W 關當前、Cmd+1~9 切 tab
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
      if (showOnboarding) return; // onboarding 強制完成，期間吃掉所有 meta 快捷鍵（Codex F-6）
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
        if (id) closeTab(id);
      } else if (e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key) - 1;
        const t = useAppStore.getState().tabs[idx];
        if (t) setActive(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeTab, setActive, showSettings, showPicker, showOnboarding]);

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
      {permissionError && (
        <div className="app-banner app-banner--warning app-banner--warning-bottom" role="status">
          <span className="app-banner-icon"><AlertTriangle size={15} /></span>
          <span className="app-banner-msg">無法讀取部分資料夾。請到「系統設定 → 隱私權與安全性 → 檔案與資料夾／App 管理」允許 Fledge。</span>
        </div>
      )}
      <Sidebar onOpenPicker={() => setShowPicker(true)} onOpenSettings={() => setShowSettings(true)} />
      <Workspace connError={connError} />
      {showOnboarding && <Onboarding onClose={() => setShowOnboarding(false)} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {showPicker && <ProjectPicker onClose={() => setShowPicker(false)} />}
      {toast && (
        <div className="app-toast">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;

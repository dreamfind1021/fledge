import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { WebglAddon } from "@xterm/addon-webgl";
import { resizeSession, wsUrl } from "../lib/sidecar";
import { useAppStore } from "../store/useAppStore";
import { shouldReconnect, nextDelay, MAX_RECONNECT_ATTEMPTS } from "../lib/wsReconnect";
import { recordActivity, clearActivity } from "../lib/activityTracker";
import { readTermTheme } from "../styles/term-theme";

// WebGL kill switch：Tahoe WebKit 有破圖前例（xterm#5816），驗收若中獎改 false 一鍵退 DOM
const ENABLE_WEBGL = true;
// context loss / 載入失敗後，本次 app 生命週期內全域停用 WebGL（避免 loss 風暴反覆重建）
let webglFailed = false;

interface TerminalProps {
  port: number;
  sessionId: string;
  tabId: string;
  isActive: boolean;
}

export function Terminal({ port, sessionId, tabId, isActive }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const isActiveRef = useRef(isActive);
  const forceRefreshRef = useRef<(() => void) | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);

  // WebGL 只掛 active terminal：隱藏 tab 的渲染本來就暫停（畫了也看不到），
  // 且 WebKit 對單頁 WebGL context 數量有上限，全 tab 掛載會在多 tab 時互逐（design §4.3）
  const detachWebgl = () => {
    webglRef.current?.dispose(); // dispose 後 xterm 自動退回 DOM renderer
    webglRef.current = null;
  };
  const attachWebgl = () => {
    if (!ENABLE_WEBGL || webglFailed || webglRef.current || !termRef.current) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        webglFailed = true;
        console.warn("WebGL context loss：本次 app 生命週期全域退回 DOM renderer");
        detachWebgl();
        forceRefreshRef.current?.(); // renderer 轉換後重繪閉環：退 DOM 也要畫面即刻完整
      });
      termRef.current.loadAddon(addon);
      webglRef.current = addon;
    } catch (err) {
      // 環境不支援 WebGL（建構/載入丟例外）→ 本生命週期停用；log 供真機驗收歸因 fallback 原因
      webglFailed = true;
      console.warn("WebGL renderer 載入失敗，本生命週期退回 DOM renderer", err);
    }
    forceRefreshRef.current?.(); // 成功（首幀）與失敗（DOM 接手）都補一次重繪
  };

  const setTabStatus = useAppStore((s) => s.setTabStatus);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      // xterm canvas 不解析 CSS 變數 → fontFamily 用實字串、theme 由 readTermTheme() 讀成實 hex
      fontFamily: "JetBrains Mono, ui-monospace, monospace",
      fontSize: 13,
      theme: readTermTheme(),
      cursorBlink: true,
      // 實體滾輪以 125ms 動畫捲動（VS Code 同值）；xterm 6.0 內建判別器只對實體滾輪
      // 生效、觸控板維持即時捲動，不會重演 5.x「smooth scroll 毀觸控板」的坑
      smoothScrollDuration: 125,
      // 預設 1000 行對 claude 長對話太早丟歷史；記憶體成本見 design §5（實測於 Task 4-2-5）
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      ws = new WebSocket(wsUrl(port, sessionId));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        attempt = 0; // 連上就重置重連計數
        setTabStatus(tabId, "ready");
      };
      ws.onmessage = (ev) => {
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        term.write(buf);
        // 先 write 再記活動（旁路、不阻斷 bytes）；傳 chunk 大小供 size-gate 過濾 idle 游標心跳
        recordActivity(tabId, buf.byteLength);
      };
      ws.onclose = (e) => {
        if (disposed) return;
        // 4001/1008：session 已結束 → 不重連
        if (!shouldReconnect(e.code)) {
          setTabStatus(tabId, "ended");
          return;
        }
        // backend 非 up（suspect/down/restarting）→ 不重連（整個後端沒了、徒勞），留 offline 由 banner 主導。
        // 刻意用 getState() 讀當下值、不放進 effect 依賴：否則 backendStatus 每次轉換都會 teardown+rebuild
        // xterm（term.dispose 毀掉終端機內容）。已排程的 timer 即使在 backend 掛掉後 fire，也只是 connect
        // 失敗→onclose→這個 gate→offline，無害。
        if (useAppStore.getState().backendStatus !== "up") {
          setTabStatus(tabId, "offline");
          return;
        }
        // 網路異常：backoff 重連，最多 5 次
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          setTabStatus(tabId, "ended");
          return;
        }
        setTabStatus(tabId, "offline");
        const delay = nextDelay(attempt); // nextDelay 以 0-based attempt 取 backoff（先取 delay 再遞增）
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    connect();

    // 用 ResizeObserver 觀察自己的 container 尺寸：視窗縮放、sidebar 變化、
    // 以及從隱藏（display:none）切回顯示時都會觸發，據以 fit + 回報 PTY 尺寸。
    // 隱藏中的 tab container 尺寸為 0、offsetParent 為 null → 跳過；否則 fit 會算出
    // 最小 1×2、切回時 Claude 全螢幕 TUI 亂掉（Codex／final review MEDIUM）。
    const lastDims = { rows: 0, cols: 0 };
    const syncSize = () => {
      if (!containerRef.current?.offsetParent) return;
      fit.fit();
      // 行列實際變動才回報 PTY：切回瞬間多觸發點齊發時不連打 resize HTTP（design §4.2）
      if (term.rows !== lastDims.rows || term.cols !== lastDims.cols) {
        lastDims.rows = term.rows;
        lastDims.cols = term.cols;
        resizeSession(port, sessionId, term.rows, term.cols);
      }
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(containerRef.current);

    // 回前景／切回 tab 的強制重繪：fit 結果相同也補一次 full refresh——
    // 堵住「fit 不變就不重繪」的洞（WKWebView 停 rAF 後 xterm 的恢復補繪訊號會漏接，
    // design §1）。多觸發點（isActive/visibilitychange/focus）以 rAF coalesce 成同
    // frame 一次；rAF 同時讓 display:none→block 的 layout 先發生再量測。
    let refreshRaf: number | null = null;
    const forceRefresh = () => {
      if (refreshRaf != null) return;
      refreshRaf = requestAnimationFrame(() => {
        refreshRaf = null;
        // 排程後才切走的殘留 rAF：隱藏中不量測不重繪（hidden tab 不渲染、不 churn）
        if (!containerRef.current?.offsetParent) return;
        syncSize();
        term.refresh(0, term.rows - 1);
      });
    };
    forceRefreshRef.current = forceRefresh;

    // 視窗回前景／app 回焦：僅 active terminal 響應（ref 取當下值，不擴 effect 依賴）
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && isActiveRef.current) forceRefresh();
    };
    const onWindowFocus = () => {
      if (isActiveRef.current) forceRefresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);

    // 字型非同步載完後清 WebGL glyph atlas，避免用 fallback 字型快取出錯字形（design §4.3）
    document.fonts?.ready.then(() => webglRef.current?.clearTextureAtlas());

    // 首次掛載與 mount effect 重建（restartTab 換 sessionId 等）時，若本 tab 為 active
    // 直接掛 WebGL——isActive effect 只依賴 isActive，effect 重建時不會重跑，漏掛會讓
    // active terminal 卡在 DOM renderer 直到下次切 tab。attachWebgl 有 webglRef guard，冪等。
    // forceRefresh 獨立呼叫：attachWebgl 在 kill switch／webglFailed 路徑會早退、不補 refresh
    //（Codex plan review R1 MEDIUM）；rAF coalesce 使其與 attachWebgl 內部那次同 frame 合一。
    if (isActiveRef.current) {
      attachWebgl();
      forceRefreshRef.current?.();
    }

    return () => {
      disposed = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      if (refreshRaf != null) cancelAnimationFrame(refreshRaf);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
      forceRefreshRef.current = null;
      ro.disconnect();
      ws?.close();
      detachWebgl();
      term.dispose();
      clearActivity(tabId);
      termRef.current = null;
    };
  }, [port, sessionId, tabId, setTabStatus]);

  // 開 tab／切回此 tab（變 active）時聚焦終端機 + 強制重繪。
  // 隱藏中的 tab 不聚焦（focus 對 display:none 無效）。
  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive) {
      attachWebgl(); // active-only：掛 WebGL（失敗自動留在 DOM renderer）
      termRef.current?.focus();
      forceRefreshRef.current?.();
    } else {
      detachWebgl(); // 切走即卸；此時已 display:none，不需 refresh
    }
  }, [isActive]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

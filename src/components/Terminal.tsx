import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resizeSession, wsUrl } from "../lib/sidecar";
import { useAppStore } from "../store/useAppStore";
import { shouldReconnect, nextDelay, MAX_RECONNECT_ATTEMPTS } from "../lib/wsReconnect";
import { recordActivity, clearActivity } from "../lib/activityTracker";
import { readTermTheme } from "../styles/term-theme";

interface TerminalProps {
  port: number;
  sessionId: string;
  tabId: string;
  isActive: boolean;
}

export function Terminal({ port, sessionId, tabId, isActive }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const setTabStatus = useAppStore((s) => s.setTabStatus);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      // xterm canvas 不解析 CSS 變數 → fontFamily 用實字串、theme 由 readTermTheme() 讀成實 hex
      fontFamily: "JetBrains Mono, ui-monospace, monospace",
      fontSize: 13,
      theme: readTermTheme(),
      cursorBlink: true,
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
    const syncSize = () => {
      if (!containerRef.current?.offsetParent) return;
      fit.fit();
      resizeSession(port, sessionId, term.rows, term.cols);
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      ro.disconnect();
      ws?.close();
      term.dispose();
      clearActivity(tabId);
      termRef.current = null;
    };
  }, [port, sessionId, tabId, setTabStatus]);

  // 開 tab／切回此 tab（變 active）時聚焦終端機，鍵盤輸入直接進 claude，
  // 免得開啟後還要先點一下右側才能打字。隱藏中的 tab 不聚焦（focus 對 display:none 無效）。
  useEffect(() => {
    if (isActive) termRef.current?.focus();
  }, [isActive]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

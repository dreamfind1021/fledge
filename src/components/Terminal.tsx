import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css"; // 排在 xterm.css 之後：composition-view 覆寫同特異度、後者勝
import { WebglAddon } from "@xterm/addon-webgl";
import { resizeSession, wsUrl } from "../lib/sidecar";
import { useAppStore } from "../store/useAppStore";
import { shouldReconnect, nextDelay, MAX_RECONNECT_ATTEMPTS } from "../lib/wsReconnect";
import { recordActivity, clearActivity } from "../lib/activityTracker";
import { readTermTheme } from "../styles/term-theme";
import { ImeReplayGuard } from "../lib/imeReplayGuard";
import { ImeDraftTracker } from "../lib/imeDraftTracker";
import { FlowController, type FlowSignal } from "../lib/flowControl";

// WebGL kill switch：Tahoe WebKit 有破圖前例（xterm#5816），驗收若中獎改 false 一鍵退 DOM
const ENABLE_WEBGL = true;
// context loss / 載入失敗的永久停用旗標（attach throw 或短窗內 loss 達 3 次才設）
let webglFailed = false;
// 60 秒滾動窗內的 loss 計數：零星 loss（WebKit context 上限驅逐等暫時因素）允許下次
// activation 重掛；同窗累計 3 次 = 此頁 WebGL 渲染當前不穩（不限定 GPU 異常）→ 為避免
// 重建風暴永久停用。計數跨 tab 共享（module-level）——上限驅逐本就是 page-level 現象。
let lossWindowStart = 0;
let lossCountInWindow = 0;
const LOSS_WINDOW_MS = 60_000;
const LOSS_PERMANENT_THRESHOLD = 3;

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
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // WebGL 只掛 active terminal：隱藏 tab 的渲染本來就暫停（畫了也看不到），
  // 且 WebKit 對單頁 WebGL context 數量有上限，全 tab 掛載會在多 tab 時互逐（design §4.3）
  const detachWebgl = () => {
    const addon = webglRef.current;
    if (!addon) return;
    const canvas = webglCanvasRef.current; // attach 成功當下 capture，不在 detach 時 query DOM
    webglRef.current = null;
    webglCanvasRef.current = null;
    addon.dispose(); // dispose 後 xterm 自動退回 DOM renderer、canvas 移出 DOM
    // addon 不釋放 WebGL context（等 GC）；WebKit 對單頁 context 有上限、滾動驅逐
    //（真機驗收實證）→ 顯式歸還。對已 lost 的 context 呼叫為預期 no-op。
    canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
  };
  const attachWebgl = () => {
    if (!ENABLE_WEBGL || webglFailed || webglRef.current || !termRef.current) return;
    let addon: WebglAddon | null = null;
    try {
      addon = new WebglAddon();
      addon.onContextLoss(() => {
        const now = Date.now();
        if (now - lossWindowStart > LOSS_WINDOW_MS) {
          lossWindowStart = now;
          lossCountInWindow = 0;
        }
        lossCountInWindow += 1;
        if (lossCountInWindow >= LOSS_PERMANENT_THRESHOLD) {
          // 短窗內反覆 loss：此頁 WebGL 當前不穩 → 停止重建風暴，本生命週期退 DOM
          webglFailed = true;
          console.warn("WebGL context 短時間內反覆 loss：本次 app 生命週期全域退回 DOM renderer");
        } else {
          console.warn("WebGL context loss：已卸載，下次切回此分頁時重試 WebGL");
        }
        detachWebgl();
        forceRefreshRef.current?.(); // renderer 轉換後重繪閉環不變
      });
      termRef.current.loadAddon(addon);
      webglRef.current = addon;
      // attach 成功當下 capture 主 canvas（無 class；link layer 有 xterm-link-layer class）。
      // 依賴 xterm 6.0.0 / addon-webgl 0.19.0 的 DOM contract——升級這兩個套件時重驗（design §4.3-3）
      webglCanvasRef.current =
        termRef.current.element?.querySelector<HTMLCanvasElement>(".xterm-screen canvas:not([class])") ?? null;
    } catch (err) {
      webglFailed = true; // 建構/載入 throw＝環境不支援 → 本生命週期停用
      console.warn("WebGL renderer 載入失敗，本生命週期退回 DOM renderer", err);
      // throw 可能發生在 context 已建立之後 → best-effort 清掉 partial addon 與殘留 context
      try {
        addon?.dispose();
      } catch {
        // partial addon dispose 再失敗屬預期可能，忽略
      }
      const orphan = termRef.current.element?.querySelector<HTMLCanvasElement>(".xterm-screen canvas:not([class])");
      orphan?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      orphan?.remove();
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

    // 機制 A 重放攔截。listener 掛 container 的 capture phase（第三參數 true）是攔截成立的前提：
    // 同一 target 上的 listener 按註冊序執行、xterm 在 term.open() 已先在 textarea 註冊，
    // 掛 ancestor capture 才保證先於 xterm 看到事件、preventDefault 才來得及。
    const imeGuard = new ImeReplayGuard();
    const imeContainer = containerRef.current!; // cleanup 時 ref 可能已被 React 清掉，捕捉成變數
    let imeBlockedData: string | null = null;
    // 幽靈草稿（接線）：純視覺、不進 PTY。掛 .xterm-helpers＝與 helper textarea 同座標系，
    // 其 style.left/top 即游標座標；懸置當下定格、第一個互動移除，偏移屬可接受的暫態。
    const imeDraft = new ImeDraftTracker();
    const imeGhost = document.createElement("div");
    imeGhost.style.cssText =
      "position:absolute;pointer-events:none;z-index:2;display:none;white-space:pre;" +
      "opacity:0.55;border-bottom:1px dashed currentColor;" +
      "font-family:JetBrains Mono,ui-monospace,monospace;font-size:13px;";
    imeGhost.style.color = readTermTheme().foreground ?? "#ccc";
    term.element?.querySelector(".xterm-helpers")?.appendChild(imeGhost);
    const syncImeGhost = () => {
      const draft = imeDraft.suspendedDraft;
      if (draft == null) {
        imeGhost.style.display = "none";
        return;
      }
      imeGhost.textContent = draft;
      imeGhost.style.left = term.textarea?.style.left || "0px";
      imeGhost.style.top = term.textarea?.style.top || "0px";
      imeGhost.style.display = "block";
    };
    const onImeCompStart = () => {
      imeGuard.compositionStart();
      imeDraft.compositionStart();
      syncImeGhost();
    };
    const onImeCompEnd = (e: Event) => {
      imeGuard.compositionEnd((e as CompositionEvent).data ?? "", performance.now());
      imeDraft.compositionEnd((e as CompositionEvent).data ?? "", performance.now());
      syncImeGhost();
    };
    const onImeWinBlur = () => {
      imeGuard.markBlur(performance.now());
      imeDraft.markBlur(performance.now());
      syncImeGhost();
    };
    const onImeBeforeInput = (e: Event) => {
      const ie = e as InputEvent;
      if (imeGuard.shouldBlock(ie.inputType, ie.data, ie.isTrusted)) {
        if (ie.cancelable) {
          ie.preventDefault(); // 取消插入：xterm 收不到 input、textarea 也不會殘值重灌
        } else {
          // 防禦性分支（標準上 insertText beforeinput 可取消）：由下方 input capture 擋傳播；
          // setTimeout(0) 同 task 過期——preventDefault 生效時 input 不會 fire，flag 不清會
          // 殘留到日後誤攔相同字串（階段 4 審查 H2）
          imeBlockedData = ie.data;
          window.setTimeout(() => { imeBlockedData = null; }, 0);
        }
        console.warn("IME 重放已攔截（真懸置保險網）：", ie.data);
      }
      if (ie.inputType === "insertText") {
        imeDraft.dismiss(); // Enter 重放（或一般英數輸入）→ 幽靈草稿退場
        syncImeGhost();
      }
    };
    const onImeInput = (e: Event) => {
      const ie = e as InputEvent;
      if (imeBlockedData !== null && ie.inputType === "insertText" && ie.data === imeBlockedData) {
        ie.stopPropagation(); // xterm 的 textarea input listener 收不到 → 不送出（殘值無害）
      }
      imeBlockedData = null; // one-shot
    };
    const onImeKeyDown = (e: Event) => {
      if (imeGuard.shouldSwallowKeydown((e as KeyboardEvent).key)) {
        // 只擋 xterm（stopPropagation）、不擋 OS（無 preventDefault）：Cmd+Tab 照常切視窗，
        // xterm 看不到 Meta keydown 就不會提前 finalize 組字（design §1.1 真懸置）
        e.stopPropagation();
      }
      if ((e as KeyboardEvent).key === "Escape") {
        imeDraft.dismiss();
        syncImeGhost();
      }
    };
    const onImeCompUpdate = (e: Event) => imeDraft.compositionUpdate((e as CompositionEvent).data ?? "");
    const onImePointerDown = () => {
      imeDraft.dismiss(); // 點擊即消隱（保守：點擊後 IME 是否保留懸置不可知，視覺先收掉）
      syncImeGhost();
    };
    const onImeFocusOut = () => {
      imeDraft.dismiss(); // in-app 焦點轉移（切 tab、點 sidebar）→ 不殘留 ghost；
      syncImeGhost();     // Cmd+Tab 切走不觸發 focusout（WKWebView 保持 activeElement）、ghost 正確保留
    };
    imeContainer.addEventListener("compositionstart", onImeCompStart, true);
    imeContainer.addEventListener("compositionend", onImeCompEnd, true);
    imeContainer.addEventListener("beforeinput", onImeBeforeInput, true);
    imeContainer.addEventListener("input", onImeInput, true);
    imeContainer.addEventListener("keydown", onImeKeyDown, true);
    imeContainer.addEventListener("compositionupdate", onImeCompUpdate, true);
    imeContainer.addEventListener("mousedown", onImePointerDown, true);
    imeContainer.addEventListener("focusout", onImeFocusOut, true);
    window.addEventListener("blur", onImeWinBlur);

    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      const socket = new WebSocket(wsUrl(port, sessionId));
      ws = socket; // 外層 mutable：term.onData 送鍵盤輸入、cleanup 的 ws?.close() 都參照「當前」連線
      socket.binaryType = "arraybuffer";
      // 每條連線全新計帳：重連後舊連線的延遲 ack 落在舊 instance，無共享狀態、無計數污染（design §6）
      const flow = new FlowController();
      // 控制訊息一律送往這條連線的 socket（closure capture，不引用外層 ws）：
      // 舊連線延遲 ack 觸發的 resume 不會誤入新連線的 gate。舊 socket 已 CLOSED → readyState guard no-op。
      const sendFlow = (sig: FlowSignal) => {
        if (sig && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: sig })); // text frame＝控制通道
        }
      };
      socket.onopen = () => {
        attempt = 0; // 連上就重置重連計數
        setTabStatus(tabId, "ready");
      };
      socket.onmessage = (ev) => {
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        const n = buf.byteLength;
        // 越過 HIGH → 請後端暫停讀 PTY（write 前計入；write callback 回呼時扣除、回落 LOW → resume）
        sendFlow(flow.record(n));
        term.write(buf, () => sendFlow(flow.ack(n)));
        // 先 write 再記活動（旁路、不阻斷 bytes）；傳 chunk 大小供 size-gate 過濾 idle 游標心跳
        recordActivity(tabId, n);
      };
      socket.onclose = (e) => {
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
      imeGuard.noteData(data);
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
      imeContainer.removeEventListener("compositionstart", onImeCompStart, true);
      imeContainer.removeEventListener("compositionend", onImeCompEnd, true);
      imeContainer.removeEventListener("beforeinput", onImeBeforeInput, true);
      imeContainer.removeEventListener("input", onImeInput, true);
      imeContainer.removeEventListener("keydown", onImeKeyDown, true);
      imeContainer.removeEventListener("compositionupdate", onImeCompUpdate, true);
      imeContainer.removeEventListener("mousedown", onImePointerDown, true);
      imeContainer.removeEventListener("focusout", onImeFocusOut, true);
      imeGhost.remove();
      window.removeEventListener("blur", onImeWinBlur);
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

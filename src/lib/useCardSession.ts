import { useEffect, useRef, useState } from "react";
import { createSession, closeSession, SessionError, type CreateSessionOptions } from "./sidecar";

/** 卡片內執行中的 session。`cardId` 是「掛在哪一張卡／哪一列」的識別，不是 session id。 */
export interface CardSession<T> {
  cardId: string;
  sessionId: string;
  tabId: string;
  meta: T;            // 呼叫端自己要的附帶資料（標頭文字等）
}

interface StartArgs<T> {
  cardId: string;
  options: CreateSessionOptions;
  meta: T;
  /** 把後端判別碼（400 才有）映射成 i18n 字串；回 null 代表交給 fallback */
  mapError: (code: string | null) => string | null;
  fallbackError: (reason: string) => string;
}

/** 精靈設置卡共用的「卡片內單一終端機 session」生命週期（環境卡的安裝、登入卡的 OAuth）。
 *
 * 一次只跑一個：卡片內只有一個終端機位置，且併行的安裝會互相撞鎖。切換時**先關完舊的才建新的**
 * ——後端一收到 create 就 spawn PTY，先建後關會讓兩者真的併行過一段時間（票 24 Codex R1）。
 * 卸載時一律收掉 PTY，不留前端再也找不到的 orphan。 */
export function useCardSession<T>(port: number | null) {
  const [running, setRunning] = useState<CardSession<T> | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // cleanup effect 的依賴是空陣列（不能跟著 port／running 重跑，否則會誤殺執行中的 session），
  // 所以卸載時要關的 session 與當下的 port 都走 render body 同步的 ref 讀（比照 Terminal 的 isActiveRef）
  const runningRef = useRef<CardSession<T> | null>(null);
  const portRef = useRef(port);
  runningRef.current = running;
  portRef.current = port;

  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
      const live = runningRef.current;
      if (live && portRef.current != null) void closeSession(portRef.current, live.sessionId);
    };
  }, []);

  /** 回傳是否真的建立了 session——呼叫端據此收起確認面板之類的過場 UI。 */
  const start = async ({ cardId, options, meta, mapError, fallbackError }: StartArgs<T>): Promise<boolean> => {
    if (port == null || starting) return false;
    const prev = runningRef.current;
    setStarting(true);
    setError(null);
    try {
      if (prev) {
        setRunning(null);                                   // 先卸載舊 Terminal（收 WS）
        await closeSession(port, prev.sessionId);
        if (!mounted.current) return false;
      }
      const sessionId = await createSession(port, options);
      if (!mounted.current) {
        void closeSession(port, sessionId);                 // 卸載後才回來的 session 沒人掛得上
        return false;
      }
      setRunning({ cardId, sessionId, tabId: `ob-${cardId}-${sessionId}`, meta });
      return true;
    } catch (e) {
      if (!mounted.current) return false;
      // 後端判別碼不得直接顯示（spec-b4 §5）；未知形狀退回帶 reason 的通用訊息
      const code = e instanceof SessionError ? e.code : null;
      setError(mapError(code) ?? fallbackError(String(e)));
      return false;
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  return { running, starting, error, setError, start };
}

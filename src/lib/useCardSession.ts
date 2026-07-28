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
  /** 沒有判別碼可映射時的通用訊息。**不收 reason**——例外原文（`createSession failed: 500`、
   *  `TypeError: Failed to fetch`、sidecar 的中文 prose）只進 console（spec-b4 §5） */
  fallbackError: () => string;
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
  // latest-start-wins：按鈕互斥擋不住 `port` 變更這個**自動**入口（sidecar 重啟時呼叫端的
  // effect 會直接重跑）。在途的建立若照樣落地，終端機會拿新 port 去連舊 sidecar 的 session。
  const startGen = useRef(0);

  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
      const live = runningRef.current;
      if (live && portRef.current != null) void closeSession(portRef.current, live.sessionId);
    };
  }, []);

  useEffect(() => {
    // port 換掉＝換了一個 sidecar：在途的建立作廢，已掛著的 session 也隨舊 sidecar 一起沒了
    // （不必也無法 closeSession——舊 sidecar 已經不在）。首次 mount 跑這輪只是把基準設好。
    startGen.current += 1;
    setRunning(null);
    // 作廢的同時要把 busy 交還：被作廢的那一輪在 finally 會因 stale 而跳過 setStarting(false)，
    // 沒有人接手的話按鈕就永久停用到切頁重掛（Codex 票25 R4 Medium）。
    setStarting(false);
  }, [port]);

  /** 回傳是否真的建立了 session——呼叫端據此收起確認面板之類的過場 UI。 */
  const start = async ({ cardId, options, meta, mapError, fallbackError }: StartArgs<T>): Promise<boolean> => {
    if (port == null || starting) return false;
    const prev = runningRef.current;
    // 這一輪的身分與它所屬的 sidecar：後續每個 await 之後都要確認自己還是最新的那一輪
    const myGen = ++startGen.current;
    const myPort = port;
    const stale = () => !mounted.current || startGen.current !== myGen;
    setStarting(true);
    setError(null);
    try {
      if (prev) {
        setRunning(null);                                   // 先卸載舊 Terminal（收 WS）
        await closeSession(myPort, prev.sessionId);
        if (stale()) return false;
      }
      const sessionId = await createSession(myPort, options);
      if (stale()) {
        // 卸載後才回來、或 sidecar 已經換了一輪：這個 session 沒人掛得上。
        // 用**建立時的 port** 收，不是當下的 port——後者指向另一個 sidecar。
        void closeSession(myPort, sessionId);
        return false;
      }
      setRunning({ cardId, sessionId, tabId: `ob-${cardId}-${sessionId}`, meta });
      return true;
    } catch (e) {
      if (stale()) return false;
      // 後端判別碼不得直接顯示（spec-b4 §5）；未知形狀退回通用訊息，原文只進 console
      console.error("[onboarding] 卡片內 session 建立失敗", e);
      const code = e instanceof SessionError ? e.code : null;
      setError(mapError(code) ?? fallbackError());
      return false;
    } finally {
      // 過期的那一輪不得解除 busy——否則新一輪還在跑，按鈕卻已經放開
      if (!stale()) setStarting(false);
    }
  };

  return { running, starting, error, setError, start };
}

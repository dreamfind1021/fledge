import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { ChevronRight } from "lucide-react";
import {
  fetchSetupStatus, createSession, closeSession, SessionError,
  type ToolStatus, type ToolTier,
} from "../lib/sidecar";
import { writeClipboard } from "../lib/clipboard";
import { Terminal } from "./Terminal";

interface EnvCardProps {
  port: number | null;
  onPrev: () => void;
  onNext: () => void;
}

// 「已複製」回饋的顯示時間；純視覺回饋，超時後按鈕文字換回「複製」
const COPIED_FEEDBACK_MS = 2000;

// 執行中的安裝：卡片內掛一個 Terminal 需要 sessionId 與一個 tabId。
// tabId 只是 activityTracker／terminalRegistry 的 key，這裡合成一個絕不會與真 tab 相撞的值
// （真 tab 用 uuid）；對應的 tab 不存在於 store，setTabStatus／setTabActivity 因此是 no-op。
interface RunningInstall {
  toolId: string;
  sessionId: string;
  tabId: string;
  command: string;   // 標頭顯示「實際跑的是什麼」，值來自後端 payload
}

/** 精靈的環境頁：核心／常用兩區工具狀態（唯讀偵測）＋重新檢查＋一鍵安裝。
 *
 * 狀態一律即時偵測、不落存（spec-b4 §4）。工具清單與命令字串全部來自後端 TOOL_SPECS——
 * 本檔不得出現任何安裝命令字面值，送出的 body 也只有 install_id（spec §5 allowlist 不變式）。 */
export function EnvCard({ port, onPrev, onNext }: EnvCardProps) {
  const { t } = useTranslation("onboarding");
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 展開的那一列：僅手動安裝的工具展開「複製指令」、可一鍵安裝的展開「執行前確認」。
  // 同一列不會兩種都要，故共用一個 id——也順帶保證同時只展開一列。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);       // 建 session 中，擋重複送出
  const [running, setRunning] = useState<RunningInstall | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // latest-request-wins：偵測會重疊（重啟 sidecar 換 port 就會在舊請求在途時再發一次），
  // 晚到的舊回應若照樣寫進 state，畫面會退回上一輪的結果、或在正確結果上蓋一條過期錯誤。
  const reqId = useRef(0);
  const mounted = useRef(true);
  // cleanup effect 的依賴是空陣列（不能讓它跟著 port／running 重跑，否則會誤殺執行中的安裝），
  // 所以卸載時要關的 session 與當下的 port 都走 render body 同步的 ref 讀（比照 Terminal 的 isActiveRef）
  const runningRef = useRef<RunningInstall | null>(null);
  const portRef = useRef(port);
  runningRef.current = running;
  portRef.current = port;

  const load = useCallback(async () => {
    if (port == null) return;
    const myId = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchSetupStatus(port);
      if (reqId.current !== myId) return;
      setTools(next);
    } catch (e) {
      if (reqId.current !== myId) return;
      // 偵測失敗要可見（沉默的空清單會被當成「什麼都沒裝」）；舊結果保留在畫面上
      setError(t("errors.status_failed", { reason: String(e) }));
    } finally {
      if (reqId.current === myId) setLoading(false);
    }
  }, [port, t]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
      reqId.current += 1;     // 使在途請求失效，卸載後不再 setState
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      // 離開這一步就收掉安裝 PTY：留著會變成前端再也找不到的 orphan（使用者已在確認面板被
      // 告知離開會中斷安裝）。closeSession 自己吞錯誤、不 throw。
      const live = runningRef.current;
      if (live && portRef.current != null) void closeSession(portRef.current, live.sessionId);
    };
  }, []);

  const copy = async (tool: ToolStatus) => {
    if (!tool.manual_command) return;
    const ok = await writeClipboard(tool.manual_command);
    // 卸載可能發生在寫入完成前——cleanup 已經跑過，此時再排 timer 就沒人清得掉
    if (!ok || !mounted.current) return;   // 失敗不謊稱已複製
    setCopiedId(tool.id);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedId(null), COPIED_FEEDBACK_MS);
  };

  /** 確認執行後才走到這裡：建 install session（body 只有 install_id）並掛終端機。 */
  const startInstall = async (tool: ToolStatus) => {
    if (port == null || starting) return;
    const prev = runningRef.current;
    setStarting(true);
    setError(null);
    try {
      const sessionId = await createSession(port, { path: "", kind: "install", installId: tool.id });
      if (!mounted.current) {
        void closeSession(port, sessionId);   // 卸載後才回來的 session 沒人掛得上，直接收掉
        return;
      }
      // 一次只跑一個安裝：兩個 brew 併行會互相撞鎖，且卡片內只有一個終端機位置
      if (prev) void closeSession(port, prev.sessionId);
      setRunning({
        toolId: tool.id,
        sessionId,
        tabId: `ob-install-${sessionId}`,
        command: tool.install_command ?? "",
      });
      setExpandedId(null);                    // 確認面板讓位給終端機
    } catch (e) {
      if (!mounted.current) return;
      // 後端判別碼不得直接顯示（spec-b4 §5）；未知形狀退回帶 reason 的通用訊息
      const code = e instanceof SessionError ? e.code : null;
      setError(code === "unknown_install_id"
        ? t("errors.unknown_install_id")
        : t("errors.install_failed", { reason: String(e) }));
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const renderRow = (tool: ToolStatus) => (
    // 展開的手動指令面板要接在觸發它的那一列下面，故與該列同屬一個 fragment
    <div key={tool.id} className="b4-row-group">
      <div className="b4-item">
        <span className={`b4-dot ${tool.installed ? "ok" : "todo"}`} />
        <span className="b4-item-name">{tool.label}</span>
        {/* 已安裝但版本探測失敗（timeout／非零退出）時 version 為 null → 退回 binary 名 */}
        <span className="b4-item-meta">{tool.version ?? tool.binary}</span>
        <span className="b4-item-right">
          <span className={`b4-chip ${tool.installed ? "ok" : "todo"}`}>
            {t(tool.installed ? "env.installed" : "env.missing")}
          </span>
          {/* 執行中那一列不再給安裝鍵——終端機已經佔住它的位置 */}
          {!tool.installed && tool.install_command && running?.toolId !== tool.id && (
            // primary 只給核心工具——常用區是可略過的，demo 也只讓核心那顆吃強調色
            <button
              className={`b4-btn-sm${tool.tier === "core" ? " primary" : ""}`}
              onClick={() => setExpandedId((id) => (id === tool.id ? null : tool.id))}
              aria-expanded={expandedId === tool.id}
            >{t("env.install")}</button>
          )}
          {!tool.installed && !tool.install_command && tool.manual_command && (
            <button
              className="b4-btn-sm"
              onClick={() => setExpandedId((id) => (id === tool.id ? null : tool.id))}
              aria-expanded={expandedId === tool.id}
            >{t("env.copyCmd")}</button>
          )}
        </span>
      </div>

      {/* 條件要與觸發鍵一致（含 !installed）：重新檢查後轉為已安裝時，觸發鍵消失、
          面板卻留著會變成一塊講「需要手動安裝」又收不掉的死內容 */}
      {expandedId === tool.id && !tool.installed && tool.manual_command && (
        <div className="b4-confirm">
          <div className="b4-confirm-title">{t("env.brewTitle")}</div>
          <div className="b4-confirm-cmd">{tool.manual_command}</div>
          <div className="b4-confirm-foot">
            <button className="b4-btn-sm" onClick={() => copy(tool)}>
              {t(copiedId === tool.id ? "env.copied" : "common.copy")}
            </button>
            <span className="b4-hint b4-hint-inline">{t("env.brewHint")}</span>
          </div>
        </div>
      )}

      {/* 執行前確認：上游 spec §5 硬性要求——先看到完整將執行的命令才動手。
          命令字串來自後端 payload，與 PTY 實際查表取得的是同一份。 */}
      {expandedId === tool.id && !tool.installed && tool.install_command && running?.toolId !== tool.id && (
        <div className="b4-confirm">
          <div className="b4-confirm-title">{t("env.confirmTitle")}</div>
          <div className="b4-confirm-cmd">{tool.install_command}</div>
          <div className="b4-confirm-foot">
            <button className="b4-btn-sm primary" onClick={() => startInstall(tool)} disabled={starting}>
              {t("env.confirmRun")}
            </button>
            <button className="b4-btn-sm" onClick={() => setExpandedId(null)}>{t("common.cancel")}</button>
            <span className="b4-hint b4-hint-inline">{t("env.installHint")}</span>
          </div>
        </div>
      )}

      {/* 安裝終端機：可互動（sudo 提示可直接回答）。**不 gate installed**——跑完轉成已安裝
          正是成功結果，輸出要留在原地供檢視（與上面「怎麼手動裝」的面板性質相反）。 */}
      {running?.toolId === tool.id && port != null && (
        <div className="b4-term">
          <div className="b4-term-head">
            <ChevronRight size={12} strokeWidth={2} />
            <span className="b4-term-cmd">{running.command}</span>
          </div>
          <div className="b4-term-mount">
            <Terminal port={port} sessionId={running.sessionId} tabId={running.tabId} isActive />
          </div>
        </div>
      )}
    </div>
  );

  const section = (tier: ToolTier, heading: string) => {
    const rows = (tools ?? []).filter((x) => x.tier === tier);
    if (rows.length === 0) return null;
    return (
      <div className="b4-sec">
        <p className="b4-sec-h">{heading}</p>
        <div className="b4-card"><div className="b4-list">{rows.map(renderRow)}</div></div>
      </div>
    );
  };

  return (
    <div>
      <h2 className="ob-h">{t("env.h")}</h2>
      <p className="ob-sub">{t("env.sub")}</p>

      {error && <div className="ob-error" role="alert">{error}</div>}
      {tools === null && loading && <p className="ob-sub">{t("env.checking")}</p>}

      {section("core", t("env.core"))}
      {section("recommended", t("env.recommended"))}

      {/* 3e 降級：PATH 與 git 身分本版不偵測，只給靜態提醒（spec-b4 §1） */}
      <p className="b4-hint"><Trans t={t} i18nKey="env.pathHint" /></p>

      <div className="ob-actions">
        <button onClick={onPrev} className="ob-btn-ghost">{t("common.prev")}</button>
        <div className="ob-actions-right">
          <button onClick={load} disabled={loading} className="b4-btn-sm">{t("env.recheck")}</button>
          <button onClick={onNext} className="ob-btn">{t("common.next")}</button>
        </div>
      </div>
    </div>
  );
}

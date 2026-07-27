import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { fetchSetupStatus, type ToolStatus, type ToolTier } from "../lib/sidecar";
import { writeClipboard } from "../lib/clipboard";
import { useCardSession } from "../lib/useCardSession";
import { CardTerminal } from "./CardTerminal";

interface EnvCardProps {
  port: number | null;
  onPrev: () => void;
  onNext: () => void;
}

// 「已複製」回饋的顯示時間；純視覺回饋，超時後按鈕文字換回「複製」
const COPIED_FEEDBACK_MS = 2000;

/** 精靈的環境頁：核心／常用兩區工具狀態（唯讀偵測）＋重新檢查＋一鍵安裝。
 *
 * 狀態一律即時偵測、不落存（spec-b4 §4）。工具清單與命令字串全部來自後端 TOOL_SPECS——
 * 本檔不得出現任何安裝命令字面值，送出的 body 也只有 install_id（spec §5 allowlist 不變式）。
 * 安裝 session 的生命週期（一次一個、關舊再建新、卸載收 PTY）走共用的 `useCardSession`。 */
export function EnvCard({ port, onPrev, onNext }: EnvCardProps) {
  const { t } = useTranslation("onboarding");
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  // 展開的那一列：僅手動安裝的工具展開「複製指令」、可一鍵安裝的展開「執行前確認」。
  // 同一列不會兩種都要，故共用一個 id——也順帶保證同時只展開一列。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // latest-request-wins：偵測會重疊（重啟 sidecar 換 port 就會在舊請求在途時再發一次），
  // 晚到的舊回應若照樣寫進 state，畫面會退回上一輪的結果、或在正確結果上蓋一條過期錯誤。
  const reqId = useRef(0);
  const mounted = useRef(true);
  // meta 存「實際會跑的命令」，供終端機標頭顯示（值來自後端 payload，前端不自組）
  const { running, starting, error: sessionError, setError: setSessionError, start } =
    useCardSession<string>(port);

  const load = useCallback(async () => {
    if (port == null) return;
    const myId = ++reqId.current;
    setLoading(true);
    setDetectError(null);
    setSessionError(null);   // 重新檢查＝重新來過，上一輪的安裝錯誤不該留在畫面上
    try {
      const next = await fetchSetupStatus(port);
      if (reqId.current !== myId) return;
      setTools(next);
    } catch (e) {
      if (reqId.current !== myId) return;
      // 偵測失敗要可見（沉默的空清單會被當成「什麼都沒裝」）；舊結果保留在畫面上。
      // 例外原文只進 console——`String(e)` 會把 HTTP 狀態碼與 sidecar 的中文 prose
      // 帶進畫面，違反「畫面全由 catalog 映射」（spec-b4 §5）
      console.error("[onboarding] 工具偵測失敗", e);
      setDetectError(t("errors.status_failed"));
    } finally {
      if (reqId.current === myId) setLoading(false);
    }
    // setSessionError 是 useState setter（引用穩定），不影響此 callback 的重建時機
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, t]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
      reqId.current += 1;     // 使在途請求失效，卸載後不再 setState
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      // 安裝 PTY 的收尾在 useCardSession 的 cleanup（同樣是卸載即關，不留 orphan）
    };
  }, []);

  const error = detectError ?? sessionError;

  const copy = async (tool: ToolStatus) => {
    if (!tool.manual_command) return;
    const ok = await writeClipboard(tool.manual_command);
    // 卸載可能發生在寫入完成前——cleanup 已經跑過，此時再排 timer 就沒人清得掉
    if (!ok || !mounted.current) return;   // 失敗不謊稱已複製
    setCopiedId(tool.id);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedId(null), COPIED_FEEDBACK_MS);
  };

  // 偵測與安裝各自寫一個 error state、合併顯示時偵測優先，因此兩者不能並行——晚返回的那個
  // 會蓋掉另一個的結果（Codex 票25 R2）。兩個入口互斥就沒有這個 race 可言。
  const busy = loading || starting;

  /** 確認執行後才走到這裡：建 install session（body 只有 install_id）並掛終端機。 */
  const startInstall = async (tool: ToolStatus) => {
    // 守在 start() 之前而不是進去才擋：start() 回 false 時什麼都沒發生，
    // 那時清掉偵測錯誤等於「清了卻沒開始任何事」。
    if (port == null || busy) return;
    // 安裝真的要開始了：上一輪的偵測失敗已經過期，留著會蓋住這次的安裝結果
    setDetectError(null);
    const ok = await start({
      cardId: tool.id,
      // 安全不變式（spec §5）：只送 allowlist key，命令由後端以 install_id 查 TOOL_SPECS
      options: { path: "", kind: "install", installId: tool.id },
      meta: tool.install_command ?? "",
      mapError: (code) => (code === "unknown_install_id" ? t("errors.unknown_install_id") : null),
      fallbackError: () => t("errors.install_failed"),
    });
    if (ok) setExpandedId(null);   // 確認面板讓位給終端機
  };

  // 觸發鍵與它展開的確認面板必須用同一個判定：條件一旦分岔，就會出現「按鈕沒了、面板還在」
  // 這類收不掉的死內容（票 23 的複製面板就踩過一次）。執行中那列不算——終端機已佔住位置。
  const canInstall = (tool: ToolStatus) =>
    !tool.installed && !!tool.install_command && running?.cardId !== tool.id;

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
          {canInstall(tool) && (
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
      {expandedId === tool.id && canInstall(tool) && (
        <div className="b4-confirm">
          <div className="b4-confirm-title">{t("env.confirmTitle")}</div>
          <div className="b4-confirm-cmd">{tool.install_command}</div>
          <div className="b4-confirm-foot">
            <button className="b4-btn-sm primary" onClick={() => startInstall(tool)} disabled={busy}>
              {t("env.confirmRun")}
            </button>
            <button className="b4-btn-sm" onClick={() => setExpandedId(null)}>{t("common.cancel")}</button>
            <span className="b4-hint b4-hint-inline">{t("env.installHint")}</span>
          </div>
        </div>
      )}

      {/* 安裝終端機：可互動（sudo 提示可直接回答）。**不 gate installed**——跑完轉成已安裝
          正是成功結果，輸出要留在原地供檢視（與上面「怎麼手動裝」的面板性質相反）。 */}
      {running?.cardId === tool.id && port != null && (
        <CardTerminal
          port={port}
          sessionId={running.sessionId}
          tabId={running.tabId}
          title={running.meta}
        />
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
          <button onClick={load} disabled={busy} className="b4-btn-sm">{t("env.recheck")}</button>
          <button onClick={onNext} className="ob-btn">{t("common.next")}</button>
        </div>
      </div>
    </div>
  );
}

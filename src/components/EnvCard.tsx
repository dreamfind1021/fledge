import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { fetchSetupStatus, type ToolStatus, type ToolTier } from "../lib/sidecar";
import { writeClipboard } from "../lib/clipboard";

interface EnvCardProps {
  port: number | null;
  onPrev: () => void;
  onNext: () => void;
}

// 「已複製」回饋的顯示時間；純視覺回饋，超時後按鈕文字換回「複製」
const COPIED_FEEDBACK_MS = 2000;

/** 精靈的環境頁：核心／常用兩區工具狀態（唯讀偵測）＋重新檢查。
 *
 * 狀態一律即時偵測、不落存（spec-b4 §4）。工具清單與命令字串全部來自後端 TOOL_SPECS——
 * 本檔不得出現任何安裝命令字面值。「安裝」按鈕在票 24 才接 PTY，本票只佔位。 */
export function EnvCard({ port, onPrev, onNext }: EnvCardProps) {
  const { t } = useTranslation("onboarding");
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);   // 展開手動指令的那一列
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // latest-request-wins：偵測會重疊（重啟 sidecar 換 port 就會在舊請求在途時再發一次），
  // 晚到的舊回應若照樣寫進 state，畫面會退回上一輪的結果、或在正確結果上蓋一條過期錯誤。
  const reqId = useRef(0);
  const mounted = useRef(true);

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
          {!tool.installed && tool.install_command && (
            // 行為在票 24（確認面板 + 內嵌 PTY）；本票只確定按鈕出現在對的列上。
            // primary 只給核心工具——常用區是可略過的，demo 也只讓核心那顆吃強調色。
            <button className={`b4-btn-sm${tool.tier === "core" ? " primary" : ""}`} disabled>
              {t("env.install")}
            </button>
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

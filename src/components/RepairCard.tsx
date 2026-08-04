import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { repairScope } from "../lib/restoreFormat";
import { OUTCOME_TONE } from "./CommonConfigCard";
import {
  RESTORE_REPAIR_ENTRIES,
  commonConfigPlan,
  commonConfigRepair,
  type CommonConfigOpResult,
} from "../lib/sidecar";
import "./RepairCard.css";

interface AccountInfo {
  config_dir: string;
  label: string;
}

type LinkScan =
  | { phase: "scanning" }
  | { phase: "done"; broken: number }
  | { phase: "not_applicable" }
  | { phase: "error" };

interface RepairCardProps {
  port: number | null;
  accounts: Record<string, AccountInfo>;
  /** 值一變就重測並清掉上一輪的結果。還原卡在「開始展開」與「展開結束」時推進它——
   *  那之後現役目錄可能被動過，上一輪的結果不再描述現況。精靈不需要（那一頁沒有別的
   *  東西會動現役目錄），所以是選填。 */
  rescanToken?: number;
}

/**
 * 共通設置的斷鏈檢查與修復。**兩處掛載共用這一份**：設定頁的還原卡，與移機精靈的
 * `repair` 頁（票 08）。
 *
 * 抽成共用元件的理由不是省行數，是**判準只能有一份**：誰是 source（`repairScope`）、
 * 要送哪些 entry（`RESTORE_REPAIR_ENTRIES`，含進階項 `projects`）、斷鏈怎麼數
 * （`state === "broken_link"`）、修完要不要重測——這幾條在兩處各寫一遍必然漂移，而漂移
 * 的樣態是「一邊修得回來、另一邊修不回來」。
 *
 * **標題與外層容器由呼叫端 render**：還原卡是卡片內的一個分區（有分隔線與小標），精靈是
 * 整頁主體（有大標與導覽列）。把版面差異留在呼叫端，這裡就不必長出 mode 開關。
 *
 * **不自動修復**：它會改寫 symlink，是破壞性操作，一律要使用者明確按下去。
 */
export function RepairCard({ port, accounts, rescanToken }: RepairCardProps) {
  const { t } = useTranslation("restore");
  const [scan, setScan] = useState<LinkScan | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [results, setResults] = useState<CommonConfigOpResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // latest-request-wins（比照 RestoreCard／EnvCard 的 reqId）：sidecar 重啟換 port 會讓
  // 兩輪掃描重疊，晚到的舊回應照樣寫進 state 的話，畫面會退回上一輪的結果
  const scanReq = useRef(0);
  const mounted = useRef(true);

  // effect dep 用簽章而非 accounts 物件：父層每次 render 都給新引用。只看 key——
  // 誰是 source 由 key 的順序決定，config_dir 的內容由後端自己讀。
  const accountsSig = JSON.stringify(Object.keys(accounts));
  // 這一輪操作面對的**資料上下文**（比照 `CommonConfigCard` 的 `ctx`）。render body 同步
  // 寫回 ref，非同步流程才比對得到「回來的時候還是不是同一個世界」——`scanReq` 管的是
  // load-vs-load 的先後，管不到 `onRepair`（同族的第三處，掃 diff 時找到的）。
  const ctx = JSON.stringify([port, accountsSig]);
  const liveCtx = useRef(ctx);
  liveCtx.current = ctx;

  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
    };
  }, []);

  const scanLinks = useCallback(async () => {
    // **序號先遞增再判前提**（Codex 票 08 R1 F2）：兩條「還沒送出就返回」的分支
    // （port 為 null、只剩一個帳號）若不作廢在飛的那一輪，舊回應抵達時序號仍然相等，
    // 就把畫面覆寫回舊帳號組合的結果——連修復按鈕都會重新出現。
    const myId = ++scanReq.current;
    if (port == null) return;
    const scope = repairScope(Object.keys(accounts));
    if (scope === null) {
      setScan({ phase: "not_applicable" });
      return;
    }
    setScan({ phase: "scanning" });
    try {
      // 偵測用既有的 common-config/plan：它已經回逐項 state，不需要另做一個端點
      const plan = await commonConfigPlan(port, { ...scope, entries: RESTORE_REPAIR_ENTRIES });
      if (!mounted.current || myId !== scanReq.current) return;
      setScan({
        phase: "done",
        broken: plan.operations.filter((o) => o.state === "broken_link").length,
      });
    } catch (e) {
      console.error("[RepairCard] 檢查共通設置連結失敗", e);
      if (mounted.current && myId === scanReq.current) setScan({ phase: "error" });
    }
  }, [port, accountsSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  // **掛載就掃**（RestoreCard 的 Codex finding 2）：斷鏈真正出現的時刻是設定被搬回現役
  // 目錄之後，不是展開備份包的那一刻——綁在展開後只會讓它幾乎永遠說「沒有斷鏈」。
  useEffect(() => {
    void scanLinks();
  }, [scanLinks]);

  // 呼叫端說「現役目錄可能被動過了」→ 清掉上一輪結果並重測。**結果與掃描一起清**：
  // 只重測不清結果的話，畫面會同時顯示新的現況與一份已經不屬於它的結果清單。
  //
  // **比對前一個值而不是只看有沒有給**（RestoreCard 的既有測試抓到）：這支 effect 在初次
  // 掛載也會跑一次，而那時上面那支已經掃過了——不比對就是每次掛載都多打一次端點。它的
  // deps 也含 `scanLinks`（port／帳號變就重建），那種重跑同樣不該當成「呼叫端要求重測」。
  const lastToken = useRef(rescanToken);
  useEffect(() => {
    if (rescanToken === undefined || rescanToken === lastToken.current) return;
    lastToken.current = rescanToken;
    setResults(null);
    setError(null);
    void scanLinks();
  }, [rescanToken, scanLinks]);

  const onRepair = useCallback(async () => {
    if (port == null) return;
    const scope = repairScope(Object.keys(accounts));
    if (scope === null) return;
    setRepairing(true);
    setError(null);
    const myCtx = ctx;
    try {
      const next = await commonConfigRepair(port, { ...scope, entries: RESTORE_REPAIR_ENTRIES });
      // 回應遲到而帳號／port 已經換過 → 這份結果描述的是**別組帳號**，不得寫進畫面
      if (!mounted.current || myCtx !== liveCtx.current) return;
      setResults(next);
      await scanLinks();   // 修完重測：畫面顯示的必須是修復後的現況，不是按下去前的
    } catch (e) {
      console.error("[RepairCard] 修復共通設置連結失敗", e);
      if (mounted.current && myCtx === liveCtx.current) setError(t("errors.repairFailed"));
    } finally {
      // 忙碌旗標一律解除（不看 ctx）：它是**這個元件實例**的按鈕狀態，不是那一輪的資料。
      // 綁 ctx 的話，換帳號後按鈕會永遠停在「重新指向中…」
      if (mounted.current) setRepairing(false);
    }
  }, [port, accountsSig, ctx, scanLinks, t]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {scan?.phase === "scanning" && <p className="rp-msg">{t("links.scanning")}</p>}
      {/* 「掃不出來」與「沒有斷鏈」是兩件事：說成後者會讓使用者以為不必修 */}
      {scan?.phase === "error" && <p className="rp-warn">{t("errors.scanFailed")}</p>}
      {scan?.phase === "not_applicable" && (
        <p className="rp-msg">{t("links.notApplicable")}</p>
      )}
      {scan?.phase === "done" && scan.broken === 0 && (
        <p className="rp-msg">{t("links.none")}</p>
      )}
      {scan?.phase === "done" && scan.broken > 0 && (
        <>
          <p className="rp-warn">{t("links.found", { count: scan.broken })}</p>
          <div className="rp-actions">
            <button
              type="button"
              className="settings-btn-ghost"
              onClick={() => void onRepair()}
              disabled={repairing}
            >
              {repairing ? t("links.repairing") : t("links.repair")}
            </button>
          </div>
        </>
      )}
      {error !== null && <p className="rp-warn">{error}</p>}
      {results !== null && (
        <div className="rp-results">
          {results
            // 一次修復會回每個 (帳號, 項目) 一筆，其中絕大多數是「沒事做」。
            // 全列會把版面撐長，也讓真正動到的那幾筆淹沒在裡面。
            .filter((r) => r.outcome !== "skipped")
            .map((r) => (
              <div key={`${r.account}/${r.entry}`} className="rp-result">
                <span className="rp-result-name">{r.account} / {r.entry}</span>
                {/* chip 與色調沿用共通設置卡的同一份表：同一個 outcome 在兩張卡是同一件事 */}
                <span className={`b4-chip ${OUTCOME_TONE[r.outcome]}`}>
                  {t(`repair.result.${r.outcome}`)}
                </span>
              </div>
            ))}
        </div>
      )}
    </>
  );
}

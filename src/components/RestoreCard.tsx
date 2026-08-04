import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBundleTime, formatSize } from "../lib/backupFormat";
import { destMessageKey, repairScope, restoreBlocking } from "../lib/restoreFormat";
import { pickDirectory } from "../lib/dialog";
import { useCardSession } from "../lib/useCardSession";
import { CardTerminal } from "./CardTerminal";
import { OUTCOME_TONE } from "./CommonConfigCard";
import {
  RESTORE_REPAIR_ENTRIES,
  commonConfigPlan,
  commonConfigRepair,
  fetchBackupStatus,
  fetchMigrationStatus,
  restorePlan,
  type BackupStatus,
  type MigrationState,
  type MigrationStatus,
  type CommonConfigOpResult,
  type RestorePlan,
} from "../lib/sidecar";
import "./RestoreCard.css";

/** 後端判別碼 → catalog key。**顯式表**：動態組 key 會讓沒見過的判別碼變成畫面上的
 *  i18n key 原文，未知碼一律退回通用訊息（CLAUDE.md §4.6.13）。
 *  展開位置與環境前提的說法，與 `restoreBlocking`／`destMessageKey` 用的是同一批文案
 *  ——使用者在按下去之前被擋、與按下去之後被擋，看到的說法必須一致。 */
const CODE_KEY: Record<string, string> = {
  backup_dir_not_set: "blocked.not_configured",
  backup_dir_invalid: "blocked.dir_unusable",
  backup_dir_unusable: "blocked.dir_unusable",
  restore_script_missing: "blocked.script_missing",
  python3_missing: "blocked.python3_missing",
  unknown_bundle: "errors.unknown_bundle",
  restore_bundle_required: "errors.restore_bundle_required",
  dest_invalid: "errors.dest_invalid",
  dest_is_root: "dest.is_root",
  dest_is_home: "dest.is_home",
  dest_inside_source: "dest.inside_source",
  dest_not_empty: "dest.not_empty",
  dest_not_dir: "dest.not_dir",
  dest_denied: "dest.denied",
};

/** 未完成的移機 → catalog key。**顯式表涵蓋整個 union**：後端加狀態時這裡會編譯失敗，
 *  而不是把 i18n key 原文印在畫面上。`none`／`stale_marker` 不在表內——那兩個**不顯示**
 *  （前者沒有未完成，後者是簿記殘骸、那一輪其實成功了，journal 是權威）。 */
const MIGRATION_MSG: Record<Exclude<MigrationState, "none" | "stale_marker">, string> = {
  unfinished_unknown: "migration.unknown",
  source_missing: "migration.sourceMissing",
  journal_unreadable: "migration.unreadable",
  resumable: "migration.resumable",
};

/** 續作要帶回精靈的兩樣東西（票 07）。**只是預填值不是授權**（增補 spec §3.4）：使用者
 *  仍要看預覽、按下安裝，而真正的驗證全在 `install.plan()`。 */
export interface MigrationResume {
  sourceRoot: string;
  mapping: { old: string; new: string }[];
}

/** 與 `CommonConfigCard`／`DevEnvSection`／`LoginCard` 同一份形狀。維持各卡自宣告的既有
 *  慣例（抽成共用型別要動三個已驗收的元件，與這張票的範圍不相稱），但欄位必須一致：
 *  `label` 在 `AppConfigData.accounts` 裡是必填，宣告成選填等於自己引入一個新慣例。 */
interface AccountInfo {
  config_dir: string;
  label: string;
}

type LinkScan =
  | { phase: "scanning" }
  | { phase: "done"; broken: number }
  | { phase: "not_applicable" }
  | { phase: "error" };

/** 設定頁的還原卡。
 *
 * 核心約束不是預設值而是結構：**這張卡沒有任何寫入現役目錄的路徑**。備份包展開到一個獨立
 * 位置、差異報告給使用者看，搬什麼回去由他自己決定（ADR-0004）。唯一會動現役目錄的是
 * 共通設置的斷鏈修復，那是展開完成後才出現、且要明確按下去的另一個動作。 */
export function RestoreCard({
  port,
  accounts,
  onResumeMigration,
}: {
  port: number | null;
  accounts: Record<string, AccountInfo>;
  /** 按下「繼續移機」時往上通知（modal 狀態在 App）。未提供＝不顯示按鈕。 */
  onResumeMigration?: (resume: MigrationResume) => void;
}) {
  const { t } = useTranslation("restore");
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  // 跑完之後終端機**刻意留在原地**（差異報告正是使用者要看的東西），所以不能用「還有沒有
  // session」判斷忙碌與否——那會讓按鈕在跑完後永遠鎖著。用 PTY EOF 當結束訊號。
  const [finished, setFinished] = useState(false);
  const [scan, setScan] = useState<LinkScan | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairResults, setRepairResults] = useState<CommonConfigOpResult[] | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  // 上一輪移機收尾了沒（票 07）。**判定全在後端**——牽涉 journal 定位、bundle 形狀驗證
  // 與損壞容錯；前端不碰檔案系統（增補 spec §3.3.2）
  const [migration, setMigration] = useState<MigrationStatus | null>(null);

  // latest-request-wins：sidecar 重啟換 port 會讓新舊請求重疊，晚到的舊回應若照樣寫進
  // state，畫面會退回上一輪的結果（比照 BackupCard／EnvCard 的 reqId）
  const statusReq = useRef(0);
  const planReq = useRef(0);
  const scanReq = useRef(0);
  const migrationReq = useRef(0);
  const mounted = useRef(true);

  const {
    running, starting, error: sessionError, setError: setSessionError, start,
  } = useCardSession<{ bundle: string }>(port);

  // effect dep 用簽章而非 accounts 物件：父層每次 render 都給新引用。只看 key——
  // 誰是 source 由 key 的順序決定，config_dir 的內容由後端自己讀。
  const accountsSig = JSON.stringify(Object.keys(accounts));

  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (port == null) return;
    const myId = ++statusReq.current;
    void (async () => {
      try {
        const next = await fetchBackupStatus(port);
        if (!mounted.current || myId !== statusReq.current) return;
        setStatus(next);
        // 預設選最新的那份；選中的那份消失了（被刪、被搬走）就退回最新的，不留一個
        // 指向不存在備份包的選擇——那會讓按下去才收到 unknown_bundle。
        setSelected((cur) =>
          cur !== null && next.bundles.some((b) => b.name === cur)
            ? cur
            : (next.bundles[0]?.name ?? null));
      } catch (e) {
        // 例外原文只進 console：判別碼與 `String(e)` 都不得出現在畫面上（CLAUDE.md §4.6.13）
        console.error("[RestoreCard] 讀取備份狀態失敗", e);
        if (mounted.current && myId === statusReq.current) setStatus(null);
      }
    })();
  }, [port]);

  // 上一輪移機的狀態（票 07）。與備份狀態分開抓：它與備份目錄設定無關（續作看的是**展開
  // 目錄**），所以 `blocked` 擋住整張卡的時候這一段照樣要顯示——沒設定備份位置的人也可能
  // 有一輪移機卡在半路。查詢失敗一律當作沒有：它是唯讀查詢，不該讓還原卡壞掉。
  useEffect(() => {
    if (port == null) return;
    const myId = ++migrationReq.current;
    void (async () => {
      try {
        const next = await fetchMigrationStatus(port);
        if (!mounted.current || myId !== migrationReq.current) return;
        setMigration(next);
      } catch (e) {
        console.error("[RestoreCard] 讀取移機狀態失敗", e);
        if (mounted.current && myId === migrationReq.current) setMigration(null);
      }
    })();
  }, [port]);

  /** 算「這份備份包會解到哪裡、那個位置能不能用」。`dest` 未給＝用後端算的預設位置。 */
  const loadPlan = useCallback(
    async (bundle: string, dest?: string) => {
      if (port == null) return;
      const myId = ++planReq.current;
      setPlanError(null);
      try {
        const next = await restorePlan(port, bundle, dest);
        if (mounted.current && myId === planReq.current) setPlan(next);
      } catch (e) {
        console.error("[RestoreCard] 取得還原預覽失敗", e);
        if (!mounted.current || myId !== planReq.current) return;
        setPlan(null);
        const code = (e as { code?: string | null }).code ?? null;
        const key = code !== null ? CODE_KEY[code] : undefined;
        setPlanError(t(key ?? "errors.planFailed"));
      }
    },
    [port, t],
  );

  useEffect(() => {
    // 換備份包＝換預設展開位置（目錄名帶備份包時間戳），所以一律重算，不沿用上一份的位置
    if (selected !== null) void loadPlan(selected);
  }, [selected, loadPlan]);

  const scanLinks = useCallback(async () => {
    if (port == null) return;
    const scope = repairScope(Object.keys(accounts));
    if (scope === null) {
      setScan({ phase: "not_applicable" });
      return;
    }
    const myId = ++scanReq.current;
    setScan({ phase: "scanning" });
    try {
      // 偵測用既有的 common-config/plan：它已經回逐項 state，不需要另做一個端點
      const result = await commonConfigPlan(port, { ...scope, entries: RESTORE_REPAIR_ENTRIES });
      if (!mounted.current || myId !== scanReq.current) return;
      setScan({
        phase: "done",
        broken: result.operations.filter((o) => o.state === "broken_link").length,
      });
    } catch (e) {
      console.error("[RestoreCard] 檢查共通設置連結失敗", e);
      if (mounted.current && myId === scanReq.current) setScan({ phase: "error" });
    }
  }, [port, accountsSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  // **掛載就掃，不是等展開完成**（Codex 對抗式審查 finding 2）：還原只把備份包解到獨立的
  // DEST，展開這個動作本身不可能讓現役目錄冒出斷鏈——斷鏈真正出現的時刻是使用者把設定
  // 手動搬回現役目錄之後，而那一刻通常不在這張卡裡。綁在展開後只會讓它幾乎永遠說「沒有
  // 斷鏈」。順帶化解另一件事：它不再依賴「這次展開成功了嗎」，而 PTY EOF 本來就不帶結束碼。
  useEffect(() => {
    void scanLinks();
  }, [scanLinks]);

  const onSessionEnded = useCallback(() => {
    setFinished(true);
    void scanLinks();   // 跑完重測一次：使用者可能在展開途中動過現役目錄
  }, [scanLinks]);

  const onChooseDest = useCallback(async () => {
    if (selected === null) return;
    const picked = await pickDirectory();
    if (!picked) return;   // 使用者取消 → 什麼都不做
    setSessionError(null);
    await loadPlan(selected, picked);
  }, [selected, loadPlan, setSessionError]);

  const onRun = useCallback(async () => {
    // 同一條不變式在 handler 裡再驗一次：按鈕的 disabled 擋不住程式化呼叫，而這裡送錯
    // 的後果是內容被解進錯誤命名的目錄（使用者事後分不出那是哪一份備份）。
    if (selected === null || plan === null || plan.bundle !== selected) return;
    setFinished(false);
    setRepairResults(null);
    setRepairError(null);
    // 前端只送備份包**名字**與展開位置，永不送命令字串（沿用 kind=install 的 allowlist
    // 不變式）。path 傳空字串是因為還原不屬於任何專案，後端固定跑在 home。
    await start({
      cardId: "restore",
      options: { path: "", kind: "restore", restoreBundle: selected, restoreDest: plan.dest },
      meta: { bundle: selected },
      mapError: (code) => (code !== null && CODE_KEY[code] ? t(CODE_KEY[code]) : null),
      fallbackError: () => t("errors.runFailed"),
    });
  }, [selected, plan, start, t]);

  const onRepair = useCallback(async () => {
    if (port == null) return;
    const scope = repairScope(Object.keys(accounts));
    if (scope === null) return;
    setRepairing(true);
    setRepairError(null);
    try {
      const results = await commonConfigRepair(port, { ...scope, entries: RESTORE_REPAIR_ENTRIES });
      if (!mounted.current) return;
      setRepairResults(results);
      await scanLinks();   // 修完重測：畫面顯示的必須是修復後的現況，不是按下去前的
    } catch (e) {
      console.error("[RestoreCard] 修復共通設置連結失敗", e);
      if (mounted.current) setRepairError(t("errors.repairFailed"));
    } finally {
      if (mounted.current) setRepairing(false);
    }
  }, [port, accountsSig, scanLinks, t]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 續作資訊只在 `resumable` 出現，而且**後端說 resumable 卻沒給 source_root 就不給按鈕**：
  // 預填值缺一半的續作會把使用者丟進一個填不滿的表單，不如讓他走「重新展開」那條路。
  const resumeInfo: MigrationResume | null =
    migration?.state === "resumable" && typeof migration.source_root === "string"
      ? { sourceRoot: migration.source_root, mapping: migration.mapping ?? [] }
      : null;
  // 未完成的移機（票 07）。`none`／`stale_marker` 整段不出現——後者是簿記殘骸，journal
  // 已被清除＝那一輪其實成功了（journal 是權威）。
  const migrationBanner =
    migration === null || migration.state === "none" || migration.state === "stale_marker"
      ? null
      : (
        <div className="rs-migration">
          <p className="rs-migration-h">{t("migration.h")}</p>
          <p className="rs-migration-msg">{t(MIGRATION_MSG[migration.state])}</p>
          {resumeInfo !== null && onResumeMigration !== undefined && (
            <button
              onClick={() => onResumeMigration(resumeInfo)}
              className="settings-btn-primary rs-migration-btn"
            >{t("migration.resume")}</button>
          )}
        </div>
      );

  // 讀不到備份狀態時整張卡不出現：這裡沒有使用者能採取的行動，留一個空殼只是噪音。
  // **但續作提示要留著**（票 07）：它與備份位置設定無關（續作看的是展開目錄），而移機
  // 卡在半路的人正好可能有一份讀不出來的 config——那時整張卡消失就等於續作入口也消失。
  if (status === null) {
    return migrationBanner === null ? null
      : <div className="b4-card rs-card">{migrationBanner}</div>;
  }

  const blocked = restoreBlocking(status);
  const busy = starting || (running !== null && !finished);
  // **plan 必須綁在它是為哪一份備份包算出來的**：換備份包後新預覽回來之前，舊 plan 還在
  // state 裡，`canRun` 會維持啟用而 `onRun` 會把**新** bundle 配上**舊** dest 送出去——
  // 後端分別驗 bundle 與 dest 都合法，於是新的備份包被解進一個以另一份時間戳命名的目錄。
  const ready = plan !== null && plan.bundle === selected ? plan : null;
  const destProblem = ready !== null ? destMessageKey(ready.dest_status) : null;
  const canRun = !busy && selected !== null && ready !== null && ready.dest_status === "ok";

  return (
    <div className="b4-card rs-card">
      <div className="b4-card-top">
        <div>
          <p className="b4-card-title">{t("title")}</p>
          <p className="b4-card-desc">{t("intro")}</p>
        </div>
      </div>

      {/* 未完成的移機：**排在 `blocked` 之前且不受它影響**——續作看的是展開目錄 */}
      {migrationBanner}

      {blocked !== null ? (
        <p className="rs-blocked-msg">{t(`blocked.${blocked}`)}</p>
      ) : (
        <>
          <div className="rs-bundles">
            <div className="rs-label">{t("chooseBundle")}</div>
            {status.bundles.map((b) => (
              <label key={b.name} className="rs-bundle">
                <input
                  type="radio"
                  name="rs-bundle"
                  checked={selected === b.name}
                  disabled={busy}
                  onChange={() => setSelected(b.name)}
                />
                <span className="rs-bundle-time">{formatBundleTime(b.created_ts)}</span>
                <span className="rs-bundle-size">{formatSize(b.size_bytes)}</span>
              </label>
            ))}
          </div>

          <div className="rs-row">
            <span className="rs-label">{t("destLabel")}</span>
            <code className="b4-mono rs-path">{ready?.dest ?? "…"}</code>
            {/* 執行中不得改位置：session 建立時後端已把當時的位置固定進 argv */}
            <button
              type="button"
              className="settings-btn-ghost"
              onClick={() => void onChooseDest()}
              disabled={busy || selected === null}
            >
              {t("change")}
            </button>
          </div>
          {destProblem !== null && <p className="rs-warn">{t(destProblem)}</p>}

          <div className="rs-actions">
            <button
              type="button"
              className="settings-btn-primary"
              onClick={() => void onRun()}
              disabled={!canRun}
            >
              {t("run")}
            </button>
          </div>
          {/* 設定頁是條件掛載的 modal，關掉它會卸載本元件 →`useCardSession` 的 cleanup 收 PTY
              ＝還原被靜默中斷。比照備份卡：明講會中斷，而不是假裝它會在背景跑完。 */}
          {busy && <p className="b4-hint rs-hint">{t("leaveHint")}</p>}
          {finished && <p className="b4-hint rs-hint">{t("afterHint")}</p>}
        </>
      )}

      {(planError ?? sessionError ?? repairError) && (
        <p className="rs-error">{planError ?? sessionError ?? repairError}</p>
      )}

      {running !== null && port != null && (
        <CardTerminal
          port={port}
          sessionId={running.sessionId}
          tabId={running.tabId}
          title={t("run")}
          onEnded={onSessionEnded}
        />
      )}

      {/* 斷鏈修復：展開完成後才出現，且**不自動執行**——它會改寫 symlink，是破壞性操作 */}
      {scan !== null && (
        <div className="rs-links">
          <div className="rs-label">{t("links.title")}</div>
          {scan.phase === "scanning" && <p className="rs-links-msg">{t("links.scanning")}</p>}
          {scan.phase === "error" && <p className="rs-warn">{t("errors.scanFailed")}</p>}
          {scan.phase === "not_applicable" && (
            <p className="rs-links-msg">{t("links.notApplicable")}</p>
          )}
          {scan.phase === "done" && scan.broken === 0 && (
            <p className="rs-links-msg">{t("links.none")}</p>
          )}
          {scan.phase === "done" && scan.broken > 0 && (
            <>
              <p className="rs-warn">{t("links.found", { count: scan.broken })}</p>
              <button
                type="button"
                className="settings-btn-ghost"
                onClick={() => void onRepair()}
                disabled={repairing}
              >
                {repairing ? t("links.repairing") : t("links.repair")}
              </button>
            </>
          )}
          {repairResults !== null && (
            <div className="rs-results">
              {repairResults
                // 一次修復會回每個 (帳號, 項目) 一筆，其中絕大多數是「沒事做」。
                // 全列會把卡片撐長，也讓真正動到的那幾筆淹沒在裡面。
                .filter((r) => r.outcome !== "skipped")
                .map((r) => (
                  <div key={`${r.account}/${r.entry}`} className="rs-result">
                    <span className="rs-result-name">{r.account} / {r.entry}</span>
                    {/* chip 與色調沿用共通設置卡的同一份表：同一個 outcome 在兩張卡是同一件事 */}
                    <span className={`b4-chip ${OUTCOME_TONE[r.outcome]}`}>
                      {t(`repair.result.${r.outcome}`)}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

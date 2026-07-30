import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  blockingReason,
  formatBundleTime,
  formatSize,
  freshnessLevel,
} from "../lib/backupFormat";
import { pickDirectory } from "../lib/dialog";
import { useCardSession } from "../lib/useCardSession";
import { CardTerminal } from "./CardTerminal";
import {
  fetchBackupStatus,
  putBackupDir,
  type BackupBundle,
  type BackupStatus,
} from "../lib/sidecar";
import "./BackupCard.css";

// 清單預設只列最近幾份：多數時候使用者只想確認「最新那份在不在」，全列會把卡片撐長
const PREVIEW_COUNT = 5;

/** `PUT /api/config/backup-dir` 的判別碼 → catalog key。與 `blockingReason` 的表是同一組
 *  文案：使用者在選擇當下被擋、與事後從 status 看到的，說法必須一致。 */
const CODE_KEY: Record<string, string> = {
  backup_dir_invalid: "blocked.invalid",
  backup_dir_inside_source: "blocked.inside_source",
  backup_dir_is_home: "blocked.is_home",
  backup_dir_is_root: "blocked.is_root",
  backup_dir_not_set: "blocked.not_configured",
  backup_dir_unusable: "blocked.dir_missing",
  backup_script_missing: "blocked.script_missing",
  python3_missing: "blocked.python3_missing",
};

/** 設定頁的備份卡。
 *
 * 這張卡存在的理由是「不必記得去終端機跑腳本」——備份腳本 7/27 交付後兩天一次都沒被跑過，
 * 機制存在卻不在日常迴圈裡等於沒有保護。它刻意只是**常駐可見指標**：不自動備份、不排程、
 * 不提醒、主畫面不加任何元素（設計決策，見 spec §3）。
 *
 * 卡片本身是一條**有序的決策鏈**：旗標可能同時成立，取第一個成立的阻斷原因、只顯示它，
 * 順序與後端 spawn 前擋下的順序一致——使用者看到的修復指引，就是後端下一個會擋的東西。 */
export function BackupCard({ port }: { port: number | null }) {
  const { t } = useTranslation("backup");
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 跑完之後終端機**刻意留在原地**（輸出要看得到，比照 EnvCard），所以不能用「還有沒有
  // session」判斷忙碌與否——那會讓按鈕在跑完後永遠鎖著。用 PTY EOF 當結束訊號。
  const [finished, setFinished] = useState(false);
  // latest-request-wins：sidecar 重啟換 port 會讓新舊請求重疊，晚到的舊回應若照樣寫進
  // state，畫面會退回上一輪的結果（比照 EnvCard 的 reqId）
  const reqId = useRef(0);
  const mounted = useRef(true);
  // 卡內終端機的生命週期走共用 hook（與 EnvCard／LoginCard 同一套）：一次只跑一個、
  // 切換時先關完舊的才建新的、卸載一律收 PTY。
  const {
    running,
    starting,
    error: sessionError,
    setError: setSessionError,
    start,
  } = useCardSession<{ mode: "list" | "run" }>(port);

  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (port == null) return;
    const myId = ++reqId.current;
    try {
      const next = await fetchBackupStatus(port);
      if (mounted.current && myId === reqId.current) setStatus(next);
    } catch (e) {
      // 例外原文只進 console：判別碼與 `String(e)` 都不得出現在畫面上（CLAUDE.md §4.6.13）
      console.error("[BackupCard] 讀取備份狀態失敗", e);
      if (mounted.current && myId === reqId.current) setStatus(null);
    }
  }, [port]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onChoose = useCallback(async () => {
    if (port == null) return;
    const picked = await pickDirectory();
    if (!picked) return;   // 使用者取消 → 什麼都不做
    setSaveError(null);
    setSessionError(null);
    try {
      await putBackupDir(port, picked);
      await refresh();
    } catch (e) {
      console.error("[BackupCard] 儲存備份位置失敗", e);
      const code = (e as { code?: string | null }).code ?? null;
      // 後端判別碼 → i18n key。**顯式表**：動態組 key 會讓沒見過的判別碼變成畫面上的
      // i18n key 原文，未知碼一律退回通用訊息（CLAUDE.md §4.6.13）。
      const key = code !== null ? CODE_KEY[code] : undefined;
      setSaveError(t(key ?? "errors.saveFailed"));
    }
  }, [port, refresh, setSessionError, t]);

  const startRun = useCallback(
    async (mode: "list" | "run") => {
      setSaveError(null);
      setFinished(false);
      // 前端只送 kind 與 backup_mode——永不送命令字串也不送路徑（沿用 kind=install 的
      // allowlist 不變式）。path 傳空字串是因為備份不屬於任何專案，後端固定跑在 home。
      const created = await start({
        cardId: "backup",
        options: { path: "", kind: "backup", backupMode: mode },
        meta: { mode },
        mapError: (code) => (code !== null ? (CODE_KEY[code] ? t(CODE_KEY[code]) : null) : null),
        fallbackError: () => t("errors.runFailed"),
      });
      // 跑完（session 收掉）要回讀，否則天數與清單停在舊值。這裡只在真的建立了才等。
      if (!created) await refresh();
    },
    [start, t, refresh],
  );

  const onSessionEnded = useCallback(() => {
    setFinished(true);
    void refresh();   // 天數歸零、剛產生的備份包出現在清單
  }, [refresh]);

  // 讀不到狀態時整張卡不出現：這裡沒有使用者能採取的行動，留一個空殼只是噪音
  if (status === null) return null;

  const blocked = blockingReason(status);
  // 「有 session 掛著」不等於「還在跑」：跑完的終端機仍留著給人看輸出
  const busy = starting || (running !== null && !finished);

  return (
    <div className="b4-card bk-card">
      <div className="b4-card-top">
        <div>
          <p className="b4-card-title">{t("title")}</p>
          <p className="b4-card-desc">{t("intro")}</p>
        </div>
      </div>

      {blocked !== null ? (
        <div className="bk-blocked">
          <p className="bk-blocked-msg">{t(`blocked.${blocked}`)}</p>
          {/* 已設定但位置有問題時，路徑要看得到——使用者得知道是哪個位置壞了 */}
          {status.configured && <code className="b4-mono bk-path">{status.backup_dir}</code>}
          <button type="button" className="settings-btn-ghost" onClick={onChoose} disabled={busy}>
            {t("chooseLocation")}
          </button>
        </div>
      ) : (
        <>
          <p className={`bk-days bk-days--${freshnessLevel(status.days_since)}`}>
            {status.days_since === null
              ? t("neverBackedUp")
              : status.days_since === 0
                ? t("today")
                : t("daysAgo", { count: status.days_since })}
          </p>
          {/* 正交的修飾，不是狀態：它不停用任何東西——使用者要做的正是再按一次備份 */}
          {status.last_attempt_failed && (
            <p className="bk-warn">{t("lastAttemptFailed")}</p>
          )}
          <div className="bk-row">
            <span className="bk-row-label">{t("location")}</span>
            <code className="b4-mono bk-path">{status.backup_dir}</code>
            {/* 執行中不得改位置：session 建立時後端已把當時的 backup_dir 固定進 argv，
                備份寫的是舊位置，但跑完的回讀掃的是新位置——終端機顯示成功、卡片卻找不到
                那份備份包，使用者會以為失敗了。 */}
            <button type="button" className="settings-btn-ghost" onClick={onChoose} disabled={busy}>
              {t("change")}
            </button>
          </div>
          <div className="bk-actions">
            <button
              type="button"
              className="settings-btn-ghost"
              onClick={() => void startRun("list")}
              disabled={busy}
            >
              {t("preview")}
            </button>
            <button
              type="button"
              className="settings-btn-primary"
              onClick={() => void startRun("run")}
              disabled={busy}
            >
              {t("runNow")}
            </button>
          </div>
          {/* 設定頁是條件掛載的 modal，關掉它會卸載本元件 → `useCardSession` 的 cleanup
              呼叫 closeSession → 後端 close(force=True) 終止子程序，備份就這樣被靜默取消。
              把 job 生命週期搬出元件是另一個量級的工程（要有 job registry 與重新連線），
              與這張卡的範圍不相稱；改用這個 codebase 對同一情境既有的做法：明講會中斷
              （比照 EnvCard 的 installHint、LoginCard 的 leaveHint）。 */}
          {busy && <p className="b4-hint bk-hint">{t("leaveHint")}</p>}
          <BundleList bundles={status.bundles} />
        </>
      )}

      {(saveError ?? sessionError) && (
        <p className="bk-error">{saveError ?? sessionError}</p>
      )}

      {/* 標頭只放模式的 i18n 文案，**不放實際命令字串**——命令由後端組，前端連顯示
          都不該自己拼一份出來（那會讓畫面與實際執行的東西有兩個來源）。 */}
      {running !== null && port != null && (
        <CardTerminal
          port={port}
          sessionId={running.sessionId}
          tabId={running.tabId}
          title={t(running.meta.mode === "list" ? "preview" : "runNow")}
          onEnded={onSessionEnded}
        />
      )}
    </div>
  );
}

/** 既有備份包清單。這份清單之後由還原精靈複用（選哪個備份包還原就從這裡選），
 *  所以它是共用的資料來源而不是卡片專屬的呈現。 */
function BundleList({ bundles }: { bundles: BackupBundle[] }) {
  const { t } = useTranslation("backup");
  const [showAll, setShowAll] = useState(false);

  if (bundles.length === 0) return null;
  const shown = showAll ? bundles : bundles.slice(0, PREVIEW_COUNT);

  return (
    <div className="bk-bundles">
      <div className="bk-bundles-title">{t("bundles")}</div>
      {shown.map((b) => (
        <div key={b.name} className="bk-bundle">
          <span className="bk-bundle-time">{formatBundleTime(b.created_ts)}</span>
          <span className="bk-bundle-size">{formatSize(b.size_bytes)}</span>
        </div>
      ))}
      {!showAll && bundles.length > PREVIEW_COUNT && (
        <button type="button" className="st-link" onClick={() => setShowAll(true)}>
          {t("showAll", { count: bundles.length })}
        </button>
      )}
    </div>
  );
}

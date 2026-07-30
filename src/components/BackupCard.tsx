import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { blockingReason } from "../lib/backupFormat";
import { pickDirectory } from "../lib/dialog";
import { fetchBackupStatus, putBackupDir, type BackupStatus } from "../lib/sidecar";
import "./BackupCard.css";

/** `PUT /api/config/backup-dir` 的判別碼 → catalog key。與 `blockingReason` 的表是同一組
 *  文案：使用者在選擇當下被擋、與事後從 status 看到的，說法必須一致。 */
const SAVE_ERROR_KEY: Record<string, string> = {
  backup_dir_invalid: "blocked.invalid",
  backup_dir_inside_source: "blocked.inside_source",
  backup_dir_is_home: "blocked.is_home",
  backup_dir_is_root: "blocked.is_root",
};

/** 設定頁的備份卡。
 *
 * 這張卡存在的理由是「不必記得去終端機跑腳本」——備份腳本 7/27 交付後兩天一次都沒被跑過，
 * 機制存在卻不在日常迴圈裡等於沒有保護。它刻意只是**常駐可見指標**：不自動備份、不排程、
 * 不提醒、主畫面不加任何元素（設計決策，見 spec §3）。
 *
 * 本票（02）只做「選位置與看狀態」，不執行備份。 */
export function BackupCard({ port }: { port: number | null }) {
  const { t } = useTranslation("backup");
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // latest-request-wins：sidecar 重啟換 port 會讓新舊請求重疊，晚到的舊回應若照樣寫進
  // state，畫面會退回上一輪的結果（比照 EnvCard 的 reqId）
  const reqId = useRef(0);
  const mounted = useRef(true);

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
    try {
      await putBackupDir(port, picked);
      await refresh();
    } catch (e) {
      console.error("[BackupCard] 儲存備份位置失敗", e);
      const code = (e as { code?: string | null }).code ?? null;
      // 後端判別碼 → i18n key。**顯式表**：動態組 key 會讓沒見過的判別碼變成畫面上的
      // i18n key 原文，未知碼一律退回通用訊息（CLAUDE.md §4.6.13）。
      const key = code !== null ? SAVE_ERROR_KEY[code] : undefined;
      setSaveError(t(key ?? "errors.saveFailed"));
    }
  }, [port, refresh, t]);

  // 讀不到狀態時整張卡不出現：這裡沒有使用者能採取的行動，留一個空殼只是噪音
  if (status === null) return null;

  const blocked = blockingReason(status);

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
          <button type="button" className="settings-btn-ghost" onClick={onChoose}>
            {t("chooseLocation")}
          </button>
        </div>
      ) : (
        <div className="bk-row">
          <span className="bk-row-label">{t("location")}</span>
          <code className="b4-mono bk-path">{status.backup_dir}</code>
          <button type="button" className="settings-btn-ghost" onClick={onChoose}>
            {t("change")}
          </button>
        </div>
      )}

      {saveError && <p className="bk-error">{saveError}</p>}
    </div>
  );
}

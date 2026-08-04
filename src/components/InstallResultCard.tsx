import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { InstallItemResult } from "../lib/sidecar";
import { InstallSection } from "./InstallSection";

/** 後端判別碼 → catalog key。**顯式表**（比照 `TargetsCard`／`TemplateCard`）：動態組
 *  `mig.result.reason.${code}` 會讓後端新增的碼變成畫面上的 i18n key 原文，未知碼一律退
 *  通用文案、原碼只留在後端 log（CLAUDE.md §4.6.13）。
 *
 *  兩組來源：`safe_fs.error_code()` 的 errno 對照，與 `install()` 自己的語意判別碼。 */
const REASON_KEY: Record<string, string> = {
  permission_denied: "mig.result.reason.permission_denied",
  read_only_filesystem: "mig.result.reason.read_only_filesystem",
  path_missing: "mig.result.reason.path_missing",
  target_exists: "mig.result.reason.target_exists",
  target_not_empty: "mig.result.reason.target_not_empty",
  no_space: "mig.result.reason.no_space",
  cross_device: "mig.result.reason.cross_device",
  too_many_symlinks: "mig.result.reason.too_many_symlinks",
  not_a_directory: "mig.result.reason.not_a_directory",
  operation_not_supported: "mig.result.reason.operation_not_supported",
  io_failed: "mig.result.reason.io_failed",
  source_moved: "mig.result.reason.source_moved",
  target_moved: "mig.result.reason.target_moved",
  overlapping_config_dirs: "mig.result.reason.overlapping_config_dirs",
  provenance_unavailable: "mig.result.reason.provenance_unavailable",
  account_not_installed: "mig.result.reason.account_not_installed",
  node_identity_mismatch: "mig.result.reason.node_identity_mismatch",
  not_migrated_by_design: "mig.result.reason.not_migrated_by_design",
  not_a_regular_file: "mig.result.reason.not_a_regular_file",
  symlink_target_unauthorized: "mig.result.reason.symlink_target_unauthorized",
};

/** 摘要語氣 → catalog key。**不能無條件說「內容已經寫進這台機器」**（Codex 票 06 R2 F1）：
 *  逐項與落點層的失敗都是 HTTP 200 的 results，所有落點都 `target_moved`／`permission_denied`
 *  時一項都沒成功，畫面卻照樣宣告搬完了——那是 R1 修掉的「斷言我們不知道的事」在成功路徑上
 *  的同一個形狀。
 *
 *  **`allSkipped` 要與 `ok` 分開**（R2 修法的自查殘留）：「東西在那裡」與「這一輪寫進去了」
 *  是兩件事。全部 skipped 代表每個目的地都已經有同名項、我們一個位元組都沒寫——可能是上一輪
 *  裝好的（R1 那條重送路徑），也可能是使用者自己本來就有的。把它併進 `ok` 就是拿「不覆蓋」
 *  的結果去宣稱「搬過來了」。 */
const SUB_KEY = {
  ok: "mig.result.sub.ok",
  partial: "mig.result.sub.partial",
  allSkipped: "mig.result.sub.allSkipped",
  none: "mig.result.sub.none",
} as const;

interface InstallResultCardProps {
  results: InstallItemResult[];
  /** 前一輪硬中斷留下的暫存殘骸，**後端給的絕對路徑**（增補 spec §4.2）。 */
  staleTemps: string[];
  /** 重送同一個安裝請求（票 16 第 4 項）。**只在有 failed 時才會被用到**。 */
  onRetry?: () => void;
}

/**
 * 移機精靈的安裝結果頁（票 06）：不可逆的那一步做完之後，逐項報告發生了什麼。
 *
 * 兩件刻意為之的事：
 * - **「已裝好」比預覽多是正常的**（增補 spec §2.5.2）：帳號目錄裡的連結不在預覽的任何
 *   數字裡，第二階段成功建立就會出現在結果裡。文案要講明，否則使用者會以為出錯
 * - **暫存殘骸只告知、不代勞刪除**（§4.2）：能拿來授權刪除的只有檔名前綴、檔名裡的
 *   進程編號已不存在、型別是一般檔——三個都是可偽造的檔名特徵，達不到專案「只刪自己
 *   建的」這條底線。所以給位置＋Finder 入口，讓看得到完整路徑的人自己決定。
 *   **刻意不解釋「為什麼 app 不代勞」**：那對使用者是雜訊，而且會讓人懷疑那到底是不是
 *   我們的東西
 */
export function InstallResultCard({ results, staleTemps, onRetry }: InstallResultCardProps) {
  const { t } = useTranslation("onboarding");

  /** 一項的顯示文字。`rel_path` 為空＝落點層的失敗（整個帳號沒裝成），只顯示落點 key。 */
  const itemText = (r: InstallItemResult) => {
    const path = r.rel_path ? `${r.account}/${r.rel_path}` : r.account;
    if (!r.error) return t("mig.result.item", { path });
    const reason = t(REASON_KEY[r.error] ?? "mig.result.reason.unknown");
    return t("mig.result.itemReason", { path, reason });
  };
  const group = (outcome: InstallItemResult["outcome"]) =>
    results.filter((r) => r.outcome === outcome).map(itemText);
  const installed = group("installed");
  const skipped = group("skipped");
  const failed = group("failed");
  // **不擋下一步**（Codex 票 06 R2 F1 留給我們決定的那一半）：失敗未必排除得掉（唯讀磁碟、
  // 落點被占住），擋住等於把使用者鎖在精靈裡，而後面的環境／登入／修復頁與安裝成敗無關且
  // 有價值。改為讓失敗在摘要與預設展開的明細裡顯眼——與 Plan A「逐項盡力、不阻斷」一致。
  const tone =
    installed.length === 0 && skipped.length === 0 ? "none"
    : failed.length > 0 ? "partial"
    : installed.length === 0 ? "allSkipped"
    : "ok";

  return (
    <div>
      <h2 className="ob-h">{t("mig.result.h")}</h2>
      <p className="ob-sub">{t(SUB_KEY[tone])}</p>

      <InstallSection title={t("mig.result.installed")} items={installed}
                      note={t("mig.result.moreNote")} />
      <InstallSection title={t("mig.result.skipped")} items={skipped} />
      <InstallSection title={t("mig.result.excluded")} items={group("excluded")} />
      {/* 唯一需要使用者行動的分類 → 預設展開，且每一項都要看得出原因 */}
      <InstallSection title={t("mig.result.failed")} items={failed} defaultOpen />

      {/* 有失敗才給重試（票 16 第 4 項）：精靈**刻意不給中途關閉**，沒有這顆按鈕，安裝
          失敗的人唯一的出路是走完環境／登入／修復三頁再繞回設定頁的還原卡——那三頁對他
          毫無意義。它就是把同一個請求再送一次（marker 與 journal 都還在，no-clobber 保證
          安全），不是第二份續作實作。**沒有失敗時不給**——那會變成鼓勵重複執行不可逆操作。 */}
      {failed.length > 0 && onRetry !== undefined && (
        <button onClick={onRetry} className="ob-btn">{t("mig.result.retry")}</button>
      )}

      {staleTemps.length > 0 && (
        <div className="ob-spot">
          <div className="ob-spot-head">
            <span className="ob-spot-kind">
              {t("mig.result.stale.h", { count: staleTemps.length })}
            </span>
          </div>
          <p className="ob-note">{t("mig.result.stale.note")}</p>
          {staleTemps.map((p) => (
            <div key={p} className="ob-row">
              <span className="ob-row-path">{p}</span>
              {/* reveal 失敗（Tauri 外殼不在、路徑剛好被刪掉）不該炸掉結果頁——
                  它是附帶動作，安裝結果本身已經呈現完畢 */}
              <button
                onClick={() => { revealItemInDir(p).catch(() => {}); }}
                className="ob-btn-ghost"
              >{t("mig.result.stale.reveal")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

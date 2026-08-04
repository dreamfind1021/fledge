import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { installPlan, type BundleInfo, type InstallPreview } from "../lib/sidecar";
import type { PathsStatus } from "./PathsCard";
import type { ProjectMapping } from "./PathsCard";

interface InstallPreviewCardProps {
  port: number | null;
  dest: string;
  /** 上一頁確認過的這一包有哪些成員。用來比對「哪些帳號沒被搬」——後端的預覽
   *  **完全不會提到**未指定落點的帳號（增補 spec §2.5.2）。 */
  info: BundleInfo;
  /** 來源身分（`BundleSelection.gen`）：換包／換位置／重新展開都要重算，在途的作廢。 */
  sourceGen: number;
  mapping: ProjectMapping;
  onStatus: (status: PathsStatus) => void;
}

/** 一列分類：標題 ＋ 數量 ＋ 可展開的明細。
 *
 *  **需要使用者行動的分類預設展開**（`blocked`、未確認落點的 extra、漏選落點的帳號）：
 *  那些正是他要補救的東西，收起來等於換一種方式漏報。純資訊的分類（跳過、刻意不處理、
 *  會改寫的專案）預設收合，免得整頁被淹沒。 */
function Section({ title, items, note, defaultOpen = false }: {
  title: string; items: string[]; note?: string; defaultOpen?: boolean;
}) {
  const { t } = useTranslation("onboarding");
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  return (
    <div className="ob-spot">
      <div className="ob-spot-head">
        <span className="ob-spot-kind">{title}</span>
        <span className="ob-spot-key">{items.length}</span>
        <button onClick={() => setOpen((v) => !v)} className="ob-btn-ghost">
          {open ? t("mig.install.hide") : t("mig.install.detail")}
        </button>
      </div>
      {open && items.map((i) => <p key={i} className="ob-spot-oldpath">{i}</p>)}
      {note !== undefined && <p className="ob-note">{note}</p>}
    </div>
  );
}

/**
 * 移機精靈的安裝預覽頁：按下安裝**之前**的最後一道人工確認。這一頁不寫任何東西。
 *
 * **重點是不要無聲漏報**（增補 spec 缺口 4）。後端的 `InstallPlan` 有五類，而上游 spec 只
 * 寫了四類——被漏掉的 `blocked`（目的地那個位置已被一般檔或連結占住，該子樹的檔案到不了）
 * 若不獨立顯示，預覽總數會無聲縮水，使用者確認的是一份「看起來完整、實際已知缺件」的移機。
 *
 * 另外兩件同族的事：
 * - `excluded` 是**混合粒度**（增補 spec §2.5.1）：`.claude.json` 這種逐檔的，與未確認落點的
 *   extra name（底下可能是一大包東西卻只佔一格）。只顯示一個數字會誤導，要拆成兩行
 * - **未指定落點的帳號完全不在預覽裡**（§2.5.2）：只有前端拿這一包的帳號清單與 `plan.targets`
 *   取差集，才擋得住「以為都搬了、其實少一個帳號」
 */
export function InstallPreviewCard({
  port, dest, info, sourceGen, mapping, onStatus,
}: InstallPreviewCardProps) {
  const { t } = useTranslation("onboarding");
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);
  const sourceKey = `${port}|${dest}|${sourceGen}`;
  const liveSource = useRef(sourceKey);
  liveSource.current = sourceKey;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // 對應關係會變（使用者從 paths 頁回來改），但它不該重抓——重抓的觸發點是**來源**。
  // 進到這一頁時讀當下的值即可。
  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;

  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (port == null) {
      onStatusRef.current("loading");     // 沉默會讓精靈停在上一次的 loaded（票 04 R2）
      return;
    }
    const mySource = sourceKey;
    setPreview(null);
    setLoadError(null);
    onStatusRef.current("loading");
    void (async () => {
      try {
        const next = await installPlan(port, dest, mappingRef.current);
        if (!mounted.current || liveSource.current !== mySource) return;
        setPreview(next);
        onStatusRef.current("loaded");
      } catch (e) {
        // 例外原文只進 console：判別碼與 `String(e)` 都不得出現在畫面上（CLAUDE.md §4.6.13）
        console.error("[InstallPreviewCard] 取得安裝預覽失敗", e);
        if (!mounted.current || liveSource.current !== mySource) return;
        setLoadError(t("mig.install.errors.loadFailed"));
        onStatusRef.current("error");
      }
    })();
  }, [port, dest, sourceKey, t]);

  // `excluded` 的兩種粒度：包裡有、但沒給落點的 extra 是「整項不搬」，其餘是逐檔的
  const unconfirmedExtra = preview === null ? []
    : info.extra.filter((n) => !(n in preview.extra_targets));
  const excludedFiles = preview === null ? []
    : preview.excluded.filter((e) => !unconfirmedExtra.includes(e));
  // 後端的預覽**完全不會提到**未指定落點的帳號——差集是前端的責任
  const missingAccounts = preview === null ? []
    : info.accounts.filter((k) => !(k in preview.targets));

  const nothing = preview !== null
    && preview.will_install === 0 && preview.will_skip.length === 0
    && preview.blocked.length === 0 && preview.excluded.length === 0
    && Object.keys(preview.project_renames).length === 0
    && preview.unmapped_projects.length === 0;

  return (
    <div>
      <h2 className="ob-h">{t("mig.install.h")}</h2>
      <p className="ob-sub">{t("mig.install.sub")}</p>

      {nothing && <p className="ob-note">{t("mig.install.none")}</p>}

      {preview !== null && !nothing && (
        <>
          <div className="ob-spot">
            <div className="ob-spot-head">
              <span className="ob-spot-kind">{t("mig.install.willInstall")}</span>
              {/* **不能說成「總共會搬 N 項」**：連結不在任何預覽數字裡，結果可能比預覽多
                  （增補 spec §2.5.2）。說死了會讓使用者以為出錯 */}
              <span className="ob-spot-key">
                {t("mig.install.atLeast", { count: preview.will_install })}
              </span>
            </div>
            <p className="ob-note">{t("mig.install.atLeastNote")}</p>
          </div>

          <Section title={t("mig.install.willSkip")} items={preview.will_skip} />
          {/* 補救路徑一：去那個位置把占住的東西挪開 */}
          <Section title={t("mig.install.blocked")} items={preview.blocked}
                   note={t("mig.install.blockedNote")}
                   defaultOpen />
          <Section title={t("mig.install.excludedFiles")} items={excludedFiles} />
          {/* 補救路徑二：回上一步給 extra 一個位置 */}
          <Section title={t("mig.install.excludedExtra")} items={unconfirmedExtra}
                   note={t("mig.install.excludedExtraNote")}
                   defaultOpen />
          <Section title={t("mig.install.renames")}
                   items={Object.keys(preview.project_renames)} />
          <Section title={t("mig.install.unmapped")}
                   items={preview.unmapped_projects.map((u) => u.cwd)} />
          {/* 補救路徑三：回上一步給帳號一個位置。三種分開講，不混成一句 */}
          <Section title={t("mig.install.missingAccounts")} items={missingAccounts}
                   note={t("mig.install.missingAccountsNote")}
                   defaultOpen />
        </>
      )}

      {loadError !== null && <p className="ob-error">{loadError}</p>}
    </div>
  );
}

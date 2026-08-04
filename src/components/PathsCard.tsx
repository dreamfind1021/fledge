import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchProjectPaths, type ProjectPath } from "../lib/sidecar";
import { pickDirectory } from "../lib/dialog";

/** 舊絕對路徑 → 使用者確認的新絕對路徑。**只放有填的**——留空代表照搬不改寫。 */
export type ProjectMapping = Record<string, string>;

interface PathsCardProps {
  port: number | null;
  dest: string;
  /** 這一包裡有幾個專案資料夾（`BundleInfo.project_count`）。與本頁列出的筆數比對用。 */
  projectCount: number;
  mapping: ProjectMapping;
  onMapping: (mapping: ProjectMapping) => void;
}

/**
 * 移機精靈的專案路徑對應頁：列出備份包裡每個專案的舊路徑，讓使用者填新路徑。
 *
 * **這一頁不寫任何東西**——改寫在 install 時才發生（`plan(..., mapping=)`），所以按下安裝
 * 之前隨時能回來改。對應關係住在精靈而不是這裡，離開再回來才會還在。
 *
 * `/resume` 定位只靠 `projects/<encoded>` 的目錄名，而目錄名是絕對路徑的有損投影（票 01
 * 實測）：路徑一變就對不上。**留空＝照搬不改寫**，歷史照樣搬過去、只是 `/resume` 列不出來
 * ——這一點必須明講，不然使用者會以為那些對話不見了。
 */
export function PathsCard({ port, dest, projectCount, mapping, onMapping }: PathsCardProps) {
  const { t } = useTranslation("onboarding");
  const [projects, setProjects] = useState<ProjectPath[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);
  // 初次載入時把建議值填進尚未有對應的項目。**已填的不覆蓋**——使用者從下一頁回來時，
  // 他改過的值必須留著（`mapping` 是精靈持有的真相）。
  const seeded = useRef(false);

  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (port == null) return;
    void (async () => {
      try {
        const next = await fetchProjectPaths(port, dest);
        if (!mounted.current) return;
        setProjects(next);
        if (seeded.current) return;
        seeded.current = true;
        const seed: ProjectMapping = { ...mapping };
        for (const p of next) {
          if (p.suggested !== "" && seed[p.old_path] === undefined) seed[p.old_path] = p.suggested;
        }
        onMapping(seed);
      } catch (e) {
        // 例外原文只進 console：判別碼與 `String(e)` 都不得出現在畫面上（CLAUDE.md §4.6.13）
        console.error("[PathsCard] 讀取專案清單失敗", e);
        if (mounted.current) setLoadError(t("mig.paths.errors.loadFailed"));
      }
    })();
    // 只在掛載／換包時重抓；`mapping` 的變動不該觸發重抓（會把使用者正在打的字洗掉）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, dest, t]);

  const setOne = useCallback((oldPath: string, value: string) => {
    const next = { ...mapping };
    if (value.trim() === "") delete next[oldPath];
    else next[oldPath] = value;
    onMapping(next);
  }, [mapping, onMapping]);

  const browse = useCallback(async (oldPath: string) => {
    const dir = await pickDirectory();
    if (dir !== null) setOne(oldPath, dir);
  }, [setOne]);

  const skipped = (projects ?? []).filter((p) => (mapping[p.old_path] ?? "").trim() === "");

  return (
    <div>
      <h2 className="ob-h">{t("mig.paths.h")}</h2>
      <p className="ob-sub">{t("mig.paths.sub")}</p>

      {projects !== null && projects.length === 0 && (
        <p className="ob-note">{t("mig.paths.none")}</p>
      )}

      {projects !== null && projects.length > 0 && (
        <>
          {/* 兩個數字不同是預期的（增補 spec §2）：`project_count` 只數目錄，這裡跳過
              讀不出 cwd 的專案。不講清楚使用者會以為少的那個是 bug */}
          <p className="ob-note">
            {t("mig.paths.count", { total: projectCount, listed: projects.length })}
          </p>
          {projectCount !== projects.length && (
            <p className="ob-note">{t("mig.paths.countNote")}</p>
          )}
        </>
      )}

      {(projects ?? []).map((p) => (
        <div key={p.encoded_dir} className="ob-spot">
          <div className="ob-spot-head">
            <span className="ob-spot-kind">{p.account}</span>
            <span className="ob-spot-old">
              {t("mig.paths.old")}
              <span className="ob-spot-oldpath">{p.old_path}</span>
            </span>
          </div>
          <div className="ob-row">
            <input
              value={mapping[p.old_path] ?? ""}
              onChange={(e) => setOne(p.old_path, e.target.value)}
              placeholder={t("mig.paths.placeholder")}
              className="ob-input"
            />
            <button onClick={() => browse(p.old_path)} className="ob-btn-ghost">
              {t("mig.paths.browse")}
            </button>
            {/* 存在性只在後端算得出建議值時探測過 */}
            {p.suggested !== "" && (
              <span className="ob-spot-state">
                {p.suggested_exists ? t("mig.paths.exists") : t("mig.paths.missing")}
              </span>
            )}
          </div>
        </div>
      ))}

      {projects !== null && projects.length > 0 && (
        <p className="ob-note">{t("mig.paths.missingNote")}</p>
      )}
      {skipped.length > 0 && (
        <p className="ob-warn">
          {t("mig.paths.skipNote", { names: skipped.map((p) => p.old_path).join("、") })}
        </p>
      )}
      {loadError !== null && <p className="ob-error">{loadError}</p>}
      {projects !== null && projects.length > 0 && (
        <p className="ob-note">{t("mig.paths.note")}</p>
      )}
    </div>
  );
}

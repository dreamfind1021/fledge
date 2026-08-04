import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchProjectPaths, type ProjectPath } from "../lib/sidecar";
import { pickDirectory } from "../lib/dialog";

/** 舊絕對路徑 → 使用者確認的新絕對路徑。**只放有填的**——留空代表照搬不改寫。
 *
 *  key 是**舊絕對路徑**而不是專案目錄，與後端 `_validate_mapping` 的契約一致（它以歷史檔
 *  的 `cwd` 逐字驗身）。同一條舊路徑若出現在多個帳號，改寫**會同時套用到它們**。 */
export type ProjectMapping = Record<string, string>;

/** 專案清單的載入狀態。精靈據此決定放不放行——讀取失敗還放行的話，使用者會在看不到任何
 *  專案、也沒有任何對應的情況下繼續，install 就把所有歷史原樣搬過去、`/resume` 全部列不
 *  出來，而那**不是**他選的「留空即照搬」（Codex 票 04 R1 F3）。 */
export type PathsStatus = "loading" | "error" | "loaded";

/** 同一條舊路徑在多個帳號裡都有時合併成一列——mapping 以舊路徑為 key，兩列本來就會連動，
 *  畫成兩個看似獨立的輸入框是騙人的（Codex 票 04 R1 F4）。 */
interface MergedProject {
  old_path: string;
  accounts: string[];
  encoded_dirs: string[];
  suggested: string;
  suggested_exists: boolean;
}

function mergeByOldPath(projects: ProjectPath[]): MergedProject[] {
  const byPath = new Map<string, MergedProject>();
  for (const p of projects) {
    const hit = byPath.get(p.old_path);
    if (hit === undefined) {
      byPath.set(p.old_path, {
        old_path: p.old_path,
        accounts: [p.account],
        encoded_dirs: [p.encoded_dir],
        suggested: p.suggested,
        suggested_exists: p.suggested_exists,
      });
      continue;
    }
    if (!hit.accounts.includes(p.account)) hit.accounts.push(p.account);
    if (!hit.encoded_dirs.includes(p.encoded_dir)) hit.encoded_dirs.push(p.encoded_dir);
    // 建議值由同一條舊路徑推出，理論上相同；真不同就取第一個有值的，不猜
    if (hit.suggested === "" && p.suggested !== "") {
      hit.suggested = p.suggested;
      hit.suggested_exists = p.suggested_exists;
    }
  }
  for (const m of byPath.values()) m.accounts.sort();
  return [...byPath.values()];
}

interface PathsCardProps {
  port: number | null;
  dest: string;
  /** 這一包裡有幾個專案資料夾（`BundleInfo.project_count`）。與本頁列出的筆數比對用。 */
  projectCount: number;
  /** 來源身分（`BundleSelection.gen`）。換包、換展開位置、重新展開都會變——**建議值要
   *  重新填、在途的回應要作廢**，否則新包會看到舊包的清單（Codex 票 04 R1 F2）。 */
  sourceGen: number;
  mapping: ProjectMapping;
  onMapping: (mapping: ProjectMapping) => void;
  onStatus: (status: PathsStatus) => void;
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
export function PathsCard({
  port, dest, projectCount, sourceGen, mapping, onMapping, onStatus,
}: PathsCardProps) {
  const { t } = useTranslation("onboarding");
  const [projects, setProjects] = useState<MergedProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);
  // 每一次「來源」的身分。`port` 與 `dest` 之外還要 `sourceGen`：同一個 dest 重新展開過
  // 之後內容可能完全不同。回應落地前核對它，慢回應才不會蓋掉新的結果。
  const sourceKey = `${port}|${dest}|${sourceGen}`;
  const liveSource = useRef(sourceKey);
  liveSource.current = sourceKey;
  // 建議值只填一次，但**每換一個來源就要重新填**（原本是元件生命週期的全域布林，
  // 換包之後新來源的建議值永遠填不進去）
  const seededFor = useRef<string | null>(null);
  // 呼叫端每次 render 都給新的 inline closure，effect 不能依賴它們
  const onMappingRef = useRef(onMapping);
  onMappingRef.current = onMapping;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
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
      // sidecar 還沒起來／掛掉：**明確回報「還沒讀到」**（Codex 票 04 R2）。沉默的話
      // 精靈那側的狀態會停在上一次的 `loaded`，於是在根本讀不到清單的狀態下放行。
      onStatusRef.current("loading");
      return;
    }
    const mySource = sourceKey;
    setProjects(null);        // 換來源先清空：舊清單不得停在畫面上冒充新的一包
    setLoadError(null);
    onStatusRef.current("loading");
    void (async () => {
      try {
        const next = await fetchProjectPaths(port, dest);
        if (!mounted.current || liveSource.current !== mySource) return;
        setProjects(mergeByOldPath(next));
        if (seededFor.current !== mySource) {
          seededFor.current = mySource;
          // 已填的不覆蓋——使用者從下一頁回來時，他改過的值必須留著
          const seed: ProjectMapping = { ...mappingRef.current };
          for (const p of next) {
            if (p.suggested !== "" && seed[p.old_path] === undefined) {
              seed[p.old_path] = p.suggested;
            }
          }
          onMappingRef.current(seed);
        }
        onStatusRef.current("loaded");
      } catch (e) {
        // 例外原文只進 console：判別碼與 `String(e)` 都不得出現在畫面上（CLAUDE.md §4.6.13）
        console.error("[PathsCard] 讀取專案清單失敗", e);
        if (!mounted.current || liveSource.current !== mySource) return;
        setLoadError(t("mig.paths.errors.loadFailed"));
        onStatusRef.current("error");
      }
    })();
  }, [port, dest, sourceKey, t]);

  const setOne = useCallback((oldPath: string, value: string) => {
    const next = { ...mappingRef.current };
    // 清空要**移除**那一筆而不是留空字串：空字串到後端是 `mapping_not_absolute`，
    // 而使用者的意思是「這個專案照搬」
    if (value.trim() === "") delete next[oldPath];
    else next[oldPath] = value;
    onMappingRef.current(next);
  }, []);

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
              讀不出 cwd 的專案，而且同一條舊路徑跨帳號時只算一列。不講清楚使用者會
              以為少的那些是 bug */}
          <p className="ob-note">
            {t("mig.paths.count", { total: projectCount, listed: projects.length })}
          </p>
          {projectCount !== projects.length && (
            <p className="ob-note">{t("mig.paths.countNote")}</p>
          )}
        </>
      )}

      {(projects ?? []).map((p) => (
        <div key={p.old_path} className="ob-spot">
          <div className="ob-spot-head">
            <span className="ob-spot-kind">{p.accounts.join(", ")}</span>
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
          {p.accounts.length > 1 && <p className="ob-note">{t("mig.paths.shared")}</p>}
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

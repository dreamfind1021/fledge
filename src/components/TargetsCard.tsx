import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchLandingSuggestions,
  adoptConfig,
  type BundleInfo,
  type LandingSpot,
} from "../lib/sidecar";
import { pickDirectory } from "../lib/dialog";

/** 後端判別碼 → catalog key。**顯式表**（比照 `RestoreCard`／`BundleCard`）：動態組 key 會讓
 *  沒見過的判別碼變成畫面上的 i18n key 原文，未知碼一律退回通用訊息（CLAUDE.md §4.6.13）。
 *  文案取自 `restore` namespace——同一批判別碼在還原流程的其他入口也會出現。 */
const CODE_KEY: Record<string, string> = {
  source_not_a_bundle: "restore:errors.source_not_a_bundle",
  invalid_config_dir: "restore:errors.invalid_config_dir",
  unsafe_config_dir: "restore:errors.unsafe_config_dir",
  invalid_account_key: "restore:errors.invalid_account_key",
  overlapping_config_dirs: "restore:errors.overlapping_config_dirs",
  duplicate_account_key: "restore:errors.duplicate_account_key",
  duplicate_extra_name: "restore:errors.duplicate_extra_name",
  unknown_account_key: "restore:errors.unknown_account_key",
  unknown_extra_name: "restore:errors.unknown_extra_name",
  config_already_initialized: "restore:errors.config_already_initialized",
};

/** 落點的穩定識別。**帳號與 extra 是兩個命名空間**——後端一直用 `extra:<name>` 區分
 *  （`validate_landing_spots`），兩邊都可能出現同一個名字（帳號 key 與 basename 衍生的
 *  extra name 判準不同但都合法）。用裸 key 當 state 索引會讓同名的兩項共用一格。 */
const spotId = (s: LandingSpot) => `${s.kind}:${s.key}`;

interface TargetsCardProps {
  port: number | null;
  dest: string;
  /** 上一頁確認過的這一包有哪些成員。用來與建議值的成員對帳（增補 spec §2.8.4）。 */
  info: BundleInfo;
  saved: boolean;
  /** 落檔成功後的收尾。**允許非同步且允許失敗**——父層要先把新 config 讀回 store 才算
   *  完成（後面的頁面讀的是 store 的 accounts），失敗就不該轉唯讀、也不該放行下一步。 */
  onSaved: () => void | Promise<void>;
}

/**
 * 移機精靈的落點頁：逐項確認每個帳號、每個 extra 要放到這台機器的哪裡，確認後才落檔。
 *
 * **使用者確認過的落點才是授權**（spec §4.2.2）——manifest 只產生建議值，這一頁送回
 * `adopt-config` 的那一份才算數，server 全部重驗。建議值推不出來時欄位留空**不猜**
 * （決策 9）：ADR-0001 允許 config_dir 是任意路徑，沒有正確答案可推。
 *
 * **留空＝這一項不搬**。這是合法選擇（spec §4.2.2：未確認落點的 extra 整項跳過），但
 * 後端的預覽**完全不會提到**被略過的帳號（增補 spec §2.5.1），所以這一頁必須自己把
 * 「哪幾項不會被搬」講出來，否則使用者會以為都搬了。
 */
export function TargetsCard({ port, dest, info, saved, onSaved }: TargetsCardProps) {
  const { t } = useTranslation(["onboarding", "restore"]);
  const [spots, setSpots] = useState<LandingSpot[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

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
        const next = await fetchLandingSuggestions(port, dest);
        if (!mounted.current) return;
        // 成員對帳（增補 spec §2.8.4）：三支端點各自讀 manifest，成員清單對不上就代表
        // staging 在頁面之間被換過——使用者在上一頁確認的不是這一份，擋住並要求回去重看
        // 比的是 **(kind, key)** 而不是裸 key（Codex 票 03 R1 F1）：只比 key 的話，
        // 一份把 account 與 extra 對調的 staging 會通過對帳——集合一模一樣，授權的成員
        // 卻換了身分。用集合而不是 join 字串則是因為 extra 的 name 是 basename 衍生的
        // （票 13），可以含任何非 `/` 字元，任何分隔符都可能造成假的相等。
        const seen = new Set([
          ...info.accounts.map((k) => `account:${k}`),
          ...info.extra.map((k) => `extra:${k}`),
        ]);
        const same = next.spots.length === seen.size
          && next.spots.every((s) => seen.has(spotId(s)));
        if (!same) {
          setStale(true);
          return;
        }
        setSpots(next.spots);
        setValues(Object.fromEntries(next.spots.map((s) => [spotId(s), s.suggested])));
      } catch (e) {
        // 例外原文只進 console：判別碼與 `String(e)` 都不得出現在畫面上（CLAUDE.md §4.6.13）
        console.error("[TargetsCard] 讀取落點建議值失敗", e);
        if (mounted.current) setLoadError(t("mig.targets.errors.loadFailed"));
      }
    })();
  }, [port, dest, info, t]);

  const browse = useCallback(async (id: string) => {
    const dir = await pickDirectory();
    if (dir !== null) setValues((v) => ({ ...v, [id]: dir }));
  }, []);

  const filled = (s: LandingSpot) => (values[spotId(s)] ?? "").trim();
  const skipped = (spots ?? []).filter((s) => !filled(s));

  const save = useCallback(async () => {
    if (port == null || spots === null) return;
    const accounts = spots
      .filter((s) => s.kind === "account" && filled(s))
      .map((s) => ({ key: s.key, config_dir: filled(s) }));
    // 後端的 accounts 是 min_length=1：先在這裡擋，才不會用一個必然 422 的請求換一段
    // 使用者看不懂的訊息
    if (accounts.length === 0) {
      setSaveError(t("mig.targets.needOne"));
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      await adoptConfig(port, {
        dest,
        accounts,
        extra: spots
          .filter((s) => s.kind === "extra" && filled(s))
          .map((s) => ({ name: s.key, path: filled(s) })),
      });
      // 收尾（父層刷新 store）也在 try 內：它失敗就等於這一步沒完成，不該轉唯讀
      await onSaved();
    } catch (e) {
      console.error("[TargetsCard] 建立設定檔失敗", e);
      if (!mounted.current) return;
      const code = (e as { code?: string | null }).code ?? null;
      setSaveError((code !== null && CODE_KEY[code] ? t(CODE_KEY[code]) : null)
        ?? t("mig.targets.errors.saveFailed"));
    } finally {
      if (mounted.current) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, dest, spots, values, onSaved, t]);

  if (stale) {
    return (
      <div>
        <h2 className="ob-h">{t("mig.targets.h")}</h2>
        <p className="ob-error">{t("mig.targets.stale")}</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="ob-h">{t("mig.targets.h")}</h2>
      <p className="ob-sub">{t("mig.targets.sub")}</p>

      {(spots ?? []).map((s) => (
        <div key={spotId(s)} className="ob-spot">
          <div className="ob-spot-head">
            <span className="ob-spot-kind">{t(`mig.targets.kind.${s.kind}`)}</span>
            <span className="ob-spot-key">{s.key}</span>
            <span className="ob-spot-old">
              {t("mig.targets.old")}
              <span className="ob-spot-oldpath">{s.old_path}</span>
            </span>
          </div>
          <div className="ob-row">
            <input
              value={values[spotId(s)] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [spotId(s)]: e.target.value }))}
              placeholder={t("mig.targets.placeholder")}
              disabled={saved || busy}
              className="ob-input"
            />
            <button onClick={() => browse(spotId(s))} disabled={saved || busy}
                    className="ob-btn-ghost">
              {t("mig.targets.browse")}
            </button>
            {/* 存在性只在有建議值時探測過（後端對推不出來的項目不做 stat） */}
            {s.suggested !== "" && (
              <span className="ob-spot-state">
                {s.suggested_exists ? t("mig.targets.exists") : t("mig.targets.missing")}
              </span>
            )}
          </div>
          {s.suggested === "" && <p className="ob-note">{t("mig.targets.noSuggestion")}</p>}
        </div>
      ))}

      {spots !== null && <p className="ob-note">{t("mig.targets.missingNote")}</p>}
      {skipped.length > 0 && (
        <p className="ob-warn">
          {t("mig.targets.skipNote", { names: skipped.map((s) => s.key).join("、") })}
        </p>
      )}
      {(loadError ?? saveError) && <p className="ob-error">{loadError ?? saveError}</p>}
      {saved
        ? <p className="ob-note">{t("mig.targets.created")}</p>
        : spots !== null && (
          <button onClick={save} disabled={busy} className="ob-btn">
            {busy ? t("mig.targets.saving") : t("mig.targets.save")}
          </button>
        )}
    </div>
  );
}

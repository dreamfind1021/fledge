import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchLandingSuggestions,
  adoptConfig,
  type AdoptConfigBody,
  type BundleInfo,
  type ConfigCreatedBy,
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
  // 父層對帳失敗（既有 config 的落點與本次確認的不符）——不是後端判別碼，
  // 但走同一條映射，前端錯誤與後端錯誤在使用者眼裡沒有分別
  config_mismatch: "restore:errors.config_mismatch",
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
  /** 這一次確認的識別碼（票 15）。**同一個值代表同一次確認**——後端據此在重送時回既有
   *  結果（200）而不是 409，所以這張卡不必再記「上一次到底寫進去了沒」。由父層持有並綁
   *  在來源身分上：換一包就換一個，那才分得出「A 建的 config」與「B 這次要建的」。 */
  requestId: string;
  /** 落檔成功後的收尾。**允許非同步且允許失敗**——父層要先把新 config 讀回 store 才算
   *  完成（後面的頁面讀的是 store 的 accounts），失敗就不該轉唯讀、也不該放行下一步。
   *
   *  帶上**本次確認的落點**讓父層對帳：`config_already_initialized` 只證明「有一份
   *  config」，不證明它是這次建立的、更不證明它含這些落點，而後續的 install 會直接從
   *  那份 config 取目的地（Codex 票 03 R4 F1）。
   *
   *  `reused`＝這一輪是沿用既有設定檔（409），**沒有**建立新的。父層據此決定能不能說
   *  「這些設定是從備份包帶回來的」——沿用時 config 裡的東西是使用者原本就有的，說成
   *  帶回來的就是宣稱了沒發生過的事（Codex 票 09 R1 F2）。 */
  onSaved: (confirmed: AdoptConfigBody, reused: boolean) => void | Promise<void>;
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
export function TargetsCard({ port, dest, info, saved, requestId, onSaved }: TargetsCardProps) {
  const { t } = useTranslation(["onboarding", "restore"]);
  const [spots, setSpots] = useState<LandingSpot[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // 409 的說明是**中性 notice** 而不是錯誤：收尾成功後它還會留著，配著成功狀態顯示
  // 「請移除既有設定檔」那種指示會讓使用者做危險的事（Codex 票 03 R4 F2）
  const [reused, setReused] = useState(false);
  // 這台機器上已經有一份設定檔，而且**不是這一次確認建的**（票 15）：後端回 409 時附上
  // 它的來源摘要。**不自動放行也不自動擋**——把事實講出來由使用者決定：沿用既有的、
  // 或停下來去確認。`null`＝沒有衝突。
  //
  // 票 15 之前這裡是一個 `adopted` 旗標，用來記「後端已經落檔了嗎」，於是重試時不再
  // POST。那個旗標只活在元件 state、卸載就沒了（票 03 R3），而 R2–R4 連續三輪的 finding
  // 全是它造成的。**後端冪等之後不需要推測**：同一個 `requestId` 重送回既有結果。
  const [conflict, setConflict] = useState<ConfigCreatedBy | null>(null);
  // 上一次失敗在哪一段。**主按鈕的文案需要這個**——「建立設定檔」與「重新讀取」是兩件
  // 不同的事，落檔那一步還沒成功過時說「重新讀取」是錯的。票 15 之前這個判斷搭在
  // `adopted` 上（它同時兼「要不要再 POST」的推測），拔掉推測之後這一半仍然要留。
  const [lastFailure, setLastFailure] = useState<"adopt" | "reload" | null>(null);
  // 使用者**已經決定沿用**既有的設定（票 15 R1 F2）。這是他的決策，不是對後端狀態的推測
  // ——記住它是合法的。不記的話，沿用之後若收尾失敗，重試會重新 POST、拿到同一個 409、
  // 又要他再選一次；暫時性的讀取失敗就變成重複確認的迴圈。按「停下來」會撤回它。
  const [reuseAgreed, setReuseAgreed] = useState(false);
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
    if (dir === null) return;
    setValues((v) => ({ ...v, [id]: dir }));
    setReuseAgreed(false);      // 同上：換了落點就是新的一次確認
  }, []);

  const filled = (s: LandingSpot) => (values[spotId(s)] ?? "").trim();
  const skipped = (spots ?? []).filter((s) => !filled(s));

  /** 收尾：把新設定讀回 store。`reusedFlag`＝沿用既有的、不是這一次建的。 */
  const finish = useCallback(async (confirmed: AdoptConfigBody, reusedFlag: boolean) => {
    setBusy(true);
    try {
      await onSaved(confirmed, reusedFlag);
      if (mounted.current) setLastFailure(null);
    } catch (e) {
      console.error("[TargetsCard] 讀回新設定失敗", e);
      if (!mounted.current) return;
      // 這一步失敗**不是**「建立失敗」——設定檔已經在了，說錯會讓使用者去做危險的事
      // （刪掉剛建立的設定檔重來）。父層的對帳不符則有自己的說法：那是真的衝突，
      // 不是暫時讀不到（Codex 票 03 R4 F1）。
      const code = (e as { code?: string | null }).code ?? null;
      setSaveError(code !== null && CODE_KEY[code]
        ? t(CODE_KEY[code]) : t("mig.targets.errors.reloadFailed"));
      setLastFailure("reload");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [onSaved, t]);

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
    setConflict(null);
    // **落檔與收尾不是同一個原子操作**（Codex 票 03 R2 F1），兩段各自 catch，訊息才說得
    // 準是哪一步失敗。但**重試時兩段都重跑**——後端冪等了（票 15），再 POST 一次回的是
    // 既有結果，不會建立第二份、也不會覆寫。
    const confirmed: AdoptConfigBody = {
      dest,
      request_id: requestId,
      accounts,
      extra: spots
        .filter((s) => s.kind === "extra" && filled(s))
        .map((s) => ({ name: s.key, path: filled(s) })),
    };
    if (reuseAgreed) {
      // 已經同意沿用：那一份 config 不是這次建的，再 POST 一次只會拿到同一個 409
      await finish(confirmed, true);
      return;
    }
    try {
      await adoptConfig(port, confirmed);
      if (!mounted.current) return;
    } catch (e) {
      console.error("[TargetsCard] 建立設定檔失敗", e);
      if (!mounted.current) return;
      const err = e as { code?: string | null; createdBy?: ConfigCreatedBy | null };
      const code = err.code ?? null;
      if (code !== "config_already_initialized") {
        setSaveError((code !== null && CODE_KEY[code] ? t(CODE_KEY[code]) : null)
          ?? t("mig.targets.errors.saveFailed"));
        setLastFailure("adopt");
        setBusy(false);
        return;
      }
      // 409 現在只有一種意思：**已經有一份設定檔，而且不是這一次確認建的**（票 15——
      // 同一次的重送後端會回 200）。它可能是重跑引導時本來就在的，也可能是另一輪確認
      // 剛建的（票 09 R3：A 包的請求在飛時使用者換到 B 包）。前端分不出，**也不該替
      // 使用者決定**——把來源講出來，停在這裡等他選。
      setConflict(err.createdBy ?? {});
      setBusy(false);
      return;
    }
    await finish(confirmed, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, dest, spots, values, requestId, reuseAgreed, finish, t]);


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
              onChange={(e) => {
                setValues((v) => ({ ...v, [spotId(s)]: e.target.value }));
                // 改了落點＝這是**新的一次確認**，先前「沿用既有設定」的決定不再適用
                // （票 15 R1 F2）：不撤回的話會拿新落點配舊 config 直接走收尾。
                setReuseAgreed(false);
              }}
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
      {/* 已經有一份設定檔、而且不是這一次確認建的（票 15）。**把事實講出來，不替使用者
          決定**——沿用的話後面幾步會用那份設定的落點，那可能不是這一包的。 */}
      {conflict !== null && (
        <div className="ob-spot">
          <p className="ob-warn">{t("mig.targets.conflict.h")}</p>
          {conflict.source === "onboard" ? (
            <p className="ob-note">{t("mig.targets.conflict.fromOnboard")}</p>
          ) : conflict.dest ? (
            <dl className="ob-sum">
              <dt>{t("mig.targets.conflict.fromDest")}</dt>
              <dd>{conflict.dest}</dd>
              <dt>{t("mig.targets.conflict.thisDest")}</dt>
              <dd>{dest}</dd>
            </dl>
          ) : (
            <p className="ob-note">{t("mig.targets.conflict.unknown")}</p>
          )}
          <p className="ob-note">{t("mig.targets.conflict.note")}</p>
          <div className="ob-actions">
            <button
              onClick={() => {
                setConflict(null);
                setReuseAgreed(true);
                setReused(true);   // 沿用＝不是這一次建的；父層據此不報「帶回了什麼」
                void finish({
                  dest,
                  request_id: requestId,
                  accounts: spots!.filter((s) => s.kind === "account" && filled(s))
                    .map((s) => ({ key: s.key, config_dir: filled(s) })),
                  extra: spots!.filter((s) => s.kind === "extra" && filled(s))
                    .map((s) => ({ name: s.key, path: filled(s) })),
                }, true);
              }}
              disabled={busy}
              className="ob-btn"
            >{t("mig.targets.conflict.reuse")}</button>
            {/* 「停下來」**撤回**沿用的決策：下一次確認要重新問（不偷偷留著） */}
            <button onClick={() => { setConflict(null); setReuseAgreed(false); }}
                    disabled={busy}
                    className="ob-btn-ghost">{t("mig.targets.conflict.stop")}</button>
          </div>
        </div>
      )}
      {reused && <p className="ob-note">{t("mig.targets.reused")}</p>}
      {(loadError ?? saveError) && <p className="ob-error">{loadError ?? saveError}</p>}
      {saved
        ? <p className="ob-note">{t("mig.targets.created")}</p>
        : spots !== null && (
          <button onClick={save} disabled={busy} className="ob-btn">
            {busy ? t("mig.targets.saving")
              : lastFailure === "reload" ? t("mig.targets.retry")
                : t("mig.targets.save")}
          </button>
        )}
    </div>
  );
}

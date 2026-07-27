import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store/useAppStore";
import { putKmsRoot, type SubscriptionItem } from "../lib/sidecar";
import { pickDirectory } from "../lib/dialog";
import { validateSubscriptions, dropBlankRows, sameSubscriptions } from "../lib/subscriptionsForm";

interface SystemSettingsCardProps {
  port: number | null;
  subscriptions: SubscriptionItem[];
  kmsRoot: string;
  onPrev: () => void;
  onNext: () => void;
}

// 表單列的費用維持字串（input 的原始值，含使用者打到一半的狀態）；轉數字與驗證交給
// lib/subscriptionsForm，那份規則與後端 PUT 的 400 判準是同一套。
interface SubsRow {
  name: string;
  monthly_cost: string;
}

/** 精靈的系統設置頁：訂閱服務清單與知識庫根目錄，兩區都可以整段略過（票 28 再把範本卡接在後面）。
 *
 * **這兩區刻意沒有各自的儲存鈕**（視覺權威 `docs/design/b4-onboarding-wizard.html`）：頁尾只有
 * 「全部略過」與「下一步」。因此「下一步」＝送出使用者真的改過的區塊、「全部略過」＝什麼都不送。
 * 沒改就不送——用一次可能失敗的請求換零變更，只會擋住想直接往下走的人。 */
export function SystemSettingsCard({ port, subscriptions, kmsRoot, onPrev, onNext }: SystemSettingsCardProps) {
  const { t } = useTranslation("onboarding");
  const saveSubscriptions = useAppStore((s) => s.saveSubscriptions);
  const loadConfig = useAppStore((s) => s.loadConfig);

  // 初值取自 config：首次啟動兩者皆空，重跑引導時帶著既有值進來。之後 props 再變也不覆寫
  // 編輯中的內容（精靈走到這頁時 config 早已落檔，不會有「載入後才補值」的空窗）。
  const [rows, setRows] = useState<SubsRow[]>(() =>
    subscriptions.map((s) => ({ name: s.name, monthly_cost: String(s.monthly_cost) })),
  );
  const [kms, setKms] = useState(kmsRoot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patchRow = (i: number, patch: Partial<SubsRow>) => {
    setError(null); // 錯誤是上一次送出的回饋，一動表單就該收掉
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const removeRow = (i: number) => {
    setError(null);
    setRows((rs) => rs.filter((_, j) => j !== i));
  };

  const browse = async () => {
    const p = await pickDirectory();
    if (p) {
      setError(null);
      setKms(p);
    }
  };

  const saveAndNext = async () => {
    setError(null);
    const validated = validateSubscriptions(dropBlankRows(rows));
    if (!validated.ok) {
      setError(t(validated.error === "name" ? "errors.subs_name" : "errors.subs_cost"));
      return;
    }
    const kmsValue = kms.trim();
    const subsChanged = !sameSubscriptions(validated.value, subscriptions);
    const kmsChanged = kmsValue !== kmsRoot.trim();
    if (!subsChanged && !kmsChanged) {
      onNext(); // 兩區都沒填（或沒改）＝整段略過
      return;
    }
    if (port == null) {
      // 後端不在時默默前進，使用者剛填的東西會憑空消失
      setError(t("errors.backend_unavailable"));
      return;
    }
    setBusy(true);
    let stage: "subs" | "kms" = "subs"; // 失敗訊息要指向真的出錯的那一區
    try {
      if (subsChanged) await saveSubscriptions(validated.value);
      stage = "kms";
      if (kmsChanged) {
        await putKmsRoot(port, kmsValue);
        // 回讀讓 store 的 config.kms_root 與記憶面板同步（比照 Settings）；
        // 回讀失敗不代表沒存進去，不能因此說儲存失敗
        await loadConfig().catch((e) => console.warn("[onboarding] config 回讀失敗", e));
      }
      onNext();
    } catch (e) {
      setError(t(stage === "subs" ? "errors.subs_failed" : "errors.kms_failed", { reason: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="ob-h">{t("sys.h")}</h2>
      <p className="ob-sub">{t("sys.sub")}</p>

      {error && <div className="ob-error" role="alert">{error}</div>}

      {/* ── 訂閱服務及費用 ── */}
      <div className="b4-sec">
        <p className="b4-sec-h">{t("sys.subsTitle")}</p>
        <div className="b4-card">
          <p className="b4-card-desc b4-card-desc-lead">{t("sys.subsDesc")}</p>
          <div className="b4-fields">
            {rows.map((row, i) => (
              <div key={i} className="b4-field">
                <input
                  className="ob-input"
                  placeholder={t("sys.subsName")}
                  value={row.name}
                  onChange={(e) => patchRow(i, { name: e.target.value })}
                />
                <input
                  className="ob-input b4-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={t("sys.subsCost")}
                  value={row.monthly_cost}
                  onChange={(e) => patchRow(i, { monthly_cost: e.target.value })}
                />
                <button className="ob-btn-del" onClick={() => removeRow(i)}>{t("common.del")}</button>
              </div>
            ))}
            <div className="b4-field">
              <button
                className="b4-btn-sm"
                onClick={() => setRows((rs) => [...rs, { name: "", monthly_cost: "" }])}
              >{t("sys.addItem")}</button>
            </div>
          </div>
        </div>
      </div>

      {/* ── 知識庫根目錄（後端不驗目錄存在，前端也不預先判定）── */}
      <div className="b4-sec">
        <p className="b4-sec-h">{t("sys.kmsTitle")}</p>
        <div className="b4-card">
          <p className="b4-card-desc b4-card-desc-lead">{t("sys.kmsDesc")}</p>
          <div className="b4-field">
            <input
              className="ob-input"
              placeholder={t("sys.kmsPlaceholder")}
              value={kms}
              onChange={(e) => {
                setError(null);
                setKms(e.target.value);
              }}
            />
            <button onClick={browse} className="ob-btn-ghost">{t("common.browse")}</button>
          </div>
        </div>
      </div>

      {/* 送出途中三個按鈕一起停用：離開這頁會讓在途的儲存變成沒有歸屬的請求，
          而 onNext 也可能被按過的略過與回來的 saveAndNext 各叫一次（＝跳兩頁） */}
      <div className="ob-actions">
        <button onClick={onPrev} disabled={busy} className="ob-btn-ghost">{t("common.prev")}</button>
        <div className="ob-actions-right">
          <button onClick={onNext} disabled={busy} className="b4-skip">{t("sys.skipAll")}</button>
          <button onClick={saveAndNext} disabled={busy} className="ob-btn">{t("common.next")}</button>
        </div>
      </div>
    </div>
  );
}

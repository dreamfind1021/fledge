import { useCallback, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation, Trans } from "react-i18next";
import { CommonConfigCard } from "./CommonConfigCard";
import { TemplateCard } from "./TemplateCard";
import "./Onboarding.css";   // 兩張卡用的 b4-* 樣式住在這裡（精靈沒掛載時也要有）

interface AccountInfo {
  config_dir: string;
  label: string;
}

interface DevEnvSectionProps {
  port: number | null;
  accounts: Record<string, AccountInfo>;
  /** 重開全屏精靈。由 App 持有 modal 狀態，這裡只負責通知。 */
  onRerunOnboarding: () => void;
}

/** 設定頁的「開發環境」摺疊區（票 29）：日常會反覆用到的兩張卡＋重跑引導入口。
 *
 * 這是票 22 定案「中途離開不再自動彈」的配套出口——沒有這一區，中途離開精靈的使用者就沒有回頭路。
 *
 * **卡片即使收合也照樣掛著**：待處理數要靠共通設置卡自己偵測才知道，等展開才數等於那個數字永遠
 * 遲到一步（使用者得先展開才知道該不該展開）。兩張卡在載入階段都只做唯讀探測，代價是開設定頁時
 * 多幾次本機檔案系統檢查。 */
export function DevEnvSection({ port, accounts, onRerunOnboarding }: DevEnvSectionProps) {
  const { t } = useTranslation("onboarding");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(0);
  // 穩定引用：卡片以它當 effect 依賴，每 render 換一個新函式會讓回報 effect 反覆重跑
  const handlePending = useCallback((count: number) => setPending(count), []);

  return (
    <div className="st-fold">
      <button
        type="button"
        className="st-fold-h"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronDown size={13} strokeWidth={2} className={open ? "" : "st-fold-caret"} />
        <span>{t("st.devEnv")}</span>
        {pending > 0 && <span className="b4-chip warn">{t("st.pending", { count: pending })}</span>}
      </button>

      <div className="st-fold-body" hidden={!open}>
        {/* 同一個元件，兩處掛載——設定頁版多了逐項授權（spec-b4 定案 8：精靈不給破壞性授權） */}
        <CommonConfigCard
          port={port}
          accounts={accounts}
          allowOverwrite
          onPendingChange={handlePending}
        />
        <TemplateCard port={port} />
        <p className="b4-hint">
          <Trans
            t={t}
            i18nKey="st.rerunHint"
            components={{ rerun: <button type="button" className="st-link" onClick={onRerunOnboarding} /> }}
          />
        </p>
      </div>
    </div>
  );
}

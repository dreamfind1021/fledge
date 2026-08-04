import { useState } from "react";
import { useTranslation } from "react-i18next";

interface InstallSectionProps {
  title: string;
  items: string[];
  note?: string;
  defaultOpen?: boolean;
}

/**
 * 一列分類：標題 ＋ 數量 ＋ 可展開的明細。安裝預覽（票 05）與安裝結果（票 06）共用。
 *
 * **需要使用者行動的分類預設展開**：預覽的 `blocked`／未確認落點的 extra／漏選落點的
 * 帳號，結果的失敗項——那些正是他要補救的東西，收起來等於換一種方式漏報。純資訊的
 * 分類（跳過、刻意不處理、會改寫的專案、已裝好）預設收合，免得整頁被淹沒。
 *
 * 空清單整段不出現（不顯示 0）：沒發生的事不需要佔一列。
 *
 * 展開／收合的按鈕字串沿用 `mig.install.*`——兩張卡是同一個動作，各留一份必然漂移。
 */
export function InstallSection({ title, items, note, defaultOpen = false }: InstallSectionProps) {
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

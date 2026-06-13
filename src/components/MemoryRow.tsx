import { useTranslation } from "react-i18next";
import type { MemoryItem } from "../lib/sidecar";

// 單行密集列：badge + 標題 + 截斷摘要（+ 已連結 KMS topic 顯示 ◈）。a11y：button + aria-selected。
export function MemoryRow({ item, active, onClick }:
  { item: MemoryItem; active: boolean; onClick: () => void }) {
  const { t } = useTranslation("memory");
  const badge = item.source === "native" ? "b-native" : "b-kms";
  const label = item.source === "native" ? t("filter.native") : t("filter.kms");
  return (
    <button type="button" className={`lrow${active ? " active" : ""}`}
      aria-selected={active} onClick={onClick}>
      <span className={`badge ${badge}`}>{label}</span>
      <span className="ti">{item.title}</span>
      <span className="sep">·</span>
      <span className="su">{item.snippet || item.summary}</span>
      {item.source === "kms" && item.topic ? <span className="lk" aria-hidden="true">◈</span> : null}
    </button>
  );
}

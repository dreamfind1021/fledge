// 觀測 dashboard 共用格式化工具（design §10）

/** 金額格式化：小於 $0.01 顯示 "<$0.01"，其餘兩位小數加千分位逗號。
 *  Net ROI 可為負——負數回 "-$50.00" 而非 "$-50.00"。 */
export function fmtUSD(n: number): string {
  if (n < 0) return `-${fmtUSD(-n)}`;
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 比例格式化：0.8234 → "82%"（四捨五入到整數）。 */
export function fmtPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** token 數量縮寫：≥1M 顯示 1.2M、≥1K 顯示 12.3K、其餘直接顯示數字。 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** epoch 秒 → HH:mm；可注入 timeZone 讓測試結果不受本機時區影響。 */
export function fmtClock(epochSec: number, timeZone?: string): string {
  return new Date(epochSec * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

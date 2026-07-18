// 觀測 dashboard 共用格式化工具（design §10）

/** 金額格式化：小於 $0.01 顯示 "<$0.01"，其餘兩位小數加千分位逗號。
 *  Net ROI 可為負——負數回 "-$50.00" 而非 "$-50.00"。 */
export function fmtUSD(n: number): string {
  if (n < 0) return `-${fmtUSD(-n)}`;
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 比例格式化：0.8234 → "82%"（四捨五入到整數）。
 *  null（該源無資料、分母為 0）回 "—"，與真正的 0% 命中區分。 */
export function fmtPct(ratio: number | null): string {
  if (ratio == null) return "—";
  return `${Math.round(ratio * 100)}%`;
}

/** token 數量縮寫：≥1M 顯示 1.2M、≥1K 顯示 12.3K、其餘直接顯示數字。 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Codex 額度窗口的標籤角色。fiveHour/weekly 是已知窗口的固定文案 key；
 *  其餘回帶數值的動態 key（days/hours/minutes），由呼叫端插值 i18n。 */
export type WindowLabel =
  | { key: "fiveHour" | "weekly" }
  | { key: "days" | "hours" | "minutes"; n: number };

/** 依實際 window_minutes 判定窗口角色——2026-07 Codex API 把週窗改放 primary、
 *  secondary 變 null，角色不能按位置推定。無效值（null/0/負/NaN）退回呼叫端
 *  指定的 fallback 角色；非標準分鐘數整除 1440→天、整除 60→小時、否則→分鐘。 */
export function codexWindowLabel(minutes: number | null,
                                 fallback: "fiveHour" | "weekly"): WindowLabel {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return { key: fallback };
  if (minutes === 300) return { key: "fiveHour" };
  if (minutes === 10080) return { key: "weekly" };
  if (minutes % 1440 === 0) return { key: "days", n: minutes / 1440 };
  if (minutes % 60 === 0) return { key: "hours", n: minutes / 60 };
  return { key: "minutes", n: minutes };
}

/** epoch 秒 → HH:mm；可注入 timeZone 讓測試結果不受本機時區影響。 */
export function fmtClock(epochSec: number, timeZone?: string): string {
  return new Date(epochSec * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** 非今日時間戳的人性化顯示：今天→HH:mm、昨天→`{昨天標籤} HH:mm`、更早→`M/D HH:mm`。
 *  yesterdayLabel 由呼叫端帶 t() 結果（lib 不依賴 i18n）；nowSec/timeZone 供測試注入。 */
export function fmtDayClock(epochSec: number, yesterdayLabel: string,
                            nowSec?: number, timeZone?: string): string {
  const tzOpt = timeZone ? { timeZone } : {};
  const dateKey = (sec: number) => new Date(sec * 1000).toLocaleDateString("en-CA", tzOpt); // YYYY-MM-DD
  const now = nowSec ?? Date.now() / 1000;
  const clock = fmtClock(epochSec, timeZone);
  if (dateKey(epochSec) === dateKey(now)) return clock;
  if (dateKey(epochSec) === dateKey(now - 86400)) return `${yesterdayLabel} ${clock}`;
  const md = new Date(epochSec * 1000).toLocaleDateString("en-US",
    { month: "numeric", day: "numeric", ...tzOpt });
  return `${md} ${clock}`;
}

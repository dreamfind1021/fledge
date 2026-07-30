import type { BackupStatus } from "./sidecar";

/** 距上次備份的新鮮度。純文字顏色用——這是「只做常駐可見指標」的方案裡唯一還能加強度的
 *  地方，且不佔任何額外版面（不加徽章、不加 banner，那是刻意的設計決策）。 */
export type Freshness = "fresh" | "stale" | "overdue";

const FRESH_DAYS = 7;
const STALE_DAYS = 30;

export function freshnessLevel(days: number | null): Freshness {
  // 從未備份與「超過一個月」同級：兩者都代表使用者**現在**沒有保護，沒有理由把前者說得比較輕
  if (days === null) return "overdue";
  if (days <= FRESH_DAYS) return "fresh";
  if (days <= STALE_DAYS) return "stale";
  return "overdue";
}

const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** 位元組 → 人看得懂的大小。停在 GB：備份包不會有 TB 級，多加單位只是沒人走到的分支。 */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** 備份包時間的顯示格式。**刻意不顯示秒**：備份包的時間戳來自檔名（`…-HHMM`），
 *  精度只到分鐘，秒永遠是 00——印出來等於宣稱一個我們沒有的精度。 */
export function formatBundleTime(createdTs: number, locale?: string): string {
  return new Date(createdTs * 1000).toLocaleString(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 卡片目前的阻斷原因；`null` 代表可以正常呈現。 */
export type BlockingReason =
  | "not_configured"
  | "invalid"
  | "inside_source"
  | "is_home"
  | "is_root"
  | "dir_missing"
  | "dir_not_dir"
  | "dir_denied"
  | "script_missing"
  | "python3_missing";

/** 後端旗標 → 阻斷原因。**顯式表而非動態組 key**：後端日後多一個狀態時，動態組會產生
 *  catalog 裡沒有的 key，而 i18n 對查不到的 key 是把 key 原文印出來——使用者會在畫面上
 *  看到 `blocked.dir_whatever`（CLAUDE.md §4.6.13 要擋的正是這個）。查不到就回 `null`
 *  交給呼叫端當成可用：寧可少擋一次，也不要顯示 key。 */
const CONTAINMENT_REASON: Record<string, BlockingReason> = {
  invalid: "invalid",
  inside_source: "inside_source",
  is_home: "is_home",
  is_root: "is_root",
};

const DIR_STATUS_REASON: Record<string, BlockingReason> = {
  missing: "dir_missing",
  not_dir: "dir_not_dir",
  denied: "dir_denied",
};

/** 旗標**可能同時成立**（例如位置不合法、目錄也不存在），所以這是一條有序的決策鏈：
 *  取第一個成立的、只顯示它。順序與後端擋下的順序一致——使用者看到的修復指引，
 *  就是後端下一個會擋的東西。
 *
 *  containment 排在目錄狀態**之前**：位置本身選錯時，把那個目錄建出來也沒用，
 *  叫使用者去修目錄只會讓他做白工。 */
export function blockingReason(status: BackupStatus): BlockingReason | null {
  // 沒選過位置時，目錄當然也是「不存在」——但要使用者去修一個他還沒選的目錄毫無意義。
  if (!status.configured) return "not_configured";
  if (status.containment !== "ok") return CONTAINMENT_REASON[status.containment] ?? null;
  if (status.dir_status !== "dir") return DIR_STATUS_REASON[status.dir_status] ?? null;
  // 環境前提排最後：它與使用者選了什麼位置無關，但也修不了位置的問題，
  // 所以先讓使用者把自己能決定的事情弄對。
  if (!status.script_available) return "script_missing";
  if (!status.python3_available) return "python3_missing";
  return null;
}

import type { BackupStatus } from "./sidecar";

/** 卡片目前的阻斷原因；`null` 代表可以正常呈現。
 *
 * 旗標**可能同時成立**（之後幾張票會再加 containment 與環境前提），所以這是一條
 * 有序的決策鏈：取第一個成立的，只顯示它。順序與後端擋下的順序一致——使用者在卡片上
 * 看到的修復指引，就是後端下一個會擋的東西。 */
export type BlockingReason =
  | "not_configured"
  | "dir_invalid"
  | "dir_missing"
  | "dir_not_dir"
  | "dir_denied";

/** 後端 `dir_status` → 阻斷原因。**顯式表而非 `` `dir_${s}` `` 動態組 key**：後端日後多一個
 *  狀態時，動態組會產生一個 catalog 裡沒有的 key，而 i18n 對查不到的 key 是把 key 原文印出來
 *  ——使用者會在畫面上看到 `blocked.dir_whatever`（CLAUDE.md §4.6.13 要擋的正是這個）。
 *  查不到就回 `null` 交給呼叫端當成可用，寧可少擋也不要顯示 key。 */
const DIR_STATUS_REASON: Record<string, BlockingReason> = {
  invalid: "dir_invalid",
  missing: "dir_missing",
  not_dir: "dir_not_dir",
  denied: "dir_denied",
};

export function blockingReason(status: BackupStatus): BlockingReason | null {
  // 沒選過位置時，目錄當然也是「不存在」——但要使用者去修一個他還沒選的目錄毫無意義。
  if (!status.configured) return "not_configured";
  if (status.dir_status === "dir") return null;
  return DIR_STATUS_REASON[status.dir_status] ?? null;
}

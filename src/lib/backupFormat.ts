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

export function blockingReason(status: BackupStatus): BlockingReason | null {
  // 沒選過位置時，目錄當然也是「不存在」——但要使用者去修一個他還沒選的目錄毫無意義。
  if (!status.configured) return "not_configured";
  if (status.dir_status !== "dir") return `dir_${status.dir_status}` as BlockingReason;
  return null;
}

import type { BackupStatus, RestoreDestStatus } from "./sidecar";

/** 還原卡的阻斷原因；`null` 代表可以正常呈現。 */
export type RestoreBlocking =
  | "not_configured"
  | "dir_unusable"
  | "no_bundles"
  | "script_missing"
  | "python3_missing";

/** 旗標可能同時成立，所以這是一條有序的決策鏈：取第一個成立的、只顯示它。順序與後端
 *  `_restore_blocked` 擋下的順序一致——使用者看到的修復指引，就是後端下一個會擋的東西。
 *
 *  **`containment` 刻意不在鏈上**：那是「輸出不能落在讀取來源裡面」的規則，只對備份寫入
 *  成立。備份位置不理想並不會讓裡面既有的備份包變得不能讀，拿它擋下還原只是在使用者最需要
 *  備份包的時候製造死路。後端 `resolve_backup_dir` 同樣不驗它，兩邊必須一致。 */
export function restoreBlocking(status: BackupStatus): RestoreBlocking | null {
  // 沒選過位置時目錄當然也「不可用」，但要使用者去修一個他還沒選的目錄毫無意義
  if (!status.configured) return "not_configured";
  if (status.dir_status !== "dir") return "dir_unusable";
  // 目錄好好的但空的：使用者要做的是先備份一次，不是修任何東西
  if (status.bundles.length === 0) return "no_bundles";
  // 環境前提排最後：它與使用者選了什麼位置無關，先讓他把自己能決定的事情弄對。
  // **只看還原腳本**——備份腳本缺席不影響還原，兩支是不同的檔案。
  if (!status.restore_script_available) return "script_missing";
  if (!status.python3_available) return "python3_missing";
  return null;
}

/** 展開位置的狀態 → catalog key（`restore` namespace 內的相對 key）。
 *
 *  **顯式表而非動態組 key**：後端多一個狀態時，動態組會產生 catalog 裡沒有的 key，而 i18n
 *  對查不到的 key 是把 key 原文印出來，使用者會在畫面上看到 `dest.whatever`
 *  （CLAUDE.md §4.6.13）。Record 涵蓋整個 union，後端加狀態會在這裡編譯失敗。 */
const DEST_KEY: Record<Exclude<RestoreDestStatus, "ok">, string> = {
  is_root: "dest.is_root",
  is_home: "dest.is_home",
  inside_source: "dest.inside_source",
  not_empty: "dest.not_empty",
  not_dir: "dest.not_dir",
  denied: "dest.denied",
};

export function destMessageKey(status: RestoreDestStatus): string | null {
  return status === "ok" ? null : DEST_KEY[status];
}

/** 修復斷鏈時要用的帳號角色。`source`＝實體檔持有者，取第一個登記帳號——與共通設置卡
 *  同一慣例（spec §6.3），兩處對「誰是 source」的認定不同會讓修復把連結指到另一個地方。
 *
 *  少於兩個帳號時回 `null`：單一帳號沒有 target，照送只會拿一個必然的 `empty_targets`
 *  去問後端。 */
export function repairScope(accountKeys: string[]): { source: string; targets: string[] } | null {
  if (accountKeys.length < 2) return null;
  return { source: accountKeys[0], targets: accountKeys.slice(1) };
}

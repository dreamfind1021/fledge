import { open } from "@tauri-apps/plugin-dialog";

/** 開系統資料夾選擇器，回選定的絕對路徑；使用者取消回 null。 */
export async function pickDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** 開系統檔案選擇器挑備份包，回絕對路徑；使用者取消回 null。
 *
 * `label` 由呼叫端傳 `t()` 的結果——本模組是 Tauri API 的薄封裝，不該自己相依 i18n，
 * 但這個字串會出現在系統對話框上（CLAUDE.md §4.6.13 的 user-facing 字串）。
 *
 * 副檔名過濾用 `gz`／`xz`：filters 比對的是最後一個點之後的部分，`tar.gz`／`tar.xz` 不會命中。
 * 新備份是 `.tar.xz`，舊的 `.tar.gz` 也要選得到（xz 改版 spec G2）。
 */
export async function pickFile(label: string): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: label, extensions: ["gz", "xz"] }],
  });
  return typeof selected === "string" ? selected : null;
}

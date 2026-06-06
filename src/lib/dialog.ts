import { open } from "@tauri-apps/plugin-dialog";

/** 開系統資料夾選擇器，回選定的絕對路徑；使用者取消回 null。 */
export async function pickDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

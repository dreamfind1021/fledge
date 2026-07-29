import type { AppConfigData } from "./sidecar";

// 啟動時的 config 形狀驗證（design §4.1.3）。
//
// 為什麼需要：`fetchConfig` 只做 `resp.json()` 後以 TypeScript cast 接受資料，runtime 沒有任何
// 檢查。畸形內容（`{accounts:{work:null}}`、`manual_projects:null`）會讓 loadConfig 正常 resolve、
// 啟動被判為成功，然後才在 Sidebar 的 Object.keys 或設定頁的 .filter 炸開——那時 Splash 已經淡出，
// 使用者面對的是一個崩潰的畫面而不是有重試按鈕的錯誤態。
//
// 驗證範圍由「UI 實際索引了什麼」反推，不做完整 schema：只要是元件會直接取用的欄位就必須驗到
// 元素層級，其餘一律不管。刻意不引 zod——六個欄位的淺層檢查，手寫足夠，且能表達「選用欄位未提供
// 合法、但提供了型別就必須對」這種本地語意。

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** record 的每個值都是物件，且指定欄位都是字串。 */
function everyValueHasStrings(v: unknown, fields: string[]): boolean {
  if (!isRecord(v)) return false;
  return Object.values(v).every(
    (item) => isRecord(item) && fields.every((f) => typeof item[f] === "string"),
  );
}

/** 陣列的每個元素都是物件，且指定欄位都是字串。 */
function everyItemHasStrings(v: unknown, fields: string[]): boolean {
  if (!Array.isArray(v)) return false;
  return v.every((item) => isRecord(item) && fields.every((f) => typeof item[f] === "string"));
}

export function isUsableConfig(raw: unknown): raw is AppConfigData {
  if (!isRecord(raw)) return false;

  // 必要欄位：缺一即致命（對應 Sidebar / Settings / AccountsEditor 的直接索引）
  if (!everyValueHasStrings(raw.accounts, ["config_dir", "label"])) return false;
  if (!everyItemHasStrings(raw.roots, ["path", "default_account"])) return false;
  if (!everyItemHasStrings(raw.manual_projects, ["path", "account"])) return false;
  if (!everyValueHasStrings(raw.project_overrides, ["account"])) return false;

  // 選用欄位：未提供合法（舊前端快取無此欄），提供了型別就必須對
  if (raw.subscriptions !== undefined) {
    if (!Array.isArray(raw.subscriptions)) return false;
    const ok = raw.subscriptions.every(
      (s) => isRecord(s) && typeof s.name === "string" && typeof s.monthly_cost === "number",
    );
    if (!ok) return false;
  }
  if (raw.kms_root !== undefined && typeof raw.kms_root !== "string") return false;

  return true;
}

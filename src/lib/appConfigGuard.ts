import type { AppConfigData } from "./sidecar";

// 啟動時的 config 形狀驗證（design §4.1.3）。
//
// 為什麼需要：`fetchConfig` 只做 `resp.json()` 後以 TypeScript cast 接受資料，runtime 沒有任何
// 檢查。畸形內容（`{accounts:{work:null}}`、`manual_projects:null`）會讓 loadConfig 正常 resolve、
// 啟動被判為成功，然後才在 Sidebar 的 Object.keys 或設定頁的 .filter 炸開——那時 Splash 已經淡出，
// 使用者面對的是一個崩潰的畫面而不是有重試按鈕的錯誤態。
//
// 驗證的界線是「**會不會 throw**」，不是「欄位齊不齊」：容器形狀與元素物件性必須驗（`a.config_dir`
// 對 null 存取就爆），具名欄位只在存在時驗型別。這條界線是 Codex PR-gate 修正的——原本要求
// `accounts[*].label` 必須存在，但既有契約允許它缺席，等於讓那些使用者永久卡在啟動畫面。
// 刻意不引 zod：淺層檢查手寫足夠，且能表達「缺席合法、提供了型別就必須對」這種本地語意。

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 元素本身必須是物件（否則存取欄位就 throw）；具名欄位**只在存在時**驗型別。
 *
 * 刻意不要求欄位存在：既有契約允許欄位缺席，UI 早有 fallback（如 `sidebarGroups.ts`
 * 的 `meta?.label || key`），後端 `AppConfig.load()` 也原樣收下既有 accounts、不補欄位。
 * 把缺席升格成致命，會讓這種歷史 config 的使用者永久卡在啟動畫面——而重試讀回的是
 * 同一份檔案，救不了。那比 guard 原本要防的崩潰更糟。 */
function fieldsOk(item: unknown, fields: string[]): boolean {
  if (!isRecord(item)) return false;
  return fields.every((f) => item[f] === undefined || typeof item[f] === "string");
}

function everyValueOk(v: unknown, fields: string[]): boolean {
  return isRecord(v) && Object.values(v).every((item) => fieldsOk(item, fields));
}

function everyItemOk(v: unknown, fields: string[]): boolean {
  return Array.isArray(v) && v.every((item) => fieldsOk(item, fields));
}

export function isUsableConfig(raw: unknown): raw is AppConfigData {
  if (!isRecord(raw)) return false;

  // 容器形狀與元素物件性：缺一即致命（對應 Sidebar / Settings / AccountsEditor 的直接索引）
  if (!everyValueOk(raw.accounts, ["config_dir", "label"])) return false;
  if (!everyItemOk(raw.roots, ["path", "default_account"])) return false;
  if (!everyItemOk(raw.manual_projects, ["path", "account"])) return false;
  if (!everyValueOk(raw.project_overrides, ["account"])) return false;

  // 選用欄位：未提供合法（舊前端快取無此欄），提供了型別就必須對。
  // 元素內的具名欄位同樣只在存在時驗——`subscriptions` 也走後端的 `data.get(…, [])`
  // 原樣收下，要求欄位必存會重演 label 那條的鎖死問題。
  if (raw.subscriptions !== undefined) {
    if (!Array.isArray(raw.subscriptions)) return false;
    const ok = raw.subscriptions.every(
      (s) =>
        isRecord(s) &&
        (s.name === undefined || typeof s.name === "string") &&
        (s.monthly_cost === undefined || typeof s.monthly_cost === "number"),
    );
    if (!ok) return false;
  }
  if (raw.kms_root !== undefined && typeof raw.kms_root !== "string") return false;

  return true;
}

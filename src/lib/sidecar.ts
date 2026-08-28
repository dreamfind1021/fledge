import { invoke } from "@tauri-apps/api/core";
import { isUsableConfig } from "./appConfigGuard";

// per-launch 認證 token；App 啟動時由 setAuthToken 設一次，跨 restart 不變。
let authToken: string | null = null;
export function setAuthToken(t: string | null): void {
  authToken = t;
}
export function authHeaders(): Record<string, string> {
  return authToken != null ? { "X-Fledge-Token": authToken } : {};
}
export function wsUrl(port: number, sessionId: string): string {
  const u = `ws://127.0.0.1:${port}/ws/${sessionId}`;
  return authToken != null ? `${u}?token=${encodeURIComponent(authToken)}` : u;
}

/** 輪詢 Tauri command 直到拿到非空 token（Rust 在 setup 早就生好、應幾乎即時）。逾時 throw。 */
export async function waitForSidecarToken(maxWaitMs = 10000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const t = await invoke<string | null>("sidecar_token");
    if (t) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sidecar token 未就緒");
}

/** 輪詢 Tauri command 直到 sidecar port 就緒（最多等 maxWaitMs）。
 *
 * 預設 30s：裝完首次開啟時 macOS 要驗證 onedir 內數百個 dylib，sidecar 需 ~14s 才 listening；
 * 驗證結果被 cache，之後每次約 0.2s。
 *
 * spawn 失敗（binary 遺失、無執行權限）時 port 永遠不會來，等滿 30s 只是浪費使用者時間，
 * 還把「哪個路徑的 binary 出問題」這種精確原因換成通用逾時訊息。故每輪一併查 Rust 端記下的
 * spawn 錯誤，有值就立刻帶原文失敗（design §4.6）。
 */
export async function waitForSidecarPort(maxWaitMs = 30000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const port = await invoke<number | null>("sidecar_port");
    if (port != null) return port;
    const spawnError = await invoke<string | null>("sidecar_spawn_error");
    if (spawnError) throw new Error(spawnError);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Sidecar did not start in time");
}

export interface Health {
  ok: boolean;
  version: string;
  claude_found: boolean;
}

/** 輪詢 /api/health 直到回應就緒（或逾時）。
 *
 * sidecar 先印 FLEDGE_PORT 再啟動 uvicorn，故 Tauri 抓到 port、前端拿到 port 時
 * server 可能仍在 startup（實測約 0.5s gap）；單次 fetch 會撞連線被拒
 * （webview 報 TypeError: Load failed）。此處 retry 至 health 200 或逾時。
 */
export async function fetchHealth(port: number, maxWaitMs = 10000): Promise<Health> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: authHeaders() });
      if (resp.ok) return resp.json();
      lastErr = new Error(`status ${resp.status}`);
    } catch (e) {
      lastErr = e; // server 尚未就緒（連線被拒），稍候重試
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Health check failed: ${lastErr}`);
}

/** 週期 health poll 用：單次 raw fetch（不 retry）。回 parsed Health（含 P3 的 claude_found）或 null（失敗）。 */
export async function rawHealth(port: number): Promise<Health | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: authHeaders() });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** 重啟 sidecar：Rust kill 當前 child + 重 spawn + 回新 port。 */
export async function restartSidecar(): Promise<number> {
  return invoke<number>("restart_sidecar");
}

export type DirStatus = "dir" | "missing" | "not_dir" | "denied";
export type PreviewStatus = "ok" | "denied" | "missing" | "not_dir" | "invalid";

export interface Project {
  name: string;
  path: string;
  account: string;
  source: string;
  root: string | null;
  recent: number | null;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}
export interface DirTreeResult {
  path: string;
  entries: DirEntry[];
  status: "ok" | "denied" | "missing" | "not_dir";
}

const base = (port: number) => `http://127.0.0.1:${port}`;

export async function fetchProjects(port: number): Promise<{ projects: Project[]; permissionError: boolean }> {
  const resp = await fetch(`${base(port)}/api/projects`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`fetchProjects failed: ${resp.status}`);
  const body = await resp.json();
  return { projects: body.projects, permissionError: body.permission_error ?? false };
}

// 回 { path, count, status }：path 是後端 canonicalize（resolve）後的路徑，前端用它當 draft
// 的 dedup key（與後端 onboard 存的一致）。status 讓 wizard 決定加不加 draft。
export async function scanPreview(
  port: number,
  path: string,
): Promise<{ path: string; count: number; status: PreviewStatus }> {
  const resp = await fetch(`${base(port)}/api/projects/scan-preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`scanPreview failed: ${resp.status}`);
  const data = await resp.json();
  return { path: data.path, count: data.count, status: data.status };
}

export type SessionKind = "claude" | "terminal" | "install" | "login" | "backup" | "restore";

export interface CreateSessionOptions {
  // 工作目錄兼歸屬標記。install 沒有所屬專案（後端固定跑在 home、只把它當 project_path 記錄），
  // 故傳空字串——不是漏填。
  path: string;
  account?: string;                     // install 不傳：後端不驗帳號、也不注入帳號 env
  kind?: SessionKind;
  installId?: string;                   // kind=install 必填；後端據此查 TOOL_SPECS 取命令
  loginTarget?: "claude" | "codex";     // kind=login 用
  backupMode?: "list" | "run";          // kind=backup 必填；後端據此決定跑不跑 --list
  /** kind=restore 的來源之一。**是備份包名不是路徑**——後端拿它過 `list_bundles` 的
   *  allowlist 才變成路徑（沿用 install 只送 `install_id` 的不變式）。 */
  restoreBundle?: string;
  /** kind=restore 的另一個來源：使用者用系統檔案選擇器挑的**絕對路徑**（移機，增補
   *  spec §2.7）。與 `restoreBundle` **二擇一**，兩者都給後端回 400。 */
  restoreBundlePath?: string;
  restoreDest?: string;                 // kind=restore 選填；未給＝後端算的預設展開位置
}

/** 建立 session 失敗。`code` 是後端的英文判別碼（400 才有），呼叫端據此映射 i18n 字串。
 *
 * 判別碼**只放欄位、不放 message**：`openTab` 會把 `String(e)` 寫進 `tab.error`，由
 * `Workspace` 直接顯示給使用者——寫進 message 等於讓判別碼繞過 i18n 映射出現在畫面上
 * （CLAUDE.md §4.6.13 / spec-b4 §5）。message 因此維持既有的 `createSession failed: <status>`。 */
export class SessionError extends Error {
  constructor(public readonly code: string | null, public readonly status: number) {
    super(`createSession failed: ${status}`);
    this.name = "SessionError";
  }
}

/** 從錯誤回應取出後端判別碼；非 JSON body（422 的 detail 陣列、裸 5xx）→ null（無碼可映射）。 */
async function readErrorCode(resp: Response): Promise<string | null> {
  return (await readErrorPayload(resp)).error;
}

/** 錯誤回應的完整 body。多數端點只要 `error`（`readErrorCode`），但 `adopt-config` 的
 *  409 還帶 `created_by`（票 15）——**body 只能讀一次**，所以兩者共用這一支。 */
async function readErrorPayload(
  resp: Response,
): Promise<{ error: string | null; created_by?: ConfigCreatedBy }> {
  try {
    const data = await resp.json();
    return { error: data?.error ?? null, created_by: data?.created_by };
  } catch {
    return { error: null };
  }
}

export async function createSession(port: number, opts: CreateSessionOptions): Promise<string> {
  const { path, account, kind = "claude", installId, loginTarget, backupMode,
          restoreBundle, restoreBundlePath, restoreDest } = opts;
  // 安全不變式（spec §5）：body 只放 allowlist key（install_id），永遠不含命令字串。
  // 未給的欄位一律不放進 body——後端 extra="forbid" 只擋未知欄位，但少送等於用後端預設，
  // 也讓「安裝不帶 account」這件事在 wire 上看得出來。
  const body: Record<string, unknown> = { path, kind };
  if (account !== undefined) body.account = account;
  if (installId !== undefined) body.install_id = installId;
  if (loginTarget !== undefined) body.login_target = loginTarget;
  if (backupMode !== undefined) body.backup_mode = backupMode;
  if (restoreBundle !== undefined) body.restore_bundle = restoreBundle;
  if (restoreBundlePath !== undefined) body.restore_bundle_path = restoreBundlePath;
  if (restoreDest !== undefined) body.restore_dest = restoreDest;

  const resp = await fetch(`${base(port)}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new SessionError(await readErrorCode(resp), resp.status);
  return (await resp.json()).session_id;
}

export async function closeSession(port: number, sessionId: string): Promise<void> {
  // 失敗時 log（不再靜默吞，符合 CLAUDE.md §3.2）：session 可能殘留在 sidecar，
  // 完整的重試／orphan reaper 留 Plan 04。仍不 throw——closeTab／orphan 清理不應因此中斷（mode A）。
  try {
    const resp = await fetch(`${base(port)}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!resp.ok) {
      console.error(`closeSession ${sessionId} 失敗：HTTP ${resp.status}（session 可能殘留）`);
    }
  } catch (e) {
    console.error(`closeSession ${sessionId} 連線錯誤（session 可能殘留）：`, e);
  }
}

export async function resizeSession(
  port: number,
  sessionId: string,
  rows: number,
  cols: number,
): Promise<void> {
  // resize 低頻、失敗影響小（PTY 尺寸沒同步）；失敗時 log 不 throw（符合 CLAUDE.md §3.2）。
  try {
    const resp = await fetch(`${base(port)}/api/sessions/${sessionId}/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ rows, cols }),
    });
    if (!resp.ok) {
      console.error(`resizeSession ${sessionId} 失敗：HTTP ${resp.status}`);
    }
  } catch (e) {
    console.error(`resizeSession ${sessionId} 連線錯誤：`, e);
  }
}

// --- 開發環境偵測（spec-b4 §5）---
// 工具清單與命令字串一律由後端 TOOL_SPECS 提供，前端不得自帶：install_command 為 null
// 代表只能手動安裝（官方指令在 manual_command）；安裝執行走 install_id allowlist（票 24）。
export type ToolTier = "core" | "recommended";

export interface ToolStatus {
  id: string;
  label: string;
  tier: ToolTier;            // 後端若新增 tier，這裡與 EnvCard 的分區呼叫端要一起補
  installed: boolean;
  path: string | null;
  version: string | null;
  binary: string;            // 未安裝時列這個（沒有版本可列）
  install_command: string | null;
  manual_command: string | null;
}

export async function fetchSetupStatus(port: number): Promise<ToolStatus[]> {
  const resp = await fetch(`${base(port)}/api/setup/status`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()).tools as ToolStatus[];
}

// --- 雙帳號共通設置（spec-b4 §6.3；安全權威在後端 setup/common_config.py）---

/** 要同步的共通設置項。清單由前端持有是因為後端沒有列舉端點，但**不是第二份權威**：
 *  不在後端 allowlist 內的名字會被回 `unknown_entry`。
 *
 *  刻意不含進階項 `projects`（session 歷史跨帳號共用）——精靈預設不動它（票 26）。 */
export const COMMON_CONFIG_ENTRIES = [
  "commands", "plugins", "skills", "settings.json", "CLAUDE.md",
] as const;

/** 修復斷鏈時要送的 entry 清單＝上面那份**再加上 `projects`**。
 *
 *  `projects` 是共通設置的進階項（預設不勾，所以不在 `COMMON_CONFIG_ENTRIES` 裡），但它在
 *  後端 `ENTRY_SPECS` 內。移機後現況已存在的 `projects` 連結同樣是斷鏈，不送它就永遠修不回來
 *  ——這正是後端把 `projects` 收進 allowlist 的理由。修復只重建斷鏈、不建立新連結，所以
 *  多送它不會替沒用過這個進階項的使用者無中生有。 */
export const RESTORE_REPAIR_ENTRIES = [...COMMON_CONFIG_ENTRIES, "projects"] as const;

// 後端 common_config.py 的三組 enum。以 union 而非 string 承接，讓「後端新增一種狀態」
// 在前端的映射表上編譯失敗，而不是靜默掉到某個 fallback 文案。
export type CommonConfigState =
  | "ok" | "wrong_link" | "broken_link" | "real_file" | "real_dir" | "empty_dir"
  | "content_differs" | "unexpected_type" | "missing" | "source_missing" | "source_unsupported";
export type CommonConfigAction =
  | "skip" | "create_link" | "relink" | "copy" | "backup_and_link" | "backup_and_copy";
export type CommonConfigOutcome =
  | "created" | "relinked" | "copied" | "skipped" | "conflict" | "stale" | "failed";

export interface CommonConfigOperation {
  account: string;             // target account key
  entry: string;
  target_path: string;
  state: CommonConfigState;
  action: CommonConfigAction;
  needs_overwrite: boolean;    // 為真＝會蓋掉既有內容，需在 apply 的 overwrite 清單才執行
}

export interface CommonConfigPlan {
  source_dir: string;          // 實體檔持有者（source account）的 resolved config_dir
  operations: CommonConfigOperation[];
}

export interface CommonConfigOpResult {
  account: string;
  entry: string;
  outcome: CommonConfigOutcome;
  backup_path: string | null;
  error: string | null;        // 判別碼（失敗時）——顯示前必須映射，不得直接呈現
}

export interface CommonConfigRequest {
  source: string;
  targets: string[];
  entries: readonly string[];
}

/** setup 端點的判別碼錯誤。理由同 `SessionError`：`code` 只放欄位、不進 message，
 *  否則 `String(e)` 會讓後端判別碼繞過 i18n 映射直接出現在畫面上（spec-b4 §5）。 */
export class SetupError extends Error {
  constructor(public readonly code: string | null, public readonly status: number) {
    super(`setup request failed: ${status}`);
    this.name = "SetupError";
  }
}

async function setupPost<T>(port: number, path: string, body: object): Promise<T> {
  const resp = await fetch(`${base(port)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new SetupError(await readErrorCode(resp), resp.status);
  return resp.json();
}

/** 唯讀預覽：回每個 (target, entry) 的目前狀態與建議動作，不動檔案系統。 */
export function commonConfigPlan(port: number, req: CommonConfigRequest): Promise<CommonConfigPlan> {
  return setupPost(port, "/api/setup/common-config/plan", {
    source: req.source, targets: req.targets, entries: [...req.entries],
  });
}

/** 套用共通設置。`overwrite` 是被授權破壞既有內容的 `(account, entry)`；未列者回 conflict 不動。
 *
 *  參數刻意必填而非預設空陣列：精靈一律送 `[]`（spec-b4 定案 8，逐項授權只在設定頁版），
 *  由呼叫端顯式表態才看得出「這裡是非破壞性的」是刻意選擇，不是漏填。 */
export async function commonConfigApply(
  port: number,
  req: CommonConfigRequest & { overwrite: { account: string; entry: string }[] },
): Promise<CommonConfigOpResult[]> {
  const body = {
    source: req.source, targets: req.targets, entries: [...req.entries], overwrite: req.overwrite,
  };
  const data = await setupPost<{ results: CommonConfigOpResult[] }>(
    port, "/api/setup/common-config/apply", body,
  );
  return data.results;
}

/** 修復共通設置的斷鏈（票 08 的 `repair`，還原後使用）。**沒有 `overwrite` 參數**——
 *  repair 從不做破壞既有內容的動作（只重建目標不存在的連結），後端連那個欄位都不收。 */
export async function commonConfigRepair(
  port: number,
  req: CommonConfigRequest,
): Promise<CommonConfigOpResult[]> {
  const data = await setupPost<{ results: CommonConfigOpResult[] }>(
    port, "/api/setup/common-config/repair",
    { source: req.source, targets: req.targets, entries: [...req.entries] },
  );
  return data.results;
}

// --- 範本部署（spec-b4 §6.5；安全權威在後端 setup/templates.py）---

export interface TemplateInfo {
  id: string;                            // allowlist key，前端只送這個
  label: string;                         // 後端一律英文（§4.6.13）；卡片以 id 對 catalog，讀不到才退這裡
  description: string;
  source_class: "public" | "private";
  available: boolean;                    // 這個 build 有沒有真的內建（manifest 讀得出來）
}

// 後端 templates.py 的三組 enum。同 CommonConfig*：以 union 承接，讓「後端新增一種狀態」
// 在前端的映射表上編譯失敗，而不是靜默掉到 fallback 文案。
export type TemplateFileState = "missing" | "present" | "conflict";
export type TemplateState = "not_installed" | "partial" | "complete" | "conflict";
export type TemplateOutcome = "created" | "skipped" | "conflict" | "stale" | "failed";

export interface TemplateFileOp {
  path: string;                          // 相對目的地
  type: "file" | "dir";
  state: TemplateFileState;
}

export interface TemplatePlan {
  template: string;
  destination: string;                   // resolved
  state: TemplateState;
  operations: TemplateFileOp[];
}

export interface TemplateFileResult {
  path: string;
  outcome: TemplateOutcome;
  error: string | null;                  // 判別碼（失敗時）——顯示前必須映射，不得直接呈現
}

export interface TemplateDeployResult {
  template: string;
  destination: string;
  results: TemplateFileResult[];
}

/** 列出 allowlist 內全部範本（未內建者 available=false 照列）。
 *  GET 沒有判別碼合約（比照 `fetchSetupStatus`）：!ok 就 throw，讓卡片顯示載入失敗。 */
export async function fetchTemplates(port: number): Promise<TemplateInfo[]> {
  const resp = await fetch(`${base(port)}/api/setup/templates`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()).templates as TemplateInfo[];
}

/** 唯讀預覽：回逐檔狀態與整體狀態，不動檔案系統。 */
export function templatesPlan(port: number, template: string, destination: string): Promise<TemplatePlan> {
  return setupPost(port, "/api/setup/templates/plan", { template, destination });
}

/** 部署範本。plan 由 server 以相同輸入重算（ADR-0002，不吃 client plan），永不覆蓋既有檔案。 */
export function templatesDeploy(
  port: number,
  template: string,
  destination: string,
): Promise<TemplateDeployResult> {
  return setupPost(port, "/api/setup/templates/deploy", { template, destination });
}

export interface SubscriptionItem {
  name: string;
  monthly_cost: number;
}

/** 新使用者的預設帳號 key（後端 `app_config.py` 的 `DEFAULT_CONFIG`，票 31 起是單一帳號）。
 *  前端**只在 config 尚未載入時**拿它當暫時值——帳號清單一律以 `config.accounts` 為準，
 *  這個常數不是權威，只是避免把字面值散在各元件裡。 */
export const DEFAULT_ACCOUNT_KEY = "default";

export interface AppConfigData {
  version: number;
  roots: { path: string; default_account: string }[];
  accounts: Record<string, { config_dir: string; label: string }>;
  manual_projects: { path: string; account: string }[];
  project_overrides: Record<string, { account: string }>;
  ui: { theme: string };
  // 後端 to_dict 總是回傳；標選用是為相容舊前端快取（無此欄視為未設），讀取端一律 ?? "" 兜底
  kms_root?: string;  // KMS（Obsidian 知識庫）根目錄，raw 含 ~；未設為空字串
  backup_dir?: string;  // 備份輸出目錄，raw 含 ~；未設為空字串（刻意沒有預設值）
  subscriptions?: SubscriptionItem[];  // 後端 to_dict 總是回傳此欄；舊前端快取若無此欄視為空陣列
  // startup-only metadata：僅 GET /api/config 與 onboard 回應帶（設定檔不存在為 true）。
  // 其他 config write 不帶 → 寫入後此欄位為 undefined 屬正常；只在 App 啟動讀一次決定是否進
  // onboarding，之後改用獨立的 showOnboarding state，勿用於 render gate（Codex F-7）。
  is_first_run?: boolean;
}

export async function fetchConfig(port: number): Promise<AppConfigData> {
  const resp = await fetch(`${base(port)}/api/config`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`fetchConfig failed: ${resp.status}`);
  const raw = await resp.json();
  // 畸形內容擋在這一層：放行的話啟動會被判為成功、Splash 淡出，然後才在 Sidebar 的
  // Object.keys 或設定頁的 .filter 炸開——使用者面對的是崩潰畫面而不是有重試鈕的錯誤態。
  if (!isUsableConfig(raw)) throw new Error("fetchConfig: unusable config shape");
  return raw;
}

async function configWrite(
  port: number,
  path: string,
  method: string,
  body: Record<string, unknown>,
): Promise<AppConfigData> {
  const resp = await fetch(`${base(port)}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    // 取出 FastAPI 的 {"detail": "..."}（如「找不到此資料夾」），讓前端能顯示具體原因
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.detail) detail = j.detail;
    } catch {
      /* 非 JSON body → 用 HTTP 狀態碼 */
    }
    throw new Error(detail);
  }
  return resp.json();
}

export const addRoot = (port: number, path: string, account: string) =>
  configWrite(port, "/api/config/roots", "POST", { path, account });
export const removeRoot = (port: number, path: string) =>
  configWrite(port, "/api/config/roots", "DELETE", { path });
export const setRootAccount = (port: number, path: string, account: string) =>
  configWrite(port, "/api/config/roots", "PATCH", { path, account });
export const addManualProject = (port: number, path: string, account: string) =>
  configWrite(port, "/api/config/manual", "POST", { path, account });
export const removeManualProject = (port: number, path: string) =>
  configWrite(port, "/api/config/manual", "DELETE", { path });
export const setProjectOverride = (port: number, path: string, account: string) =>
  configWrite(port, "/api/config/overrides", "PUT", { path, account });
export const clearProjectOverride = (port: number, path: string) =>
  configWrite(port, "/api/config/overrides", "DELETE", { path });

export async function onboard(
  port: number,
  roots: { path: string; default_account: string }[],
): Promise<AppConfigData> {
  const resp = await fetch(`${base(port)}/api/config/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ roots }),
  });
  if (!resp.ok) throw new Error(`onboard failed: ${resp.status}`);
  return resp.json();
}

export async function putSubscriptions(
  port: number,
  subs: SubscriptionItem[],
): Promise<AppConfigData> {
  return configWrite(port, "/api/config/subscriptions", "PUT", { subscriptions: subs });
}

// 設 KMS 根目錄：後端回 {ok, kms_root}（非 full config），故不走 configWrite；
// 沿用相同 auth headers / base(port) / JSON，並抽出 FastAPI detail 當錯誤訊息。
export async function putKmsRoot(port: number, path: string): Promise<{ ok: boolean; kms_root: string }> {
  const resp = await fetch(`${base(port)}/api/config/kms-root`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.detail) detail = j.detail;
    } catch {
      /* 非 JSON body → 用 HTTP 狀態碼 */
    }
    throw new Error(detail);
  }
  return resp.json();
}

// ── 備份 ──────────────────────────────────────────────────────────────────────

export interface BackupBundle {
  name: string;
  created_ts: number;   // 秒；取自檔名時間戳而非 mtime（檔案被搬動時 mtime 會變）
  size_bytes: number;
}

export interface BackupStatus {
  configured: boolean;
  backup_dir: string;   // raw（含 ~），未設定時為空字串
  dir_status: "dir" | "missing" | "not_dir" | "denied";
  /** `invalid` 只出現在這條 wire 契約上（設定檔被手動塞了相對路徑），
   *  不是後端 `check_backup_dir()` 的回傳值之一 */
  containment: "ok" | "inside_source" | "is_home" | "is_root" | "invalid";
  script_available: boolean;
  /** 還原腳本是另一個檔案：打包漏收它時「備份可用、還原不可用」，所以旗標分開 */
  restore_script_available: boolean;
  python3_available: boolean;
  bundles: BackupBundle[];              // 倒序（新到舊）
  last_backup_ts: number | null;        // 從未備份為 null
  days_since: number | null;            // 本地時區的日曆日差；從未備份為 null（不是 0）
  /** 有比最新備份包還新的 .partial 殘骸＝上一次沒跑完。**不阻斷任何操作**——
   *  使用者要做的正是再按一次備份 */
  last_attempt_failed: boolean;
}

/** 備份端點的判別碼錯誤。理由同 `SetupError`：`code` 只放欄位、不進 message，
 *  否則 `String(e)` 會讓後端判別碼繞過 i18n 直接出現在畫面上。 */
export class BackupError extends Error {
  constructor(public readonly code: string | null, public readonly status: number) {
    super(`backup request failed: ${status}`);
    this.name = "BackupError";
  }
}

export async function fetchBackupStatus(port: number): Promise<BackupStatus> {
  const resp = await fetch(`${base(port)}/api/backup/status`, { headers: authHeaders() });
  if (!resp.ok) throw new BackupError(await readErrorCode(resp), resp.status);
  return resp.json();
}

// 這支回的是 `{"error": code}`（不是 kms-root 那種 `detail` prose）：判別碼要能被 i18n
// 映射，不能是後端寫死的中文（CLAUDE.md §4.6.13）。
export async function putBackupDir(
  port: number,
  path: string,
): Promise<{ ok: boolean; backup_dir: string }> {
  const resp = await fetch(`${base(port)}/api/config/backup-dir`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new BackupError(await readErrorCode(resp), resp.status);
  return resp.json();
}

// --- 還原（安全權威在後端 backup/restore.py；本層只轉送名字與位置）---

/** 展開位置的判定。以 union 承接後端的 `DestVerdict`，讓「後端新增一種狀態」在前端的
 *  映射表上編譯失敗，而不是靜默掉到某個 fallback 文案。 */
export type RestoreDestStatus =
  | "ok" | "is_root" | "is_home" | "inside_source" | "not_empty" | "not_dir" | "denied";

export interface RestorePlan {
  // 送什麼回什麼：名字模式回名字、路徑模式回絕對路徑。前端拿它比對「換了包之後舊 plan
  // 還在 state 裡」（還原卡的既有不變式）。
  bundle: string;
  dest: string;                  // 絕對路徑（未指定時是後端算的預設位置）
  dest_status: RestoreDestStatus;
}

/** 備份包摘要。`project_count` 只數 `projects/` 的目錄數，**會比 `paths` 頁列出的筆數多**
 *  ——後者跳過讀不出 `cwd` 的專案（無從對應）。兩者語意不同，文案要講清楚。 */
export interface BundleInfo {
  host: string;
  created: string;
  accounts: string[];
  extra: string[];
  project_count: number;
}

/** 還原端點的判別碼錯誤。理由同 `BackupError`：`code` 只放欄位、不進 message。 */
export class RestoreError extends Error {
  constructor(public readonly code: string | null, public readonly status: number,
              /** 409 `config_already_initialized` 時後端附上的來源摘要（票 15）。
               *  只在那一格有值——**不要拿它當「有沒有出錯」的判斷依據**。 */
              public readonly createdBy: ConfigCreatedBy | null = null) {
    super(`restore request failed: ${status}`);
    this.name = "RestoreError";
  }
}

/** 那份設定檔是誰建的（票 15）。後端純記帳、不參與授權——它存在的理由是讓「已經有一份
 *  config」這件事**說得出來源**，前端才不必靠落點對帳碰運氣（票 09 R3）。
 *  欄位全部選填：舊的 config.json 沒有這一欄，手編過的也可能只有一半。 */
export interface ConfigCreatedBy {
  source?: string;        // "onboard" | "adopt-config"
  request_id?: string;
  dest?: string;          // adopt-config：那一次確認用的展開位置
}

async function postRestorePlan(
  port: number,
  source: Record<string, string>,
  dest?: string,
): Promise<RestorePlan> {
  const body: Record<string, unknown> = { ...source };
  if (dest !== undefined) body.dest = dest;
  const resp = await fetch(`${base(port)}/api/restore/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new RestoreError(await readErrorCode(resp), resp.status);
  return resp.json();
}

/** 唯讀預覽：這份備份包會解到哪裡、那個位置能不能用。不動檔案系統。
 *  名字模式——後端拿它過 `list_bundles` 的 allowlist（還原卡走這條）。 */
export const restorePlan = (port: number, bundle: string, dest?: string) =>
  postRestorePlan(port, { bundle }, dest);

/** 同上，但來源是**使用者用系統檔案選擇器挑的絕對路徑**（移機，增補 spec §2.7）：
 *  新機器的備份包不可能在 `backup_dir` 裡，名字模式一律 `unknown_bundle`。
 *
 *  後端的兩個欄位是**二擇一**（都給或都不給皆 400）。這裡用兩支函式而不是一個帶
 *  `bundle?`／`bundlePath?` 的 options 物件——後者讓「同時給兩個」在型別上合法、
 *  只能等後端 400，前者在編譯期就不可能組出那個請求。 */
export const restorePlanForPath = (port: number, bundlePath: string, dest?: string) =>
  postRestorePlan(port, { bundle_path: bundlePath }, dest);

/** 一個落點的建議值。`suggested` 空字串＝**推不出來**（舊路徑不在舊 home 底下，或 manifest
 *  的路徑不合格）——欄位留空要求使用者自己填，不猜（spec §4.2.2 決策 9）。 */
export interface LandingSpot {
  key: string;
  kind: "account" | "extra";
  old_path: string;
  suggested: string;
  suggested_exists: boolean;
}

export interface LandingSuggestions {
  home: string;                  // 舊機 home；空字串＝manifest 的 home 不可用
  spots: LandingSpot[];
}

/** 落點建議值（增補 spec 缺口 7）：`targets` 頁靠它預填。唯讀。
 *  **回的每個位元組都不具授權效力**——授權是使用者送回 `adoptConfig` 的那一份。 */
export async function fetchLandingSuggestions(
  port: number, dest: string,
): Promise<LandingSuggestions> {
  const resp = await fetch(
    `${base(port)}/api/restore/landing-suggestions?dest=${encodeURIComponent(dest)}`,
    { headers: authHeaders() },
  );
  if (!resp.ok) throw new RestoreError(await readErrorCode(resp), resp.status);
  return resp.json();
}

export interface AdoptConfigBody {
  dest: string;
  /** 這一次確認的識別碼（票 15）。**同一次確認的重送要用同一個**——後端據此回既有結果
   *  （200）而不是 409，前端因此不必再用元件內的旗標推測「上一次到底寫進去了沒」。 */
  request_id: string;
  accounts: { key: string; config_dir: string }[];
  extra?: { name: string; path: string }[];
}

/** 用備份包重建 `config.json`（票 07 的端點、票 03 的呼叫端）。**落點是使用者的授權**：
 *  manifest 只產生建議值，送回去的這一份才算數（spec §4.2.2），server 全部重驗。
 *
 *  `roots` 一律送空陣列——移機分支此時還沒有工作根目錄的資料來源，那份在備份包的
 *  `fledge/config.json` 裡，由票 09 帶回（增補 spec §2.8.3）。這不是遺漏。 */
export async function adoptConfig(port: number, body: AdoptConfigBody): Promise<void> {
  const resp = await fetch(`${base(port)}/api/restore/adopt-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ roots: [], extra: [], ...body }),
  });
  if (resp.ok) return;
  // 409 帶著來源摘要（票 15）：**這一支要讀整個 body 而不只是 `error`**，否則呼叫端
  // 說不出「那份設定檔是從哪一包建的」——那是使用者唯一分得出來的線索。
  const payload = await readErrorPayload(resp);
  throw new RestoreError(payload.error, resp.status, payload.created_by ?? null);
}

/** `install-plan` 的預覽。**不是備份包內容的完整分類**（增補 spec §2.5.1）：symlink、
 *  特殊檔、未指定落點的帳號**完全不在這裡面**，所以數字不能說成「總共會搬 N 項」。
 *  後端還回了 install 用的身分欄位，前端只宣告顯示要用的。 */
export interface InstallPreview {
  targets: Record<string, string>;          // 已確認落點的帳號
  extra_targets: Record<string, string>;    // 已確認落點的 extra
  will_install: number;
  will_skip: string[];
  /** 目的地祖先被一般檔或連結占住 → 該子樹的葉檔**確定裝不到**。上游 spec 的四分類漏了它，
   *  不獨立顯示的話預覽總數會無聲縮水（增補 spec 缺口 4）。 */
  blocked: string[];
  /** **混合粒度**（install 路徑在用的既有欄位）：`.claude.json` 這種逐檔的，與未確認落點
   *  的 extra name。**顯示一律用下面兩個拆好的欄位**——用名稱從這個陣列反推粒度會在名稱
   *  碰撞時出錯（`.claude.json` 是合法的 extra name）。 */
  excluded: string[];
  excluded_files: string[];        // 逐檔的（`EXCLUDED_NAMES` 的頂層項）
  unconfirmed_extra: string[];     // 沒給落點、整項不搬的 extra name
  /** manifest 有、但沒給落點的帳號。**預覽的其餘欄位完全不會提到它們**，而這一欄與整份
   *  預覽出自**同一份快照**——前端拿較早的 `bundle-info` 做差集會誤報也會漏報。 */
  missing_accounts: string[];
  project_renames: Record<string, string>;
  unmapped_projects: { account: string; encoded_dir: string; cwd: string }[];
}

/** 唯讀預覽：這次安裝會裝什麼、跳過什麼、哪些確定裝不到。不動檔案系統。
 *  落點從**已落檔的 config.json** 讀，不由前端送（spec §4.2.2）。 */
export async function installPlan(
  port: number, dest: string, mapping: Record<string, string>,
): Promise<InstallPreview> {
  const resp = await fetch(`${base(port)}/api/restore/install-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      dest,
      mapping: Object.entries(mapping).map(([old, next]) => ({ old, new: next })),
    }),
  });
  if (!resp.ok) throw new RestoreError(await readErrorCode(resp), resp.status);
  return resp.json();
}

/** 上一輪移機收尾了沒（票 07，增補 spec §3.3.1）。**判定全在後端**——牽涉 journal 定位、
 *  bundle 形狀驗證與損壞容錯，前端不碰檔案系統。 */
export type MigrationState =
  | "none"                  // 沒有未完成的移機 → 卡片不顯示
  | "unfinished_unknown"    // 有未清除的 journal 但沒有續作資訊 → 說得出「沒完成」，不能續作
  | "stale_marker"          // 簿記殘骸，那一輪其實成功了 → 視同完成，不顯示
  | "source_missing"        // 展開的備份包已不在 → 引導重新選包，不能續作
  | "journal_unreadable"    // 簿記讀不出 → 不聲稱能安全續作
  | "resumable";            // 三個條件都成立 → 可以一鍵接續

export interface MigrationStatus {
  state: MigrationState;
  /** **只在 `resumable` 出現**：其餘狀態帶著它們，前端就可能拿一份不該用的續作資訊預填。 */
  source_root?: string;
  mapping?: { old: string; new: string }[];
}

/** 唯讀狀態查詢。任何 I/O 失敗在後端降級成某個 state，不回 5xx——還原卡每次開啟都會打它。 */
export async function fetchMigrationStatus(port: number): Promise<MigrationStatus> {
  const resp = await fetch(`${base(port)}/api/restore/migration-status`,
                           { headers: authHeaders() });
  if (!resp.ok) throw new RestoreError(await readErrorCode(resp), resp.status);
  return resp.json();
}

/** 一項安裝結果。`account` 是落點 key（帳號外資產用 `extra:<name>` 命名空間），
 *  `rel_path` 相對該落點；**落點層的失敗** `rel_path` 是空字串（整個帳號沒裝成）。
 *  `error` 是穩定判別碼，前端負責映成文案（CLAUDE.md §4.6.13）。 */
export interface InstallItemResult {
  account: string;
  rel_path: string;
  outcome: "installed" | "skipped" | "excluded" | "failed";
  error: string | null;
}

export interface InstallOutcome {
  results: InstallItemResult[];
  /** 前一輪硬中斷留在落點裡的暫存殘骸（絕對路徑）。**app 不代勞刪除**——判準全是可偽造
   *  的檔名特徵，達不到「只刪自己建的」這條底線，只把位置告訴使用者（增補 spec §4）。 */
  stale_temps: string[];
}

/** 實際安裝：**整條移機流程裡唯一會寫使用者現役目錄的呼叫**，不可逆。
 *
 *  server 以相同輸入重算 plan（ADR-0002），落點只來自已落檔的 config.json——前端送的
 *  只有展開位置與專案路徑對應。 */
export async function runInstall(
  port: number, dest: string, mapping: Record<string, string>,
): Promise<InstallOutcome> {
  const resp = await fetch(`${base(port)}/api/restore/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      dest,
      mapping: Object.entries(mapping).map(([old, next]) => ({ old, new: next })),
    }),
  });
  if (!resp.ok) throw new RestoreError(await readErrorCode(resp), resp.status);
  return resp.json();
}

/** 備份包裡的一個專案。`suggested` 空字串＝推不出新位置（舊路徑不在舊 home 底下，
 *  或 manifest／歷史檔的路徑不合格）——**留空即照搬**，不猜。 */
export interface ProjectPath {
  account: string;
  old_path: string;
  encoded_dir: string;
  suggested: string;
  suggested_exists: boolean;
}

/** 備份包裡每個專案的舊路徑與建議新路徑（票 06 的端點、票 04 的呼叫端）。唯讀。
 *
 *  **筆數會比 `BundleInfo.project_count` 少**：後者只數 `projects/` 的目錄，這裡會跳過
 *  讀不出 `cwd` 的專案（無從對應）。兩個數字不同是預期的，文案要講清楚。 */
export async function fetchProjectPaths(port: number, dest: string): Promise<ProjectPath[]> {
  const resp = await fetch(
    `${base(port)}/api/restore/project-paths?dest=${encodeURIComponent(dest)}`,
    { headers: authHeaders() },
  );
  if (!resp.ok) throw new RestoreError(await readErrorCode(resp), resp.status);
  return (await resp.json()).projects;
}

/** 備份包摘要（增補 spec 缺口 1）：展開之後讓使用者確認「這是不是我要的那一包」。唯讀。 */
export async function fetchBundleInfo(port: number, dest: string): Promise<BundleInfo> {
  const resp = await fetch(
    `${base(port)}/api/restore/bundle-info?dest=${encodeURIComponent(dest)}`,
    { headers: authHeaders() },
  );
  if (!resp.ok) throw new RestoreError(await readErrorCode(resp), resp.status);
  return resp.json();
}

export const addAccount = (port: number, key: string, config_dir: string, label: string) =>
  configWrite(port, "/api/config/accounts", "POST", { key, config_dir, label });
export const setAccountConfigDir = (port: number, key: string, config_dir: string) =>
  configWrite(port, `/api/config/accounts/${encodeURIComponent(key)}`, "PATCH", { config_dir });
export const setAccountLabel = (port: number, key: string, label: string) =>
  configWrite(port, `/api/config/accounts/${encodeURIComponent(key)}`, "PATCH", { label });
export const removeAccount = (port: number, key: string, reassignTo?: string) =>
  configWrite(port, `/api/config/accounts/${encodeURIComponent(key)}`, "DELETE", { reassign_to: reassignTo });

export async function checkDir(port: number, path: string): Promise<DirStatus> {
  const resp = await fetch(`${base(port)}/api/config/check-dir`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`checkDir failed: ${resp.status}`);
  return (await resp.json()).status as DirStatus;
}

// 列單層目錄（lazy 檔案樹）。HTTP !ok（400 invalid / 403 forbidden / 5xx）throw；
// HTTP 200 即使 status ∈ {denied,missing,not_dir} 也不 throw、回 status 供節點就地提示（design §7.2 L2）。
export async function fetchDirTree(port: number, path: string): Promise<DirTreeResult> {
  const resp = await fetch(`${base(port)}/api/projects/tree`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`fetchDirTree failed: ${resp.status}`);
  return (await resp.json()) as DirTreeResult;
}

// --- usage dashboard（design §10）---
export interface UsageDashboard {
  kpi: {
    month_value: number;
    week_value: number;
    today_value: number;
    claude_cache_hit_rate: number | null;
    codex_cache_hit_rate: number | null;
    net_roi: number;
    subscriptions_total: number;
  };
  daily: { date: string; by_model: Record<string, number>; total: number }[];
  models: {
    model: string;
    source: string;
    input: number;
    output: number;
    cache_read: number;
    cache_create: number;
    cost: number;
  }[];
  projects: {
    path: string;
    claude_cost: number;
    codex_cost: number;
    total: number;
    last_active: number;
  }[];
  hourly: number[][];
  scan_meta: {
    state: "ok" | "scanning" | "error";
    generation?: number;
    missing_pricing: string[];
    error?: string | null;
    cold_scan_ms?: number;
    days?: number;
    sources?: Record<string, string>;
  };
}

/** 202（首掃）回 null；200 但無 kpi（冷啟掃描失敗的 error-only 形狀）throw 帶後端訊息；
 *  其餘錯誤 throw（呼叫端保留舊資料顯示 stale）。 */
export async function fetchUsageDashboard(
  port: number,
  days = 30,
): Promise<UsageDashboard | null> {
  const resp = await fetch(`${base(port)}/usage/dashboard?days=${days}`, {
    headers: authHeaders(),
  });
  if (resp.status === 202) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json();
  // 防 error-only 200 炸 React 樹（後端掃描失敗仍回 200 但無 kpi）
  if (!j.kpi) throw new Error(j?.scan_meta?.error ?? "scan failed");
  return j;
}

// --- Codex 實時額度（獨立端點；節奏由前端控制，design：開啟即抓/15min/重開強制重抓）---
export interface CodexUsageWindow {
  used_percent: number;
  window_minutes: number | null;
  resets_at: number | null;
}
export interface CodexUsage {
  source: "live" | "unavailable";
  observed_at: number | null;
  failure_reason?: "no_auth" | "unauthorized" | "network" | "bad_response";
  plan_type?: string | null;
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
}

export async function fetchCodexUsage(port: number): Promise<CodexUsage> {
  const resp = await fetch(`${base(port)}/usage/codex`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as CodexUsage;
}

// ── 記憶層 ──
export interface MemoryItem {
  source: "native" | "kms";
  scope: "global" | "project" | "kb" | "unknown";
  path: string; title: string; type: string; summary: string;
  tags: string[]; status: string; links: string[]; mtime: number;
  account?: string; project?: string; attribution?: string; domain?: string;
  topic?: string; snippet?: string;        // topic folder（kms）/ 搜尋命中片段
}
export interface MemorySuggestion { project: string; topic: string; project_name?: string; topic_name?: string; }
export interface MemoryProject { project: string; items: MemoryItem[]; related: string[]; suggestions: MemorySuggestion[]; }
export interface MemoryOverview {
  global: MemoryItem[]; projects: MemoryProject[]; kb: MemoryItem[];
  unattributed: MemoryItem[]; unknown: MemoryItem[];           // 三態/unknown 可見
  scan_meta: { total: number; unknown_count: number; unattributed_count: number };
}
export interface MemoryRelated { project: string; related: string[]; suggestions: MemorySuggestion[]; }

// auth 用法沿用既有：authHeaders() 回 Record<string,string>，GET 放在 { headers }，
// JSON write 放在 headers 內展開；URL 走既有 base(port) 而非硬編。
export async function fetchMemoryOverview(port: number, q: string): Promise<MemoryOverview> {
  const r = await fetch(`${base(port)}/memory/overview?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
  const j = await r.json();
  if (!Array.isArray(j.projects)) throw new Error("bad memory overview");
  return j as MemoryOverview;
}
export async function fetchMemoryRelated(port: number, project: string): Promise<MemoryRelated> {
  const r = await fetch(`${base(port)}/memory/related?project=${encodeURIComponent(project)}`, { headers: authHeaders() });
  return (await r.json()) as MemoryRelated;
}
export async function fetchMemoryItem(port: number, path: string): Promise<{ path: string; title: string; body: string }> {
  const r = await fetch(`${base(port)}/memory/item?path=${encodeURIComponent(path)}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`memory item ${r.status}`);   // 讓詳情面板能顯示載入失敗
  return await r.json();
}
async function memoryJson(port: number, route: string, method: "POST" | "DELETE", body: object): Promise<void> {
  const r = await fetch(`${base(port)}/memory/${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },   // token 在 headers 內
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`memory ${route} ${r.status}`);   // 寫入失敗 throw 讓右欄 chip 顯示錯誤
}
export const confirmSuggestion = (p: number, project: string, topic: string) => memoryJson(p, "links/confirm", "POST", { project, topic });
export const dismissSuggestion = (p: number, project: string, topic: string) => memoryJson(p, "links/dismiss", "POST", { project, topic });
export const addMemoryLink = (p: number, from: string, to: string, note = "") => memoryJson(p, "links", "POST", { from, to, note });
export const removeMemoryLink = (p: number, from: string, to: string) => memoryJson(p, "links", "DELETE", { from, to });

// ===== 待辦面板（tasks；design §7）=====

export type TasksStatus = "ok" | "absent" | "unavailable";

export interface TasksProjectRow {
  path: string;
  name: string;
  account: string;
  /** 未完成條數。tasks_status !== "ok" 時為 null——「讀不到」不可畫成 0（design §6.3） */
  unfinished: number | null;
  tasks_status: TasksStatus;
  /** 該專案 .fledge/state.md 前 20 行抽出的「下一步」；沒有就是空字串 */
  next_step: string;
}

export interface TaskRow {
  name: string;
  /** 檔名前綴的編號（唯一真相源）。沒有數字前綴時為 null，該票會帶 number_missing */
  number: number | null;
  title: string;
  status: "todo" | "doing" | "done";
  source: string;        // "me" | "ai"；判不出來為空字串
  created: string;       // YYYY-MM-DD；判不出來為空字串
  /** 異常代碼（英文），由前端 i18n 映射成畫面文字。有值不代表要隱藏這張票 */
  anomalies: string[];
  fingerprint: string;
}

export interface TasksListResponse {
  project: string;
  tasks_status: TasksStatus;
  /** 讀不到時是 null 而不是空清單：空清單與「這個專案沒待辦」在畫面上長得一樣（design §6.3） */
  tasks: TaskRow[] | null;
  next_step: string;
}

export interface TasksOverview {
  projects: TasksProjectRow[];
  permission_error: boolean;
}

/** 第一層總覽：每個已知專案的未完成條數 ＋ tasks_status。 */
export async function fetchTasksOverview(port: number): Promise<TasksOverview> {
  const resp = await fetch(`${base(port)}/tasks/overview`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`fetchTasksOverview failed: ${resp.status}`);
  return (await resp.json()) as TasksOverview;
}

/** 第二層：單一專案的票列表（含異常標記與 fingerprint）。 */
export async function fetchTasks(port: number, project: string): Promise<TasksListResponse> {
  const resp = await fetch(`${base(port)}/tasks?project=${encodeURIComponent(project)}`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`fetchTasks failed: ${resp.status}`);
  return (await resp.json()) as TasksListResponse;
}

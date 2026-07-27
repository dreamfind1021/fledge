import { invoke } from "@tauri-apps/api/core";

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
 * 預設 30s：PyInstaller onefile sidecar 在 Tauri（dev、unsigned）下被 spawn 後
 * 約需 ~15s 才 listening（疑 macOS 對 unsigned binary 的驗證；直接 spawn 僅 ~5s）。
 * Plan 05 簽名/打包後啟動可縮短，屆時再調回較短上限。
 */
export async function waitForSidecarPort(maxWaitMs = 30000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const port = await invoke<number | null>("sidecar_port");
    if (port != null) return port;
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

export type SessionKind = "claude" | "terminal" | "install" | "login";

export interface CreateSessionOptions {
  // 工作目錄兼歸屬標記。install 沒有所屬專案（後端固定跑在 home、只把它當 project_path 記錄），
  // 故傳空字串——不是漏填。
  path: string;
  account?: string;                     // install 不傳：後端不驗帳號、也不注入帳號 env
  kind?: SessionKind;
  installId?: string;                   // kind=install 必填；後端據此查 TOOL_SPECS 取命令
  loginTarget?: "claude" | "codex";     // kind=login 用
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
  try {
    return (await resp.json())?.error ?? null;
  } catch {
    return null;
  }
}

export async function createSession(port: number, opts: CreateSessionOptions): Promise<string> {
  const { path, account, kind = "claude", installId, loginTarget } = opts;
  // 安全不變式（spec §5）：body 只放 allowlist key（install_id），永遠不含命令字串。
  // 未給的欄位一律不放進 body——後端 extra="forbid" 只擋未知欄位，但少送等於用後端預設，
  // 也讓「安裝不帶 account」這件事在 wire 上看得出來。
  const body: Record<string, unknown> = { path, kind };
  if (account !== undefined) body.account = account;
  if (installId !== undefined) body.install_id = installId;
  if (loginTarget !== undefined) body.login_target = loginTarget;

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

export interface AppConfigData {
  version: number;
  roots: { path: string; default_account: string }[];
  accounts: Record<string, { config_dir: string; label: string }>;
  manual_projects: { path: string; account: string }[];
  project_overrides: Record<string, { account: string }>;
  ui: { theme: string };
  // 後端 to_dict 總是回傳；標選用是為相容舊前端快取（無此欄視為未設），讀取端一律 ?? "" 兜底
  kms_root?: string;  // KMS（Obsidian 知識庫）根目錄，raw 含 ~；未設為空字串
  subscriptions?: SubscriptionItem[];  // 後端 to_dict 總是回傳此欄；舊前端快取若無此欄視為空陣列
  // startup-only metadata：僅 GET /api/config 與 onboard 回應帶（設定檔不存在為 true）。
  // 其他 config write 不帶 → 寫入後此欄位為 undefined 屬正常；只在 App 啟動讀一次決定是否進
  // onboarding，之後改用獨立的 showOnboarding state，勿用於 render gate（Codex F-7）。
  is_first_run?: boolean;
}

export async function fetchConfig(port: number): Promise<AppConfigData> {
  const resp = await fetch(`${base(port)}/api/config`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`fetchConfig failed: ${resp.status}`);
  return resp.json();
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

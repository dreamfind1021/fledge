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

export async function createSession(
  port: number,
  path: string,
  account: string,
  kind: "claude" | "terminal" = "claude",
): Promise<string> {
  const resp = await fetch(`${base(port)}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path, account, kind }),
  });
  if (!resp.ok) throw new Error(`createSession failed: ${resp.status}`);
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
export interface UsageBlock {
  start_ts: number;
  end_ts: number;
  is_gap: boolean;
  is_active: boolean;
  total_tokens: number;
  cost: number;
  burn_rate_tpm: number | null;
  projection: number | null;
}

export interface UsageDashboard {
  kpi: {
    month_value: number;
    week_value: number;
    today_value: number;
    cache_hit_rate: number;
    net_roi: number;
    subscriptions_total: number;
  };
  blocks: {
    claude: { active: UsageBlock | null; recent: UsageBlock[]; limit_p90: number | null };
    codex: {
      primary?: { used_percent: number; window_minutes: number; resets_at: number };
      secondary?: { used_percent: number; window_minutes: number; resets_at: number };
      plan_type?: string;
    };
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

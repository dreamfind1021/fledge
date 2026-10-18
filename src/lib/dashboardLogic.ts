// 面板邏輯純函式（design §11）——元件只負責渲染，邏輯在此測試
import type { CodexUsageWindow, UsageDashboard } from "./sidecar";

// ── 模型排名：模型分布與每日成本共用（票 46，spec §4.5）──
// 每日成本的色段、圖例與模型分布的長條都照這個名次取色：前 4 名各一色、第 5 名以後灰。
// 模型分布的填充色另寫在 Dashboard.css 的 .dash-mbar-fill.is-r0～4（淡化版，測試讀得到），順序要跟這裡一致（Dashboard.style.test.ts 守）
export const MODEL_COLORS = ["var(--primary)", "var(--ai)", "var(--session)", "var(--warning)", "var(--faint)"];

export interface ModelPart { model: string; cost: number }
export interface ModelRanking {
  order: string[];     // 全部模型名稱：金額由大到小，同額照名稱
  top: ModelPart[];    // 前 4 名
  rest: ModelPart[];   // 第 5 名以後（金額為 0 的也在：缺定價的模型成本是 0，不能被藏掉）
  total: number;
}

/** sidecar 的 models 以「模型＋來源」分列、每日成本的 by_model 只以名稱合計：先依名稱合併，兩張圖的名次與顏色才對得上 */
export function rankModels(models: { model: string; cost: number }[]): ModelRanking {
  const byName = new Map<string, number>();
  models.forEach((m) => byName.set(m.model, (byName.get(m.model) ?? 0) + m.cost));
  const sorted = [...byName.entries()].map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return { order: sorted.map((p) => p.model), top: sorted.slice(0, 4), rest: sorted.slice(4),
           total: sorted.reduce((s, p) => s + p.cost, 0) };
}

/** MODEL_COLORS 的序號：前 4 名 0～3，第 5 名以後與排名裡沒有的都是 4 */
export const colorIndex = (ranking: ModelRanking, model: string) => {
  const i = ranking.order.indexOf(model);
  return i < 0 || i > 3 ? 4 : i;
};

// ── 專案表：暫存資料夾合併成一列（票 46，spec §4.1）──
type ProjectUsage = UsageDashboard["projects"][number];
/** tempPaths 有值＝合併列（被合併的完整路徑，照原本的順序）；合併列的 path 是空字串，畫面一律看 tempPaths */
export type ProjectRow = ProjectUsage & { tempPaths?: string[] };

// macOS 的系統暫存區：Claude Code 的 scratchpad 在 /private/tmp/claude-<uid>/，$TMPDIR 在 /var/folders/
const TEMP_ROOTS = ["/private/tmp/", "/tmp/", "/private/var/folders/", "/var/folders/"];
export const isTempPath = (path: string) => TEMP_ROOTS.some((root) => path.startsWith(root));

/** 三欄加總、最後活動取最晚，跟其他列一起照合計由大到小排；沒有暫存資料夾就原樣回傳 */
export function mergeTempProjects(projects: ProjectUsage[]): ProjectRow[] {
  const temp = projects.filter((p) => isTempPath(p.path));
  if (temp.length === 0) return projects;
  const sum = (pick: (p: ProjectUsage) => number) => temp.reduce((s, p) => s + pick(p), 0);
  const merged: ProjectRow = {
    path: "", claude_cost: sum((p) => p.claude_cost), codex_cost: sum((p) => p.codex_cost), total: sum((p) => p.total),
    last_active: Math.max(...temp.map((p) => p.last_active)), tempPaths: temp.map((p) => p.path),
  };
  return [...projects.filter((p) => !isTempPath(p.path)), merged].sort((a, b) => b.total - a.total);
}

// ── Codex 額度：時間進度線與「用太快」（票 46，spec §4.3、§8）──
/** 窗口的時間過了多少（0～100）。全部用 epoch 秒（resets_at 是秒，Date.now() 是毫秒、呼叫端先除以 1000）。
 *  缺資料、不是有限正數、或已到／已過重置時間回 null＝不畫線：Codex 額度 15 分鐘才重抓一次，
 *  重置後手上還是重置前的資料，畫出來會是 100%（而且多半是黃的），兩者都是錯的 */
export function windowElapsedPct(win: Pick<CodexUsageWindow, "window_minutes" | "resets_at">, nowSec: number): number | null {
  const { window_minutes: minutes, resets_at: resetsAt } = win;
  if (minutes == null || resetsAt == null || !Number.isFinite(minutes) || !Number.isFinite(resetsAt) || minutes <= 0) return null;
  if (resetsAt <= nowSec) return null;
  return Math.min(100, Math.max(0, (1 - (resetsAt - nowSec) / (minutes * 60)) * 100));
}

// 用量比時間進度多 10 個百分點以上才算用太快：照字面「超過就算」的話，剛重置時一用就黃（使用者 2026-10-18 選定）
const AHEAD_MARGIN = 10;
export const isAheadOfPace = (usedPct: number, elapsedPct: number | null) =>
  elapsedPct != null && usedPct - elapsedPct >= AHEAD_MARGIN;

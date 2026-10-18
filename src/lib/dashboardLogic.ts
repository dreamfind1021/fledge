// 面板邏輯純函式（design §11）——元件只負責渲染，邏輯在此測試
import type { CodexUsageWindow, UsageDashboard } from "./sidecar";

export interface DonutPart { label: string; cost: number; fromDeg: number; toDeg: number }

export function donutParts(models: { model: string; cost: number }[]): DonutPart[] {
  if (models.length === 0) return [];
  const top = models.slice(0, 4).map((m) => ({ label: m.model, cost: m.cost }));
  const rest = models.slice(4).reduce((s, m) => s + m.cost, 0);
  const parts = rest > 0 ? [...top, { label: "…", cost: rest }] : top;
  const total = Math.max(1e-9, parts.reduce((s, p) => s + p.cost, 0));
  let acc = 0;
  return parts.map((p) => {
    const fromDeg = (acc / total) * 360;
    acc += p.cost;
    return { ...p, fromDeg, toDeg: (acc / total) * 360 };
  });
}

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

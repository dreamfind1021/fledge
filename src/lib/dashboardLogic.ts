// 面板邏輯純函式（design §11）——元件只負責渲染，邏輯在此測試
import type { UsageDashboard } from "./sidecar";

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

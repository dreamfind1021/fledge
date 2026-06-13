// 記憶面板純函式：把 overview payload 轉成可呈現的 group 視圖、facet 過濾、selection 有效性。
import type { MemoryOverview, MemoryItem, MemorySuggestion } from "./sidecar";

export type GroupKind = "global" | "project" | "kb" | "unattributed" | "unknown";

export interface MemoryGroupVM {
  key: string;                       // 唯一鍵：global | proj:<path> | kb | unattributed | unknown
  kind: GroupKind;
  projectKey?: string;               // kind==="project" 時的專案路徑
  items: MemoryItem[];
  related?: string[];                // 專案 only
  suggestions?: MemorySuggestion[];  // 專案 only
}

// 空陣列＝該維度不過濾；source: native/kms；type: native 用 it.type、kms 用 it.domain
export interface Facet { source: string[]; type: string[]; }

export type Selection =
  | { kind: "item"; path: string; groupKey: string }
  | { kind: "project"; projectKey: string }
  | null;

export function buildGroups(o: MemoryOverview): MemoryGroupVM[] {
  const g: MemoryGroupVM[] = [];
  if (o.global.length) g.push({ key: "global", kind: "global", items: o.global });
  for (const p of o.projects) {
    g.push({ key: `proj:${p.project}`, kind: "project", projectKey: p.project,
      items: p.items, related: p.related, suggestions: p.suggestions });
  }
  if (o.kb.length) g.push({ key: "kb", kind: "kb", items: o.kb });
  if (o.unattributed.length) g.push({ key: "unattributed", kind: "unattributed", items: o.unattributed });
  if (o.unknown.length) g.push({ key: "unknown", kind: "unknown", items: o.unknown });
  return g;
}

export function defaultExpanded(groups: MemoryGroupVM[]): Set<string> {
  return new Set(groups.filter(g => g.kind === "project").map(g => g.key));
}

function typeToken(it: MemoryItem): string {
  return it.source === "kms" ? (it.domain || "") : (it.type || "");
}

export function matchesFacet(it: MemoryItem, f: Facet): boolean {
  if (f.source.length && !f.source.includes(it.source)) return false;
  if (f.type.length && !f.type.includes(typeToken(it))) return false;
  return true;
}

export function visibleItems(items: MemoryItem[], f: Facet): MemoryItem[] {
  return items.filter(it => matchesFacet(it, f));
}

// facet 套用後：過濾各 group 的 items，丟掉變空的 group（selection 有效性不走這個——見 selectionValid）
export function applyFacet(groups: MemoryGroupVM[], f: Facet): MemoryGroupVM[] {
  return groups
    .map(g => ({ ...g, items: visibleItems(g.items, f) }))
    .filter(g => g.items.length > 0);
}

// refetch 後判定 selection 是否仍指向存在的資料（用完整 buildGroups 結果，不受 facet 影響）。
// item：以 path 存在於「任一」group 為準（同 path fan-out 到多 group 也算；groupKey 只用於 active 高亮、不影響存在性，
// 故 confirm 後 item 換 group 仍視為存在）。呼叫端只在 q 空時才據此清除（q 非空時的「不在 overview」是被搜尋濾掉、非真的沒了）。
export function selectionValid(sel: Selection, groups: MemoryGroupVM[]): boolean {
  if (!sel) return false;
  if (sel.kind === "project") {
    return groups.some(g => g.kind === "project" && g.projectKey === sel.projectKey);
  }
  return groups.some(g => g.items.some(it => it.path === sel.path));
}

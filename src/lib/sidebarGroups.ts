import type { Project } from "./sidecar";

// tab 以 (path, account) 識別（useAppStore openTab 去重）；sidebar 的「開啟中」用同一把 key。
// 用空格分隔——帳號代號（^[A-Za-z0-9_-]+$）不含空格，故 key 中最後一個空格必為界；path 可含空格不影響唯一性。
const SEP = " ";
export function tabKey(path: string, account: string): string {
  return `${path}${SEP}${account}`;
}

// 每個帳號群組「已接觸」band 直接顯示的最近專案上限；超出者併入「自動發現」收合區（不單獨列）。
export const RECENT_BAND_LIMIT = 3;

export interface AccountGroup {
  key: string; // 帳號代號（＝專案類型）
  label: string; // 顯示名（accounts[key].label，缺則退回 key）
  configDir: string; // accounts[key].config_dir；dangling 帳號為 ""
  total: number; // 本群組專案總數（三 band 相加）
  open: Project[]; // band 1：openInType 為真
  surfaced: Project[]; // band 2：最近 N 個 recent + 所有 manual（manual 不佔名額）
  discovered: Project[]; // band 3：自動發現收合（未接觸 root + 超出上限的 recent；recent 在前）
}

type AccountMeta = Record<string, { config_dir: string; label: string }>;

// band 2 排序：有 recent 者依 recent 降冪在前，recent==null（manual）依 name 升冪殿後
function byRecentDescThenName(a: Project, b: Project): number {
  if (a.recent != null && b.recent != null) return b.recent - a.recent || a.name.localeCompare(b.name);
  if (a.recent != null) return -1;
  if (b.recent != null) return 1;
  return a.name.localeCompare(b.name);
}

function byName(a: Project, b: Project): number {
  return a.name.localeCompare(b.name);
}

/**
 * 依專案的持久帳號（＝類型）分組。空群組不回傳；accounts 順序在前、dangling 帳號（不在
 * accounts 的 key）依首次出現序接後。openTabKeys 是開著的 tab 的 (path, account) 集合。
 */
export function groupProjectsByAccount(
  projects: Project[],
  openTabKeys: Set<string>,
  accounts: AccountMeta,
): AccountGroup[] {
  // 1. 依 project.account 分桶（Map 保留首次出現序，供 dangling 帳號排序）
  const buckets = new Map<string, Project[]>();
  for (const p of projects) {
    if (!buckets.has(p.account)) buckets.set(p.account, []);
    buckets.get(p.account)!.push(p);
  }

  // 2. 群組順序：accounts 既定順序（且有專案）在前，dangling 帳號接後
  const inAccounts = Object.keys(accounts).filter((k) => buckets.has(k));
  const dangling = [...buckets.keys()].filter((k) => !(k in accounts));
  const orderedKeys = [...inAccounts, ...dangling];

  // 3. 每群組分三 band 並排序
  const groups: AccountGroup[] = [];
  for (const key of orderedKeys) {
    const items = buckets.get(key)!;
    const open: Project[] = [];
    const surfaced: Project[] = [];
    const discovered: Project[] = [];
    for (const p of items) {
      if (openTabKeys.has(tabKey(p.path, p.account))) open.push(p);
      else if (p.recent != null || p.source === "manual") surfaced.push(p);
      else discovered.push(p); // 非 open、非 surfaced → 自動發現（recent==null 且非 manual，現況即 root）
    }
    open.sort(byName);
    surfaced.sort(byRecentDescThenName);
    // 上限切分：manual（釘選）永遠顯示、不佔名額；非 manual 的 recent 取前 N，其餘併入「自動發現」
    const manualItems = surfaced.filter((p) => p.source === "manual");
    const recentItems = surfaced.filter((p) => p.source !== "manual"); // recent != null
    const surfacedTop = [...recentItems.slice(0, RECENT_BAND_LIMIT), ...manualItems].sort(
      byRecentDescThenName,
    );
    // 自動發現＝未接觸 root + 超出上限的 recent；recent 降冪在前、未接觸依 name 殿後
    const discoveredAll = [...discovered, ...recentItems.slice(RECENT_BAND_LIMIT)].sort(
      byRecentDescThenName,
    );
    const meta = accounts[key];
    groups.push({
      key,
      label: meta?.label || key,
      configDir: meta?.config_dir ?? "",
      total: items.length,
      open,
      surfaced: surfacedTop,
      discovered: discoveredAll,
    });
  }
  return groups;
}

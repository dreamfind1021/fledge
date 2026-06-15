// 分頁順序純函式（可單測）：reorderTabs 供需求 1 拖曳排序、insertTabAdjacent 供需求 2 相鄰插入。
export function reorderTabs<T extends { id: string }>(tabs: T[], activeId: string, overId: string): T[] {
  if (activeId === overId) return tabs;
  const from = tabs.findIndex((t) => t.id === activeId);
  const to = tabs.findIndex((t) => t.id === overId);
  if (from === -1 || to === -1) return tabs; // 任一不存在：不動（防呆）
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// 需求 2：新 terminal 分頁插到「同 projectPath 分頁群的最後一個之後」，讓同專案分頁聚在一起。
// 找不到同專案分頁 → push 末端（與舊行為一致）。
export function insertTabAdjacent<T extends { projectPath: string }>(tabs: T[], newTab: T): T[] {
  let lastIdx = -1;
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i].projectPath === newTab.projectPath) lastIdx = i;
  }
  if (lastIdx === -1) return [...tabs, newTab];
  const next = tabs.slice();
  next.splice(lastIdx + 1, 0, newTab);
  return next;
}

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

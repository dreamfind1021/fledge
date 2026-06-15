// 終端機 imperative handle 旁路登錄（比照 activityTracker）：讓 App 的 dnd onDragEnd
// 找到 active 終端機貼路徑（需求 4）。entry 是物件 contract（design §8.3）。
export interface TerminalHandle {
  paste: (text: string) => void;
  isComposing: () => boolean; // 該終端機是否正在 IME 組字（§8.4 gate）
}

const registry = new Map<string, TerminalHandle>();

export function registerTerminal(tabId: string, handle: TerminalHandle): void {
  registry.set(tabId, handle);
}
export function unregisterTerminal(tabId: string): void {
  registry.delete(tabId);
}
export function getTerminal(tabId: string): TerminalHandle | undefined {
  return registry.get(tabId);
}

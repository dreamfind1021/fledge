// 工作區終端機的字級（票 50，spec docs/superpowers/specs/2026-11-02-terminal-font-zoom-design.md §4.1）。
// 照 theme.ts 的做法：選擇存在 localStorage、模組層的訂閱者集合通知已開著的終端機；所有工作區終端機共用一個值。
// 設置卡的內嵌終端機不讀這裡，固定用 TERM_FONT_SIZE_DEFAULT（spec N2）。

export const TERM_FONT_SIZE_DEFAULT = 13;
// 上下限只是讓連按之後不會變成讀不了的大小，不是排版保證：24 在小視窗只剩約 37 欄（spec §4.6）
export const TERM_FONT_SIZE_MIN = 10;
export const TERM_FONT_SIZE_MAX = 24;
const STORAGE_KEY = "fledge-term-font-size";

export type TermFontAction = "in" | "out" | "reset";

let current: number | null = null;   // 第一次有人讀的時候才讀 localStorage
const listeners = new Set<() => void>();

// 沒存過、看不懂、不是整數、超出範圍、讀不到 → 預設
const readStored = (): number => {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(n) && n >= TERM_FONT_SIZE_MIN && n <= TERM_FONT_SIZE_MAX ? n : TERM_FONT_SIZE_DEFAULT;
  } catch {
    return TERM_FONT_SIZE_DEFAULT;   // Storage 被停用：照樣開得起來，用預設
  }
};

export function getTermFontSize(): number {
  if (current === null) current = readStored();
  return current;
}

/** Cmd 加這個鍵是哪個字級動作；不是字級鍵回 null。`+` 是 Cmd+Shift+= */
export function termFontActionForKey(key: string): TermFontAction | null {
  if (key === "=" || key === "+") return "in";
  if (key === "-") return "out";
  if (key === "0") return "reset";
  return null;
}

/** 放大或縮小一級、或重設。值沒變（已在邊界、本來就是預設）就什麼都不做，也不通知。
 *  先通知再寫（同 setTheme）：寫失敗時這次仍生效，只是重開會忘記 */
export function applyTermFontAction(action: TermFontAction): void {
  const now = getTermFontSize();
  const next = action === "reset"
    ? TERM_FONT_SIZE_DEFAULT
    : Math.min(TERM_FONT_SIZE_MAX, Math.max(TERM_FONT_SIZE_MIN, now + (action === "in" ? 1 : -1)));
  if (next === now) return;
  current = next;
  for (const fn of listeners) fn();
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch (e) {
    console.warn("[termFontSize] 字級無法寫入 localStorage", e);
  }
}

/** 訂閱字級變化，回傳取消訂閱的函式。給 Terminal.tsx 用 */
export function onTermFontSizeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

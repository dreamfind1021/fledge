import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DEFAULT_THEME, THEME_STORAGE_KEY, isThemeId, type ThemeId } from "./themeIds";

// 主題切換（票 07，spec docs/planning/daylight-themes-design.md §4.3）。
// 選擇存在 localStorage（同語言設定的做法，src/i18n.ts）；沒存過、存了看不懂、讀不到 → 午夜藍。
// 啟動時 index.html 的內聯腳本已經先把存過的值寫進 <html data-theme>（避免先閃一下午夜藍，§4.2），
// 這裡的 initTheme() 再驗一次並同步原生視窗外觀。
export { THEMES, type ThemeId } from "./themeIds";

let current: ThemeId = DEFAULT_THEME;
const listeners = new Set<() => void>();

const readStored = (): ThemeId => {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;   // Storage 被停用：照樣開得起來，用預設
  }
};

// 套用的順序有意義：先換 data-theme，再通知訂閱者——終端機收到通知時讀 CSS 變數，
// 要讀到的是新主題的值（spec §4.5）
const apply = (id: ThemeId) => {
  current = id;
  document.documentElement.dataset.theme = id;
  // 原生視窗外觀（標題列等），午夜藍 dark、兩個淺色 light。非同步、失敗不擋畫面。
  // 不在 Tauri 裡（vitest、瀏覽器直接開 vite）時 getCurrentWindow() 會同步丟例外，一樣接住
  try {
    getCurrentWindow()
      .setTheme(id === "nightfall" ? "dark" : "light")
      .catch((e) => console.warn("[theme] 原生視窗外觀切換失敗", e));
  } catch (e) {
    console.warn("[theme] 不在 Tauri 裡，略過原生視窗外觀", e);
  }
  for (const fn of listeners) fn();
};

/** 啟動時呼叫一次（src/main.tsx，render 之前）：套用存過的主題，不寫回儲存 */
export function initTheme(): void {
  apply(readStored());
}

/** 使用者選主題：立刻生效、記住。先套用再寫（同 LangSwitch.tsx）：寫失敗時這次仍是想要的畫面，只是重開會忘記 */
export function setTheme(id: ThemeId): void {
  apply(id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch (e) {
    console.warn("[theme] 主題偏好無法寫入 localStorage", e);
  }
}

export const currentTheme = (): ThemeId => current;

/** 訂閱主題變化，回傳取消訂閱的函式。給不在 React 渲染週期裡的地方用（終端機） */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React 元件讀目前的主題（切換時重新渲染） */
export function useTheme(): ThemeId {
  return useSyncExternalStore(onThemeChange, currentTheme, currentTheme);
}

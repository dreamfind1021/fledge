// 主題的程式代號與儲存鍵（票 07，spec docs/planning/daylight-themes-design.md §4）。
// 唯一來源：src/lib/theme.ts 與測試都從這裡讀，不另外抄。
// 這個檔不 import 任何東西，讓測試工具（src/testing/cssRules.ts）可以放心引用。
export const THEMES = ["nightfall", "daylight-cool", "daylight-warm"] as const;
export type ThemeId = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeId = "nightfall";
export const THEME_STORAGE_KEY = "fledge-theme";
export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && (THEMES as readonly string[]).includes(v);

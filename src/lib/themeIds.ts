// 主題的程式代號與儲存鍵（票 07，spec docs/planning/daylight-themes-design.md §4）。
// 唯一來源：src/lib/theme.ts 與測試都從這裡讀，不另外抄。index.html 的啟動腳本只搬值、不驗證（§4.2），
// 它裡面的儲存鍵由 src/themeBootstrap.test.ts 比對跟這裡一致。
// 這個檔不 import 任何東西，讓測試工具（src/testing/cssRules.ts）可以放心引用。
export const THEMES = ["nightfall", "daylight-cool", "daylight-warm"] as const;
export type ThemeId = (typeof THEMES)[number];
// 每個主題自己標示深或淺（票 40，spec docs/superpowers/specs/2026-10-02-cocoa-iron-themes-design.md §4）：原生視窗外觀（theme.ts）與測試分組讀這張表。
// Record<ThemeId, …>：新增主題卻沒寫深淺會直接是 TypeScript 錯誤。index.css 每個區塊的 color-scheme 是同一件事的第二份，
// index.contrast.test.ts 比對兩邊一致
export const THEME_SCHEME: Record<ThemeId, "dark" | "light"> = {
  nightfall: "dark",
  "daylight-cool": "light",
  "daylight-warm": "light",
};
export const DEFAULT_THEME: ThemeId = "nightfall";
export const THEME_STORAGE_KEY = "fledge-theme";
export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && (THEMES as readonly string[]).includes(v);

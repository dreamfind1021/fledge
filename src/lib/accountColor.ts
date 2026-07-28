// 帳號標籤顏色：default/work/personal 維持既有藍/紫；其他帳號（Plan 03c 起可加任意代號）從 palette
// 以 key hash 穩定挑色——避免任意帳號都 fallback 成 work 藍色而無法區分。
// Sidebar 與 TabBar 共用此函式，消除原本兩處 hardcode ACCOUNT_COLOR 的重複。
// ⚠ 這是帳號色的唯一來源：色彩經 JS inline style 動態套用（dot/chip per-account），CSS 無法 per-account，
//   故 index.css 不再定義 --account-* token（已移除以免重複，見 brand Codex review）。
const WORK = "#60a5fa";
const PERSONAL = "#c084fc";
// 排除藍/紫，避免其他帳號撞到 work/personal 的色
const PALETTE = ["#4ade80", "#fbbf24", "#f472b6", "#22d3ee", "#a78bfa", "#fb923c", "#2dd4bf", "#e879f9"];

export function accountColor(account: string): string {
  // `default` 是票 31 起新使用者的預設帳號 key，扮演的角色與舊的 `work` 相同（第一個帳號），
  // 沿用同一個藍——側邊欄不因預設 key 換名而換色
  if (account === "work" || account === "default") return WORK;
  if (account === "personal") return PERSONAL;
  // 從 key 算穩定 hash → 同一帳號永遠同色、不同帳號分散到 palette
  let h = 0;
  for (let i = 0; i < account.length; i++) {
    h = (h * 31 + account.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

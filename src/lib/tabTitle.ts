import type { Tab } from "../store/useAppStore";

// claude 分頁同 (projectPath, account) 可開多個；標題加序號區分（第一個不加、第二個起 #2、#3）。
// 序號為「顯示用當前序」（render 時算、非固定 ID）：依當前 tabs 陣列順序的 1-based 位置；
// 關掉中間分頁後重算遞補。非 claude 分頁一律回 raw title（dashboard/memory 的顯示文案由呼叫端另接 i18n）。
export function displayTabTitle(tabs: Tab[], tab: Tab): string {
  if (tab.kind !== "claude") return tab.title;
  let ordinal = 0;
  for (const t of tabs) {
    if (t.kind === "claude" && t.projectPath === tab.projectPath && t.account === tab.account) {
      ordinal += 1;
      if (t.id === tab.id) break;
    }
  }
  return ordinal >= 2 ? `${tab.title} #${ordinal}` : tab.title;
}

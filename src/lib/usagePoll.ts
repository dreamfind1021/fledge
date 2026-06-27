// 輪詢 gating（design §11）：dashboard tab 為作用分頁、且視窗未隱藏才打 API
export function shouldPoll(s: { isActiveTab: boolean; documentHidden: boolean }): boolean {
  return s.isActiveTab && !s.documentHidden;
}

export const POLL_INTERVAL_MS = 30_000;
// Codex 實時額度：開著面板期間的重抓間隔（開啟即抓、重開強制重抓由 effect 觸發）。
// 額度窗口是 5 小時／7 天，秒級精度無意義；間隔長以對未公開端點客氣。
export const CODEX_USAGE_INTERVAL_MS = 15 * 60_000;

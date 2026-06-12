// 輪詢 gating（design §11）：dashboard tab 為作用分頁、且視窗未隱藏才打 API
export function shouldPoll(s: { isActiveTab: boolean; documentHidden: boolean }): boolean {
  return s.isActiveTab && !s.documentHidden;
}

export const POLL_INTERVAL_MS = 30_000;

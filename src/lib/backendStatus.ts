// backend health 狀態機（純函式，可單元測）。
// up：健康。suspect：1 次 fail（立即停 session 層重連、尚不顯 banner）。
// down：連 2 次 fail（顯 banner）。回 up 需連 2 次成功（up-hysteresis 防閃爍）。
// restarting：由重啟流程直接設定，不經本轉移函式。
export type BackendStatus = "up" | "suspect" | "down" | "restarting";

export interface BackendState {
  status: BackendStatus;
  okStreak: number; // 連續成功次數（for up-hysteresis）
}

export function nextBackendState(cur: BackendState, ok: boolean): BackendState {
  if (cur.status === "restarting") return cur; // restart 期間不由 poll 改
  if (ok) {
    const okStreak = cur.okStreak + 1;
    if (cur.status === "up") return { status: "up", okStreak };
    if (okStreak >= 2) return { status: "up", okStreak }; // suspect/down 回 up 需連 2 次
    return { status: cur.status, okStreak };
  }
  if (cur.status === "up") return { status: "suspect", okStreak: 0 };
  if (cur.status === "suspect") return { status: "down", okStreak: 0 };
  return { status: cur.status, okStreak: 0 }; // down 維持 down
}

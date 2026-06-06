// WS 重連策略（純函式，供 Terminal 用、可單元測）。
// 4001=session ended（claude 退出）、1008=無此 session → 不重連、走 ended。
export const MAX_RECONNECT_ATTEMPTS = 5;

const BACKOFF_MS = [1000, 2000, 4000, 8000, 8000];

export function shouldReconnect(code: number): boolean {
  return code !== 4001 && code !== 1008;
}

// 第 attempt 次（0-based）重連前的延遲；超過序列長度用最後一個值
export function nextDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

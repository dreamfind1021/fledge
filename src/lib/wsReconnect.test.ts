import { describe, it, expect } from "vitest";
import { shouldReconnect, nextDelay, MAX_RECONNECT_ATTEMPTS } from "./wsReconnect";

describe("wsReconnect", () => {
  it("4001/1008 不重連（session 已結束）", () => {
    expect(shouldReconnect(4001)).toBe(false);
    expect(shouldReconnect(1008)).toBe(false);
  });
  it("其他 code（網路異常）重連", () => {
    expect(shouldReconnect(1006)).toBe(true);
    expect(shouldReconnect(1001)).toBe(true);
  });
  it("backoff 序列遞增、最多 5 次", () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
    expect([0, 1, 2, 3, 4].map(nextDelay)).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
});

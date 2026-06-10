import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recordActivity, clearActivity, IDLE_MS, MIN_OUTPUT_BYTES } from "./activityTracker";
import { useAppStore } from "../store/useAppStore";

const spy = () => useAppStore.getState().setTabActivity as ReturnType<typeof vi.fn>;
const BIG = MIN_OUTPUT_BYTES; // 實質輸出（>= 閾值）
const SMALL = MIN_OUTPUT_BYTES - 1; // idle 游標心跳等小 chunk（< 閾值，應忽略）

describe("activityTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({ setTabActivity: vi.fn() }); // 以 mock 取代真 action，驗呼叫
  });
  afterEach(() => {
    clearActivity("t1");
    clearActivity("t2");
    vi.useRealTimers();
  });

  it("首次實質輸出 → setTabActivity(id,'working') 一次", () => {
    recordActivity("t1", BIG);
    expect(spy()).toHaveBeenCalledWith("t1", "working");
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  it("連續實質輸出（< IDLE_MS）只 working 一次（節流）", () => {
    recordActivity("t1", BIG);
    recordActivity("t1", BIG);
    recordActivity("t1", BIG);
    expect(spy().mock.calls.filter((c) => c[1] === "working")).toHaveLength(1);
  });

  it("靜置 IDLE_MS 後 → idle", () => {
    recordActivity("t1", BIG);
    vi.advanceTimersByTime(IDLE_MS);
    expect(spy()).toHaveBeenCalledWith("t1", "idle");
  });

  it("idle 後再實質輸出 → 重新 working", () => {
    recordActivity("t1", BIG);
    vi.advanceTimersByTime(IDLE_MS);
    spy().mockClear();
    recordActivity("t1", BIG);
    expect(spy()).toHaveBeenCalledWith("t1", "working");
  });

  it("小 chunk（< MIN_OUTPUT_BYTES）被忽略：不設 working、不排 timer", () => {
    recordActivity("t1", SMALL);
    expect(spy()).not.toHaveBeenCalled();
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(spy()).not.toHaveBeenCalled(); // 無 timer 可 fire
  });

  it("working 中只剩小心跳不續命：最後一次實質輸出後 IDLE_MS 仍轉 idle（解卡 working bug）", () => {
    recordActivity("t1", BIG); // t=0：working，timer 排在 t=IDLE_MS
    spy().mockClear();
    // 期間每 ~200ms 只有游標心跳（小 chunk），不應 reset idle timer。
    // 用 IDLE_MS 推導步數（非寫死），確保 IDLE_MS 調整時此測試仍成立。
    const HEARTBEAT_MS = 200;
    for (let elapsed = 0; elapsed < IDLE_MS; elapsed += HEARTBEAT_MS) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      recordActivity("t1", SMALL);
    }
    // 累計達 IDLE_MS → 原 timer fire（小心跳沒續命）
    expect(spy()).toHaveBeenCalledWith("t1", "idle");
  });

  it("clearActivity 重置 undefined 且後續 timer 不再 fire", () => {
    recordActivity("t1", BIG);
    clearActivity("t1");
    expect(spy()).toHaveBeenCalledWith("t1", undefined);
    spy().mockClear();
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(spy()).not.toHaveBeenCalled();
  });

  it("per-tab 隔離：clearActivity('t1') 不影響 t2（解 Codex plan R1）", () => {
    recordActivity("t1", BIG);
    recordActivity("t2", BIG);
    clearActivity("t1");
    spy().mockClear();
    vi.advanceTimersByTime(IDLE_MS);
    const calls = spy().mock.calls;
    expect(calls.some((c) => c[0] === "t2" && c[1] === "idle")).toBe(true);
    expect(calls.some((c) => c[0] === "t1")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { nextBackendState, type BackendState, type BackendStatus } from "./backendStatus";

const S = (status: BackendStatus, okStreak = 0): BackendState => ({ status, okStreak });

describe("backendStatus 狀態機", () => {
  it("up →1 fail→ suspect →再 fail→ down →fail→ 維持 down", () => {
    expect(nextBackendState(S("up", 3), false)).toEqual({ status: "suspect", okStreak: 0 });
    expect(nextBackendState(S("suspect"), false)).toEqual({ status: "down", okStreak: 0 });
    expect(nextBackendState(S("down"), false)).toEqual({ status: "down", okStreak: 0 });
  });
  it("回 up 需連 2 次成功（up-hysteresis）", () => {
    const a = nextBackendState(S("down", 0), true); // 第 1 次成功 → 仍 down
    expect(a).toEqual({ status: "down", okStreak: 1 });
    expect(nextBackendState(a, true)).toEqual({ status: "up", okStreak: 2 }); // 第 2 次 → up
  });
  it("up 持續成功維持 up", () => {
    expect(nextBackendState(S("up", 1), true)).toEqual({ status: "up", okStreak: 2 });
  });
  it("restarting 不被 poll 改", () => {
    expect(nextBackendState(S("restarting", 0), true)).toEqual(S("restarting", 0));
    expect(nextBackendState(S("restarting", 0), false)).toEqual(S("restarting", 0));
  });
});

import { describe, it, expect } from "vitest";
import { isLiveClaudeTab } from "./liveTab";
import type { Tab } from "../store/useAppStore";

const mk = (over: Partial<Tab>): Tab => ({
  id: "t", projectPath: "/p", account: "work", title: "p",
  sessionId: "s", status: "ready", kind: "claude", ...over,
});

describe("isLiveClaudeTab", () => {
  it("claude + ready + sessionId → true", () => {
    expect(isLiveClaudeTab(mk({}))).toBe(true);
  });
  it("terminal 一律 false（即使 ready+sessionId）", () => {
    expect(isLiveClaudeTab(mk({ kind: "terminal" }))).toBe(false);
  });
  it("非 ready → false", () => {
    expect(isLiveClaudeTab(mk({ status: "offline" }))).toBe(false);
    expect(isLiveClaudeTab(mk({ status: "ended", sessionId: null }))).toBe(false);
  });
  it("無 sessionId → false", () => {
    expect(isLiveClaudeTab(mk({ sessionId: null }))).toBe(false);
  });
});

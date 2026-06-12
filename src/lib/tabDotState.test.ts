import { describe, it, expect } from "vitest";
import { tabDotState } from "./tabDotState";
import type { Tab } from "../store/useAppStore";

const tab = (over: Partial<Tab>): Tab => ({
  id: "t", projectPath: "/p", account: "work", title: "p", sessionId: "s", status: "ready", kind: "claude", ...over,
});

describe("tabDotState", () => {
  it("creating → connecting", () => expect(tabDotState(tab({ status: "creating" }))).toBe("connecting"));
  it("offline → offline", () => expect(tabDotState(tab({ status: "offline" }))).toBe("offline"));
  it("ended → ended", () => expect(tabDotState(tab({ status: "ended" }))).toBe("ended"));
  it("error → error", () => expect(tabDotState(tab({ status: "error" }))).toBe("error"));
  it("ready + working → working", () => expect(tabDotState(tab({ status: "ready", activity: "working" }))).toBe("working"));
  it("ready + idle → waiting", () => expect(tabDotState(tab({ status: "ready", activity: "idle" }))).toBe("waiting"));
  it("ready + undefined → waiting（尚未觀測到 bytes）", () => expect(tabDotState(tab({ status: "ready" }))).toBe("waiting"));
  it("status 優先於 activity：offline + activity=working 仍 offline", () =>
    expect(tabDotState(tab({ status: "offline", activity: "working" }))).toBe("offline"));
});

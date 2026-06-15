import { describe, it, expect } from "vitest";
import { registerTerminal, unregisterTerminal, getTerminal } from "./terminalRegistry";

describe("terminalRegistry", () => {
  it("register 後可取得 handle", () => {
    const h = { paste: () => {}, isComposing: () => false };
    registerTerminal("t1", h);
    expect(getTerminal("t1")).toBe(h);
  });
  it("unregister 後取不到", () => {
    registerTerminal("t2", { paste: () => {}, isComposing: () => false });
    unregisterTerminal("t2");
    expect(getTerminal("t2")).toBeUndefined();
  });
  it("重複 register 覆蓋", () => {
    const h2 = { paste: () => {}, isComposing: () => true };
    registerTerminal("t3", { paste: () => {}, isComposing: () => false });
    registerTerminal("t3", h2);
    expect(getTerminal("t3")).toBe(h2);
  });
});

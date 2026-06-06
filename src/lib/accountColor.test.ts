import { describe, it, expect } from "vitest";
import { accountColor } from "./accountColor";

describe("accountColor", () => {
  it("work/personal 維持既有藍/紫", () => {
    expect(accountColor("work")).toBe("#60a5fa");
    expect(accountColor("personal")).toBe("#c084fc");
  });

  it("其他帳號顏色穩定（同 key 同色）且不 fallback 成 work 藍色", () => {
    const c = accountColor("team");
    expect(accountColor("team")).toBe(c); // 穩定
    expect(c).not.toBe("#60a5fa"); // 不撞 work
    expect(c).not.toBe("#c084fc"); // 不撞 personal
  });

  it("大寫 Personal 視為不同帳號、不 fallback work 藍、也與小寫 personal 不同色", () => {
    expect(accountColor("Personal")).not.toBe("#60a5fa");
    expect(accountColor("Personal")).not.toBe(accountColor("personal"));
  });
});

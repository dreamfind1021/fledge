import { describe, it, expect } from "vitest";
import { validateSubscriptions } from "./subscriptionsForm";

describe("validateSubscriptions", () => {
  it("合法清單回 normalized、不合法回欄位錯誤", () => {
    const ok = validateSubscriptions([{ name: " Claude ", monthly_cost: "100" }]);
    expect(ok).toEqual({ ok: true, value: [{ name: "Claude", monthly_cost: 100 }] });
    expect(validateSubscriptions([{ name: "", monthly_cost: "1" }]))
      .toEqual({ ok: false, error: "name" });
    expect(validateSubscriptions([{ name: "X", monthly_cost: "-1" }]))
      .toEqual({ ok: false, error: "cost" });
    expect(validateSubscriptions([{ name: "X", monthly_cost: "abc" }]))
      .toEqual({ ok: false, error: "cost" });
  });
});

import { describe, it, expect } from "vitest";
import { validateSubscriptions, dropBlankRows, sameSubscriptions } from "./subscriptionsForm";

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

describe("dropBlankRows", () => {
  it("名稱與費用都空白的列視為沒填（按了新增又沒填），只留動過的列", () => {
    expect(
      dropBlankRows([
        { name: "Claude", monthly_cost: "200" },
        { name: "  ", monthly_cost: "  " },
        { name: "", monthly_cost: "" },
      ]),
    ).toEqual([{ name: "Claude", monthly_cost: "200" }]);
  });

  it("只填一欄的列要留著——那是填一半，交給驗證擋下才不會被默默丟掉", () => {
    const halfFilled = [
      { name: "", monthly_cost: "20" },
      { name: "ChatGPT", monthly_cost: "" },
    ];
    expect(dropBlankRows(halfFilled)).toEqual(halfFilled);
  });

  it("費用是數字 0 不算空白", () => {
    expect(dropBlankRows([{ name: "", monthly_cost: 0 }])).toEqual([{ name: "", monthly_cost: 0 }]);
  });
});

describe("sameSubscriptions", () => {
  it("同內容同順序才算沒改", () => {
    const a = [{ name: "Claude", monthly_cost: 200 }, { name: "ChatGPT", monthly_cost: 20 }];
    expect(sameSubscriptions(a, [...a])).toBe(true);
    expect(sameSubscriptions([], [])).toBe(true);
    expect(sameSubscriptions(a, [a[1], a[0]])).toBe(false); // 順序是使用者看得到的東西
    expect(sameSubscriptions(a, [a[0]])).toBe(false);
    expect(sameSubscriptions(a, [])).toBe(false); // 刪光＝改動，不是「沒填」
    expect(sameSubscriptions(a, [{ name: "Claude", monthly_cost: 100 }, a[1]])).toBe(false);
    expect(sameSubscriptions(a, [{ name: "Claude Max", monthly_cost: 200 }, a[1]])).toBe(false);
  });
});

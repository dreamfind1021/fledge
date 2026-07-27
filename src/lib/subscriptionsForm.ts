// Settings 訂閱費表單驗證（與 sidecar PUT /api/config/subscriptions 的 400 規則一致：
// name 非空、cost 有限非負——isFinite 同時擋 NaN/inf/非數字）
export type SubsValidation =
  | { ok: true; value: { name: string; monthly_cost: number }[] }
  | { ok: false; error: "name" | "cost" };

export function validateSubscriptions(
  rows: { name: string; monthly_cost: string | number }[],
): SubsValidation {
  const out: { name: string; monthly_cost: number }[] = [];
  for (const r of rows) {
    const name = String(r.name).trim();
    if (!name) return { ok: false, error: "name" };
    const cost = typeof r.monthly_cost === "number" ? r.monthly_cost : parseFloat(r.monthly_cost);
    if (!Number.isFinite(cost) || cost < 0) return { ok: false, error: "cost" };
    out.push({ name, monthly_cost: cost });
  }
  return { ok: true, value: out };
}

/** 濾掉「名稱與費用都空白」的列——那是按了新增又沒填，不是填一半。
 *  只填一欄的列必須留著交給 `validateSubscriptions` 擋下，否則會被默默丟掉。 */
export function dropBlankRows<T extends { name: string; monthly_cost: string | number }>(rows: T[]): T[] {
  return rows.filter((r) => String(r.name).trim() !== "" || String(r.monthly_cost).trim() !== "");
}

/** 表單內容是否與已存的清單相同（順序也算——那是使用者看得到的東西）。
 *  用途：沒改就不送。空清單 vs 有內容會回 false，故「刪光」仍會被當成改動送出。 */
export function sameSubscriptions(
  a: { name: string; monthly_cost: number }[],
  b: { name: string; monthly_cost: number }[],
): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => row.name === b[i].name && row.monthly_cost === b[i].monthly_cost)
  );
}

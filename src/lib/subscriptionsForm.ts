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

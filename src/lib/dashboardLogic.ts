// 面板邏輯純函式（design §11）——元件只負責渲染，邏輯在此測試
import type { ClaudeAccountBlock } from "./sidecar";

export interface DonutPart { label: string; cost: number; fromDeg: number; toDeg: number }

export function donutParts(models: { model: string; cost: number }[]): DonutPart[] {
  if (models.length === 0) return [];
  const top = models.slice(0, 4).map((m) => ({ label: m.model, cost: m.cost }));
  const rest = models.slice(4).reduce((s, m) => s + m.cost, 0);
  const parts = rest > 0 ? [...top, { label: "…", cost: rest }] : top;
  const total = Math.max(1e-9, parts.reduce((s, p) => s + p.cost, 0));
  let acc = 0;
  return parts.map((p) => {
    const fromDeg = (acc / total) * 360;
    acc += p.cost;
    return { ...p, fromDeg, toDeg: (acc / total) * 360 };
  });
}

export interface ClaudeAccountRow {
  label: string;
  empty: boolean;
  showBar: boolean;
  pct: number | null;
  used: number;
  limit: number | null;
  burnRate: number | null;
  endTs: number | null;
}

// 單帳號 5hr 條的呈現值：有 limit_p90 才畫進度條；無則只給 used/burn/reset（設計 §3.3）
export function claudeAccountRow(acc: ClaudeAccountBlock, _now: number): ClaudeAccountRow {
  const a = acc.active;
  if (!a) {
    return { label: acc.label, empty: true, showBar: false, pct: null,
             used: 0, limit: null, burnRate: null, endTs: null };
  }
  const limit = acc.limit_p90;
  const showBar = limit != null;
  return {
    label: acc.label, empty: false, showBar,
    pct: showBar ? Math.min(1, a.total_tokens / (limit as number)) : null,
    used: a.total_tokens, limit, burnRate: a.burn_rate_tpm, endTs: a.end_ts,
  };
}

// 面板邏輯純函式（design §11）——元件只負責渲染，邏輯在此測試

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

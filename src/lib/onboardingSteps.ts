// 引導精靈的頁面序列與索引推進（純函式，元件只負責畫）。
// 序列與單帳號降級規則出自 `.scratch/onboarding-wizard/spec-b4.md` 定案 9。

export type WizardStep =
  | "welcome"
  | "roots"
  | "env"
  | "login"
  | "common"
  | "system"
  | "done";

const ALL_STEPS: readonly WizardStep[] = [
  "welcome",
  "roots",
  "env",
  "login",
  "common",
  "system",
  "done",
];

/** 頁面序列：共通設置是雙帳號才有的事，單帳號整頁不出現（不是顯示「不適用」）。 */
export function wizardSteps(accountCount: number): WizardStep[] {
  return accountCount >= 2 ? [...ALL_STEPS] : ALL_STEPS.filter((s) => s !== "common");
}

/**
 * 把索引夾進 [0, total-1]：兩端一律停住不繞回（首頁的上一步、末頁的下一步都是無效動作），
 * 同時吸收「序列長度改變後舊索引超界」的情況。
 */
export function clampStepIndex(index: number, total: number): number {
  return Math.max(0, Math.min(index, total - 1));
}

/**
 * 進度條每一格是否填色：格數＝實際頁數（單帳號少一格），填到目前頁為止。
 * index 是 0-based 頁索引，所以「已到達」的判準是 `i <= index` 而非 `i < index`。
 */
export function progressCells(index: number, total: number): boolean[] {
  return Array.from({ length: total }, (_, i) => i <= index);
}

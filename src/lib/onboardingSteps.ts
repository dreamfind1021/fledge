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
 * 把索引夾進 [0, total-1]：兩端一律停住不繞回（首頁的上一步、末頁的下一步都是無效動作）。
 *
 * 只保證索引合法，不保證語意定位——序列若在導覽途中縮短，同一個索引會指到不同的頁。
 * 精靈內帳號數不會變動（spec-b4 §1：帳號模式切換移出精靈、不提供刪帳號，精靈只寫 roots），
 * 所以那條路徑目前不可達；哪天精靈真的能改帳號數，導覽 state 要改存 `WizardStep` 而非索引。
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

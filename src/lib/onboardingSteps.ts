// 引導精靈的頁面序列與索引推進（純函式，元件只負責畫）。
// 全新設定的序列與單帳號降級規則出自 `.scratch/onboarding-wizard/spec-b4.md` 定案 9；
// 移機序列出自 `docs/superpowers/specs/2026-07-31-restore-into-empty-target-design.md` §5.1。

export type WizardStep =
  | "welcome"
  | "roots"
  | "env"
  | "login"
  | "common"
  | "system"
  | "done"
  // 移機分支專屬（票 12 Plan B）
  | "bundle"
  | "paths"
  | "install"
  | "repair";

const FRESH_STEPS: readonly WizardStep[] = [
  "welcome",
  "roots",
  "env",
  "login",
  "common",
  "system",
  "done",
];

// 移機分支刻意拿掉 common 與 system：共通設置的連結是跟著備份搬回來的，需要的是 repair 而不是
// 重新建立；範本部署是給新使用者鋪底的，東西都搬回來的人不需要（上游 spec §5.1）。
const RESTORE_STEPS: readonly WizardStep[] = [
  "welcome",
  "bundle",
  "roots",
  "paths",
  "install",
  "env",
  "login",
  "repair",
  "done",
];

/** 引導有兩條路：全新設定，或把備份包裝回這台機器（移機）。 */
export type WizardMode = "fresh" | "restore";

export interface WizardStepsInput {
  accountCount: number;
  mode: WizardMode;
  /**
   * 備份包裡有沒有專案歷史（只在 `restore` 有意義）。
   * 未給＝包還沒展開、還不知道，此時先留著 `paths` 頁；`bundle` 頁展開後才可能翻成 false。
   */
  hasProjectHistory?: boolean;
}

/**
 * 頁面序列。全新設定：共通設置是雙帳號才有的事，單帳號整頁不出現（不是顯示「不適用」）。
 * 移機：帳號數不影響序列（`common`／`system` 本來就不在這條路上），但包裡沒有專案歷史時
 * `paths` 整頁不出現——同樣不是顯示「不適用」。
 */
export function wizardSteps({
  accountCount,
  mode,
  hasProjectHistory = true,
}: WizardStepsInput): WizardStep[] {
  if (mode === "restore") {
    return hasProjectHistory ? [...RESTORE_STEPS] : RESTORE_STEPS.filter((s) => s !== "paths");
  }
  return accountCount >= 2 ? [...FRESH_STEPS] : FRESH_STEPS.filter((s) => s !== "common");
}

/**
 * 把索引夾進 [0, total-1]：兩端一律停住不繞回（首頁的上一步、末頁的下一步都是無效動作）。
 *
 * 只保證索引合法，不保證語意定位——序列若在導覽途中**於目前索引之前**縮短，同一個索引會指到
 * 不同的頁。兩條路目前都不可達：
 *   - 全新設定：精靈內帳號數不會變動（spec-b4 §1：帳號模式切換移出精靈、不提供刪帳號，精靈
 *     只寫 roots），`common` 的去留在進精靈時就定了
 *   - 移機：`paths` 的去留在 `bundle` 頁展開備份包時才得知，而 `bundle` 的索引小於 `paths`
 *     ——縮短點永遠在目前位置之後
 * 哪天精靈真的能改帳號數、或在 `paths` 之後才得知包內容，導覽 state 要改存 `WizardStep` 而非索引。
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

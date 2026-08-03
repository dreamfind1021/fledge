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
  // 移機分支專屬（票 12 Plan B）。`targets` 是移機的授權落點頁，刻意**不與 `roots` 共用身分**：
  // 兩者都是「不可逆的落檔動作」但走不同端點（`onboard` vs `adopt-config`），共用一個 step
  // 身分等於讓後續的 gating／續作／語意定位全都得再判一次 mode，漏一處就走錯提交路徑
  // （Codex 對抗式審查 F3）。
  | "bundle"
  | "targets"
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
  "targets",
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
 * step 身分 → 序列索引。**導覽 state 存的是「哪一頁」而不是「第幾頁」**，這支負責把身分翻回
 * 索引給進度條與導覽用。
 *
 * 為什麼不能存索引（Codex 對抗式審查 F1）：移機分支的 `paths` 去留取決於備份包的內容，而那是
 * 非同步得知的——使用者可能已經走到 `install`，一個遲到的 `bundle-info` 回應（或從 `install`
 * 回頭換一包）才讓序列增刪。含 `paths` 時 `install` 是索引 4，不含時索引 4 是 `env`：同一個
 * 數字會把使用者從安裝頁丟到環境頁。身分定位則保證停在同一頁。
 *
 * 目前這一頁**自己**被移除時（`paths`／`common` 降級掉），退到完整序列中它前面最近的、仍存在
 * 的一頁——往前退是保守解，不會讓使用者跳過還沒確認的步驟。
 */
export function stepIndex(step: WizardStep, steps: WizardStep[], mode: WizardMode): number {
  const direct = steps.indexOf(step);
  if (direct >= 0) return direct;
  const full = mode === "restore" ? RESTORE_STEPS : FRESH_STEPS;
  for (let i = full.indexOf(step) - 1; i >= 0; i--) {
    const back = steps.indexOf(full[i]);
    if (back >= 0) return back;
  }
  return 0; // 身分完全不屬於這條路（換 mode 的那一瞬間）→ 回首頁
}

/**
 * 把索引夾進 [0, total-1]：兩端一律停住不繞回（首頁的上一步、末頁的下一步都是無效動作）。
 *
 * 只負責「下一步／上一步」的越界防護，**不負責語意定位**——那是 `stepIndex()` 的職責，導覽
 * state 存的是 `WizardStep` 身分。兩者一起用：夾取算出合法的目標索引，再從序列取出該身分存起來。
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

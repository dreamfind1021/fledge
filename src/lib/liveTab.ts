import type { Tab } from "../store/useAppStore";

/**
 * 「需確認才能關」的 live Claude session 判定：只有 claude 分頁、已就緒、且有 session 才算。
 * terminal 分頁永遠回 false（拋棄式 shell，關閉不需確認）。
 * store.requestCloseTab 與 App 的 CloseConfirm/modalOpen 閘門共用此單一判定，避免兩處邏輯漂移
 * （Codex Med①）。
 */
export function isLiveClaudeTab(tab: Tab): boolean {
  return tab.kind === "claude" && tab.status === "ready" && tab.sessionId != null;
}

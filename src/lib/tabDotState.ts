import type { Tab } from "../store/useAppStore";

// tab 顯示用的單一狀態（status 優先；ready 時才看 activity）。
export type DotState = "working" | "waiting" | "connecting" | "offline" | "ended" | "error";

export function tabDotState(tab: Tab): DotState {
  switch (tab.status) {
    case "creating": return "connecting";
    case "offline": return "offline";
    case "ended": return "ended";
    case "error": return "error";
    case "ready": return tab.activity === "working" ? "working" : "waiting";
  }
}

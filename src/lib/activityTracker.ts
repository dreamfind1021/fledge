import { useAppStore } from "../store/useAppStore";

// 「離開 working 的確認窗」：最後一個實質輸出之後，要連續安靜這麼久才確認轉 waiting。
// 為什麼是 2000 而非更短：agent 思考時輸出是爆發式的（吐一串 token→停下思考→再吐），
// 思考暫停常常 >800ms；門檻太短會把每個思考暫停誤判成 waiting，造成燈號 working↔waiting
// 反覆閃爍（見 spec §5）。取 2000ms 容忍多數短思考暫停；代價是真正結束後約 2s 才顯示 waiting，
// 屬可接受的延遲。殘留（暫停 >2s）的偶發抖動由 TabBar.css 的完成漣漪去抖（animation-delay）吸收。
export const IDLE_MS = 2000;

// 小於此 byte 數的 PTY chunk 視為「非實質輸出」、忽略（不算 working）。
// 依 runtime 診斷（2026-06-05）：claude TUI 在 idle 時每 ~200ms 吐一個 ~5-byte
// 游標/控制序列——純看「有沒有 byte」會永遠卡 working。閾值取 16 過濾掉這個心跳；
// 實質生成輸出遠大於此（觀測到 20~800+ bytes）。
// ⚠ 註：使用者「打字」是整行重繪輸入框（>16 byte），無法靠 size 過濾 → 作用中 tab
//   打字時會短暫亮 working，屬 v1 接受的限制（見 spec §5.2，使用者 runtime 複驗確認）。
export const MIN_OUTPUT_BYTES = 16;

type Activity = "working" | "idle";
const tracker = new Map<string, { timer: ReturnType<typeof setTimeout>; last: Activity }>();

// 旁路訊號：吞掉自身錯誤，永不影響呼叫端（Terminal.onmessage）。
function setActivity(tabId: string, activity: Activity | undefined): void {
  try {
    useAppStore.getState().setTabActivity(tabId, activity);
  } catch {
    /* no-op */
  }
}

// 每次 PTY 有 bytes 進來時呼叫（size = 該 chunk 的 byte 數）。
// 只有「實質輸出」（size >= MIN_OUTPUT_BYTES）才算 working（轉換時 setState）+ 重排閒置計時器；
// 小 chunk（游標心跳 / 打字 echo）直接忽略，不影響 working/idle 判定。
export function recordActivity(tabId: string, size: number): void {
  if (size < MIN_OUTPUT_BYTES) return; // 忽略 idle 游標心跳等小 chunk（見 MIN_OUTPUT_BYTES 註解）
  const prev = tracker.get(tabId);
  if (prev) clearTimeout(prev.timer);
  if (prev?.last !== "working") setActivity(tabId, "working");
  const timer = setTimeout(() => {
    const e = tracker.get(tabId);
    if (e) {
      if (e.last !== "idle") setActivity(tabId, "idle");
      e.last = "idle";
    }
  }, IDLE_MS);
  tracker.set(tabId, { timer, last: "working" });
}

// Terminal dispose / session 結束時呼叫：清計時器 + 內部狀態 + 重置 store activity。
export function clearActivity(tabId: string): void {
  const prev = tracker.get(tabId);
  if (prev) clearTimeout(prev.timer);
  tracker.delete(tabId);
  setActivity(tabId, undefined);
}

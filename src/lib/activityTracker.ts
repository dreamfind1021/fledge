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
// 已改由程式自己的狀態回報（OSC 7501）驅動的分頁：size-gate 對它們不再生效（Pi spec §5.6）。
// 放這裡而不放 Tab：它跟計時器是同一件事的狀態，Terminal dispose 時一起清（clearActivity）。
const statusDriven = new Set<string>();

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
  if (statusDriven.has(tabId)) return;  // 已由狀態回報接管：輸出大小不再是訊號
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

// 程式自己回報狀態（Pi 的 OSC 7501）時呼叫：第一次收到就接管該分頁——先取消 size-gate 已排的閒置計時器
// （帶著第一個 OSC 的那個 chunk 自己會先排一個，不取消的話兩秒後燈被它關掉、Pi 對相同狀態不重複回報），
// 之後 recordActivity 對這個分頁直接忽略。working → working；blocked／done／error／idle／未知 → idle（燈顯示 waiting）。
// 計時器的 callback 不另外檢查接管：clearTimeout 在同一個 JS 執行緒裡先於 callback，取消後它不會再跑；
// 接管後也不會再排新的（recordActivity 早退），所以那個檢查永遠到不了。
export function recordProgramStatus(tabId: string, state: string): void {
  const prev = tracker.get(tabId);
  if (prev) clearTimeout(prev.timer);
  tracker.delete(tabId);
  statusDriven.add(tabId);
  setActivity(tabId, state === "working" ? "working" : "idle");
}

// WebSocket 單獨斷線（PTY 裡的 Pi 還活著、Terminal 不 dispose、之後會重連）時呼叫：放掉接管、燈設 waiting。
// 為什麼要放：sidecar 的 pump 綁在連線上，斷線期間 PTY 的輸出留在核心緩衝區、重連後照順序送到，
// 但「已經從 PTY 讀出、send 那一刻失敗」的那一個 chunk 會丟；裡面若帶著 Pi 的 `done`，接管不放的話
// 燈會卡在 working 直到 Pi 下次換狀態（Codex plan C 審查 medium）。重連後 size-gate 先接手、下一個 OSC 再接管，跟新 session 一樣。
// 為什麼設 idle 不設 undefined：常見情況是 Pi 閒置時 socket 抖一下，設 undefined 燈會消失到下一次輸出。
// 只對已接管的分頁生效：Claude 分頁從沒被接管，呼叫是 no-op、不碰 store（spec §5.6「Claude 不變」）。
export function releaseProgramStatus(tabId: string): void {
  if (!statusDriven.delete(tabId)) return;
  setActivity(tabId, "idle");
}

// Terminal dispose / session 結束時呼叫：清計時器 + 內部狀態 + 重置 store activity。
export function clearActivity(tabId: string): void {
  const prev = tracker.get(tabId);
  if (prev) clearTimeout(prev.timer);
  tracker.delete(tabId);
  statusDriven.delete(tabId);   // 新 session 從 size-gate 重新開始，再由下一個 OSC 接管
  setActivity(tabId, undefined);
}

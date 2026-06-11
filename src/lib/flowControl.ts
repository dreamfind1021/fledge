// PTY 輸出 flow control 的 watermark 狀態機（純函式 class，供 Terminal 用、可單元測；
// 沿用 wsReconnect.ts／imeReplayGuard.ts 的「純函式抽 lib」慣例）。
//
// 前端把每塊待 parse 的 bytes 在 term.write 前計入（record）、xterm write callback 回呼時
// 扣除（ack）。積壓越過 HIGH → 請 sidecar 暫停讀 PTY；回落到 LOW → 恢復。遲滯（hysteresis）
// 避免在單一門檻邊界反覆抖動。為何是它治本：背景被 WKWebView throttle 時 xterm WriteBuffer
// 的 setTimeout 被 clamp 到 ≥1s → parse 變慢 → ack 變慢 → pending 維持高檔 → 持續 paused，
// claude 阻塞在 PTY write（有界），不再無上限堆積。
//
// HIGH/LOW 取官方指南值（指南：「HIGH should not be greater than 500K」）；包 1（WebGL）落地後
// 真機校準，常數集中此處可調。
export const HIGH_WATERMARK = 100_000;
export const LOW_WATERMARK = 10_000;

export type FlowSignal = "pause" | "resume" | null;

export class FlowController {
  private pending = 0;
  private paused = false;

  /** term.write 前計入；越過 HIGH 且未暫停 → 'pause'（請 sidecar 停讀），否則 null（冪等） */
  record(bytes: number): FlowSignal {
    this.pending += bytes;
    if (!this.paused && this.pending > HIGH_WATERMARK) {
      this.paused = true;
      return "pause";
    }
    return null;
  }

  /** write callback 回呼時扣除；回落到 < LOW 且已暫停 → 'resume'（請 sidecar 續讀），否則 null（冪等） */
  ack(bytes: number): FlowSignal {
    this.pending -= bytes;
    if (this.paused && this.pending < LOW_WATERMARK) {
      this.paused = false;
      return "resume";
    }
    return null;
  }

  /** 當下未 parse 完的積壓 bytes（唯讀）：供 Task 5 驗收量測 pending 峰值（design §9） */
  get pendingBytes(): number {
    return this.pending;
  }
}

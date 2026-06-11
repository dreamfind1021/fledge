import { describe, it, expect } from "vitest";
import { FlowController, HIGH_WATERMARK, LOW_WATERMARK } from "./flowControl";

describe("FlowController", () => {
  it("積壓越過 HIGH 才回 'pause'，未越過回 null", () => {
    const f = new FlowController();
    expect(f.record(60_000)).toBe(null); // 60000 ≤ HIGH
    expect(f.record(60_000)).toBe("pause"); // 累計 120000 > HIGH
  });

  it("已 paused 再 record 不重複 pause（冪等）", () => {
    const f = new FlowController();
    f.record(120_000); // pause
    expect(f.record(50_000)).toBe(null);
  });

  it("paused 後 ack 回落到 < LOW 才回 'resume'", () => {
    const f = new FlowController();
    f.record(120_000); // pause，pending=120000
    expect(f.ack(100_000)).toBe(null); // pending=20000，仍 ≥ LOW
    expect(f.ack(15_000)).toBe("resume"); // pending=5000 < LOW
  });

  it("已 resume（未 paused）再 ack 不回 'resume'（冪等）", () => {
    const f = new FlowController();
    f.record(120_000);
    f.ack(115_000); // resume，pending=5000
    expect(f.ack(5_000)).toBe(null);
  });

  it("遲滯：pending 在 LOW~HIGH 間來回不抖動 signal", () => {
    const f = new FlowController();
    expect(f.record(120_000)).toBe("pause");
    expect(f.ack(50_000)).toBe(null); // pending=70000，介於 LOW 與 HIGH → 維持 paused
    expect(f.record(30_000)).toBe(null); // pending=100000，已 paused → 不再 pause
    expect(f.ack(95_000)).toBe("resume"); // pending=5000 < LOW
  });

  it("ack 亂序：總和與跨越門檻判定不受回呼順序影響", () => {
    const f = new FlowController();
    f.record(50_000);
    expect(f.record(80_000)).toBe("pause"); // pending=130000
    expect(f.ack(80_000)).toBe(null); // 先扣大的，pending=50000
    expect(f.ack(50_000)).toBe("resume"); // pending=0 < LOW
  });

  it("HIGH 邊界嚴格不等：pending 恰等於 HIGH 不 pause", () => {
    const f = new FlowController();
    expect(f.record(HIGH_WATERMARK)).toBe(null); // 100000 不 > 100000
    expect(f.record(1)).toBe("pause"); // 100001 > 100000
  });

  it("LOW 邊界嚴格不等：pending 恰等於 LOW 不 resume，再降才 resume", () => {
    const f = new FlowController();
    f.record(120_000); // pause，pending=120000
    expect(f.ack(110_000)).toBe(null); // pending=10000，不 < 10000
    expect(f.ack(1)).toBe("resume"); // pending=9999 < 10000
  });

  it("pendingBytes 反映當下積壓（供驗收量測 pending 峰值，design §9）", () => {
    const f = new FlowController();
    f.record(30_000);
    expect(f.pendingBytes).toBe(30_000);
    f.ack(10_000);
    expect(f.pendingBytes).toBe(20_000);
  });

  it("不同 instance 狀態隔離（重連後新 instance 不被舊計數污染）", () => {
    const a = new FlowController();
    const b = new FlowController();
    expect(a.record(120_000)).toBe("pause");
    expect(b.record(5_000)).toBe(null); // b 與 a 無共享狀態
  });

  it("匯出官方指南值常數", () => {
    expect(HIGH_WATERMARK).toBe(100_000);
    expect(LOW_WATERMARK).toBe(10_000);
  });
});

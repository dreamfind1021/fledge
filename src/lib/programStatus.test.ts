import { describe, it, expect } from "vitest";
import { parseProgramStatus } from "./programStatus";

// Pi 的 OSC 7501（Program Status Protocol）：`ESC ] 7501 ; state=working:app=pi:msg=<base64> ESC \`，
// xterm 的 OSC handler 收到的是 `;` 之後的字串（Pi spec §8）
describe("parseProgramStatus", () => {
  it("取 state；app／kind／msg 不管", () => {
    expect(parseProgramStatus("state=working:app=pi:msg=UGkgc2Vzc2lvbg==")).toBe("working");
    expect(parseProgramStatus("state=blocked:kind=dialog:app=pi")).toBe("blocked");
    expect(parseProgramStatus("state=done")).toBe("done");
  });
  it("支援查詢（`?`）、空字串、沒有 state 的字串 → null", () => {
    expect(parseProgramStatus("?")).toBeNull();
    expect(parseProgramStatus("")).toBeNull();
    expect(parseProgramStatus("app=pi:msg=eA==")).toBeNull();
    expect(parseProgramStatus("state=")).toBeNull();
  });
  it("state 不在已知集合也原樣回傳（由呼叫端歸到 idle，不在這裡丟掉）", () => {
    expect(parseProgramStatus("state=whatever")).toBe("whatever");
  });
});

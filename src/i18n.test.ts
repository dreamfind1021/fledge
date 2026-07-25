// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

// i18n.ts 在 module 層讀語言偏好：那一行若拋錯就是 import 期崩潰＝整個 app 開不起來。
// 這裡注入會拋錯的 Storage 驗降級路徑（vitest.setup.ts 的 shim 永遠可用，測不到這條）。
describe("i18n 開機讀取語言偏好", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("localStorage.getItem 拋錯時仍完成初始化並退回 OS 偵測", async () => {
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    });

    const i18n = (await import("./i18n")).default;

    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe("en"); // jsdom navigator.language = en-US
  });
});

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

// 接線測試（design §9.1）：catalog 沒加進 i18n.ts 的 resources 時，畫面會顯示 key 原文，
// 而 Tasks.tsx 的 render 測試與 parity 測試【都會全綠】——這條補那個缺口。
describe("tasks catalog 註冊", () => {
  it("tasks namespace 取得到翻譯，不是回傳 key 原文", async () => {
    const i18n = (await import("./i18n")).default;
    const en = (await import("./locales/en/tasks.json")).default;
    expect(i18n.t("tasks:tabTitle")).not.toBe("tabTitle");
    expect(i18n.t("tasks:tabTitle")).toBe(en.tabTitle);
  });
});

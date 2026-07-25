// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import { LangSwitch } from "./LangSwitch";

describe("LangSwitch", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("zh-TW"); // 固定起點，不依賴 jsdom 的 navigator.language
  });
  afterEach(() => {
    cleanup(); // vitest 未開 globals → testing-library 不會自動 cleanup
    vi.restoreAllMocks();
  });

  it("點另一語言 → changeLanguage 生效並寫入 localStorage 權威值", async () => {
    const { getByText } = render(<LangSwitch />);
    getByText("English").click();
    await waitFor(() => expect(i18n.language).toBe("en"));
    expect(localStorage.getItem("fledge-lang")).toBe("en");
  });

  it("目前語言的按鈕標記 aria-pressed，切換後跟著移動", async () => {
    const { getByText } = render(<LangSwitch />);
    expect(getByText("中文").getAttribute("aria-pressed")).toBe("true");
    expect(getByText("English").getAttribute("aria-pressed")).toBe("false");

    getByText("English").click();
    await waitFor(() => expect(getByText("English").getAttribute("aria-pressed")).toBe("true"));
    expect(getByText("中文").getAttribute("aria-pressed")).toBe("false");
  });

  it("切換同步 document lang（index.html 靜態 en 之外的唯一寫入者）", async () => {
    const { getByText } = render(<LangSwitch />);
    expect(document.documentElement.lang).toBe("zh-TW");
    getByText("English").click();
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  });

  // 以下兩例鎖 Codex 審查指出的部分失敗狀態：切換與寫快取不是原子操作
  it("localStorage 寫入失敗仍完成切換（記不住 ≠ 切不動）", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("SecurityError"); // Storage 被停用／配額滿
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getByText } = render(<LangSwitch />);
    getByText("English").click();

    await waitFor(() => expect(i18n.language).toBe("en"));
    expect(warn).toHaveBeenCalled();
  });

  it("changeLanguage 失敗時不寫快取（避免這次沒變、下次卻變了）", async () => {
    const change = vi
      .spyOn(i18n, "changeLanguage")
      .mockRejectedValue(new Error("boom") as never);

    const { getByText } = render(<LangSwitch />);
    getByText("English").click();

    await waitFor(() => expect(change).toHaveBeenCalledWith("en"));
    expect(localStorage.getItem("fledge-lang")).toBeNull();
  });
});

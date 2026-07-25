// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import { LangSwitch } from "./LangSwitch";

describe("LangSwitch", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("zh-TW"); // 固定起點，不依賴 jsdom 的 navigator.language
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

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
});

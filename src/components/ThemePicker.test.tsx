// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import i18n from "../i18n";
import { setTheme } from "../lib/theme";
import { ThemePicker } from "./ThemePicker";

// 外觀選項（票 07，spec docs/planning/daylight-themes-design.md §5.1）：設定視窗與精靈共用
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: () => Promise.resolve() }) }));

// 每一排的按鈕名稱（深色一排、淺色一排，spec docs/superpowers/specs/2026-10-03-cherry-blossom-theme-design.md §5）
const rows = (c: HTMLElement) =>
  [...c.querySelectorAll(".theme-picker > .lang-switch")].map((r) => [...r.querySelectorAll("button")].map((b) => b.textContent));

describe("ThemePicker", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("zh-TW");
    act(() => setTheme("nightfall"));
  });
  afterEach(() => {
    cleanup(); // vitest 未開 globals → testing-library 不會自動 cleanup
  });

  // 期望值寫字面、不從 THEME_SCHEME 推（表寫錯時兩邊一起錯）。保證範圍：目前這幾個主題排成這兩排；
  // 「以後新增的主題自動排進對的那一排」靠元件讀 THEME_SCHEME 分組，這裡分不出來（現在剛好前三深、後二淺，spec §7.3）
  it("深色一排、淺色一排，各排照 THEMES 的順序；目前的主題亮著", () => {
    const { container, getByText } = render(<ThemePicker />);
    expect(rows(container)).toEqual([["午夜藍", "濃巧棕", "深鐵黑"], ["冷調灰", "柔潤黃"]]);
    expect(getByText("午夜藍").className).toContain("is-on");
    expect(getByText("午夜藍").getAttribute("aria-pressed")).toBe("true");
    expect(getByText("冷調灰").className).not.toContain("is-on");
  });

  it("點了立刻生效、立刻記住，亮的那顆跟著換", () => {
    const { getByText } = render(<ThemePicker />);
    act(() => getByText("柔潤黃").click());
    expect(document.documentElement.dataset.theme).toBe("daylight-warm");
    expect(localStorage.getItem("fledge-theme")).toBe("daylight-warm");
    expect(getByText("柔潤黃").className).toContain("is-on");
    expect(getByText("午夜藍").className).not.toContain("is-on");
  });

  // 設定視窗與精靈各有一個：一邊選了，另一邊也要跟著亮（兩個都讀同一份狀態）
  it("別處切了主題，這裡跟著重新渲染", () => {
    const { getByText } = render(<ThemePicker />);
    act(() => setTheme("daylight-cool"));
    expect(getByText("冷調灰").className).toContain("is-on");
  });

  it("英文介面的名稱", async () => {
    await act(() => i18n.changeLanguage("en"));
    const { container } = render(<ThemePicker />);
    expect(rows(container)).toEqual([["Midnight Blue", "Dark Chocolate", "Iron Black"], ["Cool Gray", "Soft Yellow"]]);
  });
});

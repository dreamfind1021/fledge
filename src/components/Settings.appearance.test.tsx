// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import i18n from "../i18n";
import { Settings } from "./Settings";

// 設定視窗的「外觀」區（票 07，spec docs/planning/daylight-themes-design.md §5.2）：放在最上面、裡面是外觀選項
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: () => Promise.resolve() }) }));

describe("設定視窗的外觀區", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
  });
  afterEach(() => cleanup());

  it("第一個區塊是「外觀」，裡面是五個主題選項", () => {
    const { container } = render(<Settings onClose={() => {}} onRerunOnboarding={() => {}} onResumeMigration={() => {}} />);
    const titles = [...container.querySelectorAll(".settings-body .settings-sec-title")];
    expect(titles[0].textContent).toBe("外觀");
    expect(titles[0].className).toContain("settings-sec-title--first");
    // 其他區塊不再是第一個
    expect(titles.slice(1).every((t) => !t.className.includes("settings-sec-title--first"))).toBe(true);
    const tile = titles[0].nextElementSibling;
    expect(tile?.className).toBe("settings-rrow");
    expect([...(tile?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual(["午夜藍", "濃巧棕", "深鐵黑", "冷調灰", "柔潤黃"]);
  });
});

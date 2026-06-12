import { describe, it, expect } from "vitest";
import { shouldPoll } from "./usagePoll";

describe("shouldPoll", () => {
  it("分頁 active 且頁面可見才輪詢", () => {
    expect(shouldPoll({ isActiveTab: true, documentHidden: false })).toBe(true);
    expect(shouldPoll({ isActiveTab: false, documentHidden: false })).toBe(false);
    expect(shouldPoll({ isActiveTab: true, documentHidden: true })).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { wizardSteps, stepIndex, clampStepIndex, progressCells } from "./onboardingSteps";

describe("wizardSteps（全新設定）", () => {
  it("雙帳號走完整七頁（spec-b4 定案 9）", () => {
    expect(wizardSteps({ accountCount: 2, mode: "fresh" })).toEqual([
      "welcome",
      "roots",
      "env",
      "login",
      "common",
      "system",
      "done",
    ]);
  });

  it("單帳號整個共通設置頁不出現（六頁）", () => {
    expect(wizardSteps({ accountCount: 1, mode: "fresh" })).toEqual([
      "welcome",
      "roots",
      "env",
      "login",
      "system",
      "done",
    ]);
  });
});

describe("wizardSteps（我有備份）", () => {
  it("移機序列（上游 spec §5.1）", () => {
    expect(wizardSteps({ accountCount: 2, mode: "restore" })).toEqual([
      "welcome",
      "bundle",
      "targets",
      "paths",
      "install",
      "env",
      "login",
      "repair",
      "done",
    ]);
  });

  // 旗標未給＝包還沒展開、還不知道有沒有專案歷史，此時 paths 先留著（上一條與下一條都釘住
  // 這個預設）。序列在導覽途中縮短是被允許的——定位靠 stepIndex() 的身分比對，見該支測試。
  it("備份包裡沒有專案歷史時 paths 整頁不出現（比照單帳號的 common）", () => {
    expect(wizardSteps({ accountCount: 1, mode: "restore", hasProjectHistory: false })).toEqual([
      "welcome",
      "bundle",
      "targets",
      "install",
      "env",
      "login",
      "repair",
      "done",
    ]);
  });

  // 共通設置的連結是跟著備份搬回來的（要的是 repair 不是重建）、範本是給新使用者鋪底的，
  // 兩者都不在移機分支——所以帳號數在這條路上不改變任何東西
  it("單帳號的移機序列與雙帳號完全相同", () => {
    expect(wizardSteps({ accountCount: 1, mode: "restore" })).toEqual([
      "welcome",
      "bundle",
      "targets",
      "paths",
      "install",
      "env",
      "login",
      "repair",
      "done",
    ]);
  });
});

describe("stepIndex", () => {
  const withPaths = wizardSteps({ accountCount: 1, mode: "restore" });
  const noPaths = wizardSteps({ accountCount: 1, mode: "restore", hasProjectHistory: false });

  // Codex 對抗式審查 F1：`bundle-info` 是非同步的，序列可能在使用者已經走到 `install`
  // 之後才增刪 `paths`（遲到的回應、或從 install 回頭換一包）。存索引會讓同一個數字指到
  // 另一個語意頁；存 step 身分才停得住。
  it("序列縮短時仍停在同一頁——而同一個索引已經是別頁了", () => {
    expect(withPaths[stepIndex("install", withPaths, "restore")]).toBe("install");
    expect(noPaths[stepIndex("install", noPaths, "restore")]).toBe("install");
    expect(withPaths.indexOf("install")).toBe(4);
    expect(noPaths[4]).toBe("env"); // 索引定位會把使用者從安裝頁丟到環境頁
  });

  it("目前這一頁被移除時退到它前面最近的一頁（不跳過安裝確認）", () => {
    expect(noPaths[stepIndex("paths", noPaths, "restore")]).toBe("targets");
  });

  it("全新設定的單帳號降級同理：共通設置頁消失時退到登入頁", () => {
    const single = wizardSteps({ accountCount: 1, mode: "fresh" });
    expect(single[stepIndex("common", single, "fresh")]).toBe("login");
  });
});

describe("clampStepIndex", () => {
  it("範圍內原樣通過", () => {
    expect(clampStepIndex(3, 7)).toBe(3);
  });

  it("超過末頁夾在末頁（完成頁再按下一步不繞回歡迎）", () => {
    expect(clampStepIndex(7, 7)).toBe(6);
  });

  it("小於首頁夾在首頁（歡迎頁按上一步不掉到負數）", () => {
    expect(clampStepIndex(-1, 7)).toBe(0);
  });

  it("序列縮短時把過大的索引拉回末頁（雙帳號→單帳號少一頁）", () => {
    expect(clampStepIndex(6, 6)).toBe(5);
  });
});

describe("progressCells", () => {
  it("格數跟著實際頁數走：單帳號六格、雙帳號七格", () => {
    expect(progressCells(0, wizardSteps({ accountCount: 1, mode: "fresh" }).length)).toHaveLength(6);
    expect(progressCells(0, wizardSteps({ accountCount: 2, mode: "fresh" }).length)).toHaveLength(7);
  });

  it("首頁只填第一格（目前頁本身算已到達）", () => {
    expect(progressCells(0, 7)).toEqual([true, false, false, false, false, false, false]);
  });

  it("填到目前頁為止", () => {
    expect(progressCells(2, 7)).toEqual([true, true, true, false, false, false, false]);
  });

  it("末頁全填", () => {
    expect(progressCells(6, 7)).toEqual([true, true, true, true, true, true, true]);
  });
});

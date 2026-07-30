import { describe, expect, it } from "vitest";
import { blockingReason } from "./backupFormat";
import type { BackupStatus } from "./sidecar";

// 標註成 BackupStatus 而非 `as const`：後者會把欄位推成唯讀字面型別，展開覆寫時對不上。
const OK: BackupStatus = {
  configured: true,
  backup_dir: "/out",
  dir_status: "dir",
  containment: "ok",
};

describe("blockingReason", () => {
  it("一切正常時沒有阻斷原因", () => {
    expect(blockingReason(OK)).toBeNull();
  });

  it("未設定位置", () => {
    expect(blockingReason({ ...OK, configured: false })).toBe("not_configured");
  });

  it("三種 containment 違規各自可分辨", () => {
    expect(blockingReason({ ...OK, containment: "inside_source" })).toBe("inside_source");
    expect(blockingReason({ ...OK, containment: "is_home" })).toBe("is_home");
    expect(blockingReason({ ...OK, containment: "is_root" })).toBe("is_root");
  });

  it("設定檔被手動塞相對路徑時回 invalid", () => {
    expect(blockingReason({ ...OK, containment: "invalid" })).toBe("invalid");
  });

  it("三種目錄異常各自可分辨", () => {
    expect(blockingReason({ ...OK, dir_status: "missing" })).toBe("dir_missing");
    expect(blockingReason({ ...OK, dir_status: "not_dir" })).toBe("dir_not_dir");
    expect(blockingReason({ ...OK, dir_status: "denied" })).toBe("dir_denied");
  });

  it("未設定優先於一切——沒選過位置時不該叫使用者去修一個不存在的目錄", () => {
    expect(
      blockingReason({
        ...OK,
        configured: false,
        containment: "inside_source",
        dir_status: "missing",
      }),
    ).toBe("not_configured");
  });

  it("containment 優先於目錄狀態——位置選錯時，把那個目錄建出來也沒用", () => {
    expect(blockingReason({ ...OK, containment: "inside_source", dir_status: "missing" })).toBe(
      "inside_source",
    );
  });

  it.each([
    ["containment", { containment: "brand_new" as never }],
    ["dir_status", { dir_status: "brand_new" as never }],
  ])("後端多出未知的 %s 時不阻斷、也不會把 i18n key 印到畫面上", (_label, patch) => {
    // 動態組 key（`dir_${s}`）會產生 catalog 沒有的 key，i18n 對查不到的 key 是印出 key 原文
    expect(blockingReason({ ...OK, ...patch })).toBeNull();
  });
});

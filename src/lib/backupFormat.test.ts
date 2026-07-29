import { describe, expect, it } from "vitest";
import { blockingReason } from "./backupFormat";
import type { BackupStatus } from "./sidecar";

// 標註成 BackupStatus 而非 `as const`：後者會把欄位推成唯讀字面型別，展開覆寫時對不上。
const OK: BackupStatus = {
  configured: true,
  backup_dir: "/out",
  dir_status: "dir",
};

describe("blockingReason", () => {
  it("一切正常時沒有阻斷原因", () => {
    expect(blockingReason(OK)).toBeNull();
  });

  it("未設定位置", () => {
    expect(blockingReason({ ...OK, configured: false })).toBe("not_configured");
  });

  it("三種目錄異常各自可分辨", () => {
    expect(blockingReason({ ...OK, dir_status: "missing" })).toBe("dir_missing");
    expect(blockingReason({ ...OK, dir_status: "not_dir" })).toBe("dir_not_dir");
    expect(blockingReason({ ...OK, dir_status: "denied" })).toBe("dir_denied");
  });

  it("設定檔被手動塞相對路徑時回 invalid", () => {
    expect(blockingReason({ ...OK, dir_status: "invalid" })).toBe("dir_invalid");
  });

  it("未設定優先於目錄異常——沒選過位置時不該叫使用者去修一個不存在的目錄", () => {
    expect(blockingReason({ ...OK, configured: false, dir_status: "missing" })).toBe(
      "not_configured",
    );
  });
});

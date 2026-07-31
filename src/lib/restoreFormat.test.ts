import { describe, it, expect } from "vitest";
import { destMessageKey, repairScope, restoreBlocking } from "./restoreFormat";
import type { BackupStatus } from "./sidecar";

function status(over: Partial<BackupStatus> = {}): BackupStatus {
  return {
    configured: true,
    backup_dir: "/b",
    dir_status: "dir",
    containment: "ok",
    script_available: true,
    restore_script_available: true,
    python3_available: true,
    bundles: [{ name: "claude-backup-20260101-1200.tar.gz", created_ts: 1, size_bytes: 2 }],
    last_backup_ts: 1,
    days_since: 0,
    last_attempt_failed: false,
    ...over,
  };
}

describe("restoreBlocking", () => {
  it("一切就緒時不擋", () => {
    expect(restoreBlocking(status())).toBeNull();
  });

  it("沒設過備份位置＝沒有備份包可選", () => {
    expect(restoreBlocking(status({ configured: false }))).toBe("not_configured");
  });

  it("備份目錄不可用時列不出備份包", () => {
    for (const dir_status of ["missing", "not_dir", "denied"] as const) {
      expect(restoreBlocking(status({ dir_status }))).toBe("dir_unusable");
    }
  });

  it("目錄可用但一份備份包也沒有", () => {
    expect(restoreBlocking(status({ bundles: [] }))).toBe("no_bundles");
  });

  it("還原腳本與 python3 各自回報", () => {
    expect(restoreBlocking(status({ restore_script_available: false }))).toBe("script_missing");
    expect(restoreBlocking(status({ python3_available: false }))).toBe("python3_missing");
  });

  it("備份腳本缺席不影響還原", () => {
    // 兩支是不同的檔案：只有備份腳本漏收時，還原照樣做得到
    expect(restoreBlocking(status({ script_available: false }))).toBeNull();
  });

  it("備份位置的 containment 不擋還原", () => {
    // containment 是「輸出不能落在讀取來源裡面」的規則，只對備份寫入成立。位置不理想並不會
    // 讓裡面既有的備份包不能讀——擋下還原只是在使用者最需要備份包的時候製造死路。
    // 後端 `resolve_backup_dir` 同樣不驗它，兩邊必須一致。
    for (const containment of ["inside_source", "is_home", "is_root"] as const) {
      expect(restoreBlocking(status({ containment }))).toBeNull();
    }
  });

  it("多個條件同時成立時取最前面那個", () => {
    // 順序與後端擋下的順序一致：使用者看到的修復指引，就是後端下一個會擋的東西
    expect(
      restoreBlocking(status({
        configured: false, dir_status: "missing", bundles: [],
        restore_script_available: false, python3_available: false,
      })),
    ).toBe("not_configured");
  });
});

describe("destMessageKey", () => {
  it("ok 沒有訊息", () => {
    expect(destMessageKey("ok")).toBeNull();
  });

  it("每個非 ok 狀態都有顯式對應的 key", () => {
    // 顯式表而非動態組 key：後端多一個狀態時，動態組會產生 catalog 裡沒有的 key，
    // 而 i18n 對查不到的 key 是把 key 原文印在畫面上（CLAUDE.md §4.6.13）
    const all = ["is_root", "is_home", "inside_source", "not_empty", "not_dir", "denied"] as const;
    const keys = all.map((s) => destMessageKey(s));
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(all.length);   // 每個狀態說法不同，不能共用一句話
  });
});

describe("repairScope", () => {
  it("source＝第一個登記帳號，其餘是 target（與共通設置卡同一慣例）", () => {
    expect(repairScope(["work", "personal", "extra"])).toEqual({
      source: "work",
      targets: ["personal", "extra"],
    });
  });

  it("少於兩個帳號時沒有共通設置可修", () => {
    // 單一帳號沒有 target；照送會讓後端回 empty_targets，等於拿一個必然的錯誤去問後端
    expect(repairScope(["work"])).toBeNull();
    expect(repairScope([])).toBeNull();
  });
});

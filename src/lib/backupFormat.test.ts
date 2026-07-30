import { describe, expect, it } from "vitest";
import { blockingReason, formatBundleTime, formatSize, freshnessLevel } from "./backupFormat";
import type { BackupStatus } from "./sidecar";

// 標註成 BackupStatus 而非 `as const`：後者會把欄位推成唯讀字面型別，展開覆寫時對不上。
const OK: BackupStatus = {
  configured: true,
  backup_dir: "/out",
  dir_status: "dir",
  containment: "ok",
  script_available: true,
  python3_available: true,
  last_attempt_failed: false,
  bundles: [],
  last_backup_ts: null,
  days_since: 3,
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

describe("freshnessLevel", () => {
  it("一週內是正常", () => {
    expect(freshnessLevel(0)).toBe("fresh");
    expect(freshnessLevel(7)).toBe("fresh");
  });

  it("8–30 天是提醒色", () => {
    expect(freshnessLevel(8)).toBe("stale");
    expect(freshnessLevel(30)).toBe("stale");
  });

  it("超過 30 天是警告色", () => {
    expect(freshnessLevel(31)).toBe("overdue");
  });

  it("從未備份與「超過一個月」同級——兩者都代表現在沒有保護", () => {
    expect(freshnessLevel(null)).toBe("overdue");
  });
});

describe("formatSize", () => {
  it("依量級選單位", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(168820736)).toBe("161.0 MB");
  });

  it("超過 GB 不再往上跳單位（備份包不會有 TB 級）", () => {
    expect(formatSize(5 * 1024 ** 4)).toMatch(/GB$/);
  });
});

describe("formatBundleTime", () => {
  const ts = new Date(2026, 6, 29, 23, 0, 0).getTime() / 1000;   // 2026-07-29 23:00 本地時間

  it("不顯示秒——備份包時間戳來自檔名，精度只到分鐘，秒永遠是 00", () => {
    expect(formatBundleTime(ts, "zh-TW")).not.toMatch(/:00:00/);
  });

  it("仍帶得出日期與時分", () => {
    const out = formatBundleTime(ts, "zh-TW");
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/11:00|23:00/);
  });
});

describe("blockingReason — 環境前提", () => {
  it("缺腳本、缺 python3 各自可分辨", () => {
    expect(blockingReason({ ...OK, script_available: false })).toBe("script_missing");
    expect(blockingReason({ ...OK, python3_available: false })).toBe("python3_missing");
  });

  it("腳本排在 python3 之前", () => {
    expect(blockingReason({ ...OK, script_available: false, python3_available: false })).toBe(
      "script_missing",
    );
  });

  it("位置問題排在環境前提之前——先讓使用者把自己能決定的事情弄對", () => {
    expect(
      blockingReason({
        ...OK,
        containment: "inside_source",
        script_available: false,
        python3_available: false,
      }),
    ).toBe("inside_source");
    expect(
      blockingReason({ ...OK, dir_status: "missing", python3_available: false }),
    ).toBe("dir_missing");
  });
});

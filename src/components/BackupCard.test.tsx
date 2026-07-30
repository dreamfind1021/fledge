// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/backup.json";
import { BackupError, type BackupStatus } from "../lib/sidecar";
import { BackupCard } from "./BackupCard";

// mock 樣板照既有的 CommonConfigCard.test.tsx：importOriginal 保留其他匯出，只替換要控的幾支
const fetchBackupStatus = vi.fn<(port: number) => Promise<BackupStatus>>();
const putBackupDir = vi.fn<(port: number, path: string) => Promise<unknown>>();
const pickDirectory = vi.fn<() => Promise<string | null>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchBackupStatus: (port: number) => fetchBackupStatus(port),
  putBackupDir: (port: number, path: string) => putBackupDir(port, path),
}));
vi.mock("../lib/dialog", () => ({ pickDirectory: () => pickDirectory() }));

const OK: BackupStatus = {
  configured: true,
  backup_dir: "/out/backups",
  dir_status: "dir",
  containment: "ok",
  bundles: [
    { name: "claude-backup-20260727-1432.tar.gz", created_ts: 1785220320, size_bytes: 168820736 },
  ],
  last_backup_ts: 1785220320,
  days_since: 3,
};

function mockStatus(overrides: Partial<BackupStatus> = {}) {
  fetchBackupStatus.mockResolvedValue({ ...OK, ...overrides });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-TW");   // 固定語言，斷言才對得上 catalog
  vi.clearAllMocks();
  putBackupDir.mockResolvedValue({ ok: true, backup_dir: "/picked" });
});
afterEach(cleanup);   // vitest 無 globals，cleanup 要自己掛

describe("BackupCard", () => {
  it("未設定時顯示引導與選擇位置的按鈕", async () => {
    mockStatus({ configured: false, backup_dir: "", dir_status: "missing" });
    render(<BackupCard port={1} />);
    await screen.findByText(zh.blocked.not_configured);
    expect(screen.getByRole("button", { name: zh.chooseLocation })).toBeTruthy();
  });

  it("已設定且目錄可用時顯示路徑", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    await screen.findByText("/out/backups");
    expect(screen.queryByText(zh.blocked.not_configured)).toBeNull();
  });

  it.each([
    ["missing", zh.blocked.dir_missing],
    ["not_dir", zh.blocked.dir_not_dir],
    ["denied", zh.blocked.dir_denied],
  ] as const)("目錄異常 %s 顯示可分辨的說明", async (status, message) => {
    mockStatus({ dir_status: status });
    render(<BackupCard port={1} />);
    await screen.findByText(message);
  });

  it.each([
    ["inside_source", zh.blocked.inside_source],
    ["is_home", zh.blocked.is_home],
    ["is_root", zh.blocked.is_root],
    ["invalid", zh.blocked.invalid],
  ] as const)("位置不合法 %s 顯示可分辨的說明", async (containment, message) => {
    mockStatus({ containment });
    render(<BackupCard port={1} />);
    await screen.findByText(message);
  });

  it("位置不合法且目錄也不存在時，顯示位置那條——把目錄建出來也沒用", async () => {
    mockStatus({ containment: "inside_source", dir_status: "missing" });
    render(<BackupCard port={1} />);
    await screen.findByText(zh.blocked.inside_source);
    expect(screen.queryByText(zh.blocked.dir_missing)).toBeNull();
  });

  it("選完位置會存回後端並重新讀狀態", async () => {
    mockStatus({ configured: false, backup_dir: "", dir_status: "missing" });
    pickDirectory.mockResolvedValue("/picked");
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.chooseLocation }));
    await waitFor(() => expect(putBackupDir).toHaveBeenCalledWith(1, "/picked"));
    expect(fetchBackupStatus).toHaveBeenCalledTimes(2);   // 初次載入 + 存完回讀
  });

  it("取消選擇時不寫入", async () => {
    mockStatus({ configured: false, backup_dir: "", dir_status: "missing" });
    pickDirectory.mockResolvedValue(null);
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.chooseLocation }));
    await waitFor(() => expect(pickDirectory).toHaveBeenCalled());
    expect(putBackupDir).not.toHaveBeenCalled();
  });

  it("後端拒絕時顯示 i18n 文案，不外洩判別碼", async () => {
    mockStatus({ configured: false, backup_dir: "", dir_status: "missing" });
    pickDirectory.mockResolvedValue("foo");
    putBackupDir.mockRejectedValue(new BackupError("backup_dir_invalid", 400));
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.chooseLocation }));
    await screen.findByText(zh.blocked.invalid);
    expect(screen.queryByText(/backup_dir_invalid/)).toBeNull();
  });

  it("判別碼沒有對應文案時退回通用訊息，仍不顯示原文", async () => {
    mockStatus({ configured: false, backup_dir: "", dir_status: "missing" });
    pickDirectory.mockResolvedValue("/x");
    putBackupDir.mockRejectedValue(new BackupError("something_new", 400));
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.chooseLocation }));
    await screen.findByText(zh.errors.saveFailed);
    expect(screen.queryByText(/something_new/)).toBeNull();
  });
});

describe("BackupCard 天數與清單", () => {
  it("顯示天數與備份包大小", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    await screen.findByText(zh.daysAgo.replace("{{count}}", "3"));
    expect(screen.getByText("161.0 MB")).toBeTruthy();
  });

  it("今天備份過時說「今天」而不是「0 天前」", async () => {
    mockStatus({ days_since: 0 });
    render(<BackupCard port={1} />);
    await screen.findByText(zh.today);
  });

  it("從未備份時說「從未備份」，不是 0 天前", async () => {
    mockStatus({ bundles: [], last_backup_ts: null, days_since: null });
    render(<BackupCard port={1} />);
    await screen.findByText(zh.neverBackedUp);
    expect(screen.queryByText(zh.bundles)).toBeNull();   // 沒有備份包就不列空清單
  });

  it("超過五份才給展開，展開後全部列出", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      name: `claude-backup-2026072${i}-1000.tar.gz`,
      created_ts: 1785220320 + i,
      size_bytes: 1024,
    }));
    mockStatus({ bundles: many });
    render(<BackupCard port={1} />);
    const expand = await screen.findByRole("button", {
      name: zh.showAll.replace("{{count}}", "7"),
    });
    expect(screen.getAllByText("1.0 KB")).toHaveLength(5);
    fireEvent.click(expand);
    expect(screen.getAllByText("1.0 KB")).toHaveLength(7);
  });
});

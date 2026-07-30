// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/backup.json";
import {
  BackupError,
  SessionError,
  type BackupStatus,
  type CreateSessionOptions,
} from "../lib/sidecar";
import { BackupCard } from "./BackupCard";

// mock 樣板照既有的 CommonConfigCard.test.tsx：importOriginal 保留其他匯出，只替換要控的幾支
const fetchBackupStatus = vi.fn<(port: number) => Promise<BackupStatus>>();
const putBackupDir = vi.fn<(port: number, path: string) => Promise<unknown>>();
const pickDirectory = vi.fn<() => Promise<string | null>>();
const createSession = vi.fn<(port: number, opts: CreateSessionOptions) => Promise<string>>();
const closeSession = vi.fn<(port: number, id: string) => Promise<void>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchBackupStatus: (port: number) => fetchBackupStatus(port),
  putBackupDir: (port: number, path: string) => putBackupDir(port, path),
  createSession: (port: number, opts: CreateSessionOptions) => createSession(port, opts),
  closeSession: (port: number, id: string) => closeSession(port, id),
}));
vi.mock("../lib/dialog", () => ({ pickDirectory: () => pickDirectory() }));
// xterm 進 jsdom 會炸（canvas/WebGL）；本卡只需驗「終端機有沒有被掛上、掛在哪個 session」
vi.mock("./Terminal", () => ({
  Terminal: ({
    sessionId,
    tabId,
    onEnded,
  }: {
    sessionId: string;
    tabId: string;
    onEnded?: () => void;
  }) => (
    <div data-testid="terminal" data-session={sessionId} data-tab={tabId}>
      {/* 讓測試能模擬 PTY EOF */}
      <button type="button" data-testid="end-session" onClick={() => onEnded?.()} />
    </div>
  ),
}));

const OK: BackupStatus = {
  configured: true,
  backup_dir: "/out/backups",
  dir_status: "dir",
  containment: "ok",
  script_available: true,
  python3_available: true,
  last_attempt_failed: false,
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
  createSession.mockResolvedValue("session-1");
  closeSession.mockResolvedValue(undefined);
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

describe("BackupCard 執行", () => {
  it("按預覽只送 kind 與 backup_mode——不含命令字串也不含路徑", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.preview }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    const [, opts] = createSession.mock.calls[0];
    expect(opts).toEqual({ path: "", kind: "backup", backupMode: "list" });
    expect(JSON.stringify(opts)).not.toMatch(/backup-claude|\/Users|bash/);
  });

  it("掛載時只讀一次狀態——「session 收掉就回讀」不能在初次掛載也觸發", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    await screen.findByRole("button", { name: zh.preview });
    expect(fetchBackupStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["script_available", zh.blocked.script_missing],
    ["python3_available", zh.blocked.python3_missing],
  ] as const)("%s 為否時說明原因並且沒有預覽鈕", async (flag, message) => {
    mockStatus({ [flag]: false });
    render(<BackupCard port={1} />);
    await screen.findByText(message);
    expect(screen.queryByRole("button", { name: zh.preview })).toBeNull();
  });

  it("後端擋下時顯示 i18n 文案，不外洩判別碼", async () => {
    mockStatus();
    createSession.mockRejectedValue(new SessionError("python3_missing", 400));
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.preview }));
    await screen.findByText(zh.blocked.python3_missing);
    expect(screen.queryByText(/python3_missing$/)).toBeNull();
  });
});

it("session 建起來後掛上卡內終端機", async () => {
  mockStatus();
  render(<BackupCard port={1} />);
  fireEvent.click(await screen.findByRole("button", { name: zh.preview }));
  const term = await screen.findByTestId("terminal");
  expect(term.getAttribute("data-session")).toBe("session-1");
});

describe("BackupCard 立即備份", () => {
  it("送出 run 模式", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.runNow }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(createSession.mock.calls[0][1]).toEqual({
      path: "",
      kind: "backup",
      backupMode: "run",
    });
  });

  it("執行中兩顆按鈕都停用——一次只跑一個", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.runNow }));
    await waitFor(() => expect(screen.queryByTestId("terminal")).toBeTruthy());
    expect(screen.getByRole("button", { name: zh.runNow }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: zh.preview }).hasAttribute("disabled")).toBe(true);
  });

  it("跑完後按鈕解除停用，但終端機留在原地讓人看輸出", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.runNow }));
    fireEvent.click(await screen.findByTestId("end-session"));   // 模擬 PTY EOF
    await waitFor(() =>
      expect(screen.getByRole("button", { name: zh.runNow }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("button", { name: zh.preview }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("terminal")).toBeTruthy();
  });

  it("跑完後回讀狀態——天數與清單不能停在舊值", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.runNow }));
    await waitFor(() => expect(fetchBackupStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("end-session"));
    await waitFor(() => expect(fetchBackupStatus).toHaveBeenCalledTimes(2));
  });

  it("預覽跑完後仍能按立即備份（不必重開設定頁）", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.preview }));
    fireEvent.click(await screen.findByTestId("end-session"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: zh.runNow }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: zh.runNow }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    expect(createSession.mock.calls[1][1]).toMatchObject({ backupMode: "run" });
  });

  it("last_attempt_failed 時多一行提示，但不停用備份", async () => {
    mockStatus({ last_attempt_failed: true });
    render(<BackupCard port={1} />);
    await screen.findByText(zh.lastAttemptFailed);
    expect(screen.getByRole("button", { name: zh.runNow }).hasAttribute("disabled")).toBe(false);
  });

  it("沒有殘骸時不顯示未完成提示", async () => {
    mockStatus();
    render(<BackupCard port={1} />);
    await screen.findByRole("button", { name: zh.runNow });
    expect(screen.queryByText(zh.lastAttemptFailed)).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/restore.json";
import {
  RestoreError,
  type BackupStatus,
  type CommonConfigOpResult,
  type CommonConfigPlan,
  type CreateSessionOptions,
  type RestorePlan,
} from "../lib/sidecar";
import { RestoreCard } from "./RestoreCard";

const fetchBackupStatus = vi.fn<(port: number) => Promise<BackupStatus>>();
const restorePlan = vi.fn<(port: number, bundle: string, dest?: string) => Promise<RestorePlan>>();
const commonConfigPlan = vi.fn<(port: number, req: unknown) => Promise<CommonConfigPlan>>();
const commonConfigRepair = vi.fn<(port: number, req: unknown) => Promise<CommonConfigOpResult[]>>();
const pickDirectory = vi.fn<() => Promise<string | null>>();
const createSession = vi.fn<(port: number, opts: CreateSessionOptions) => Promise<string>>();
const closeSession = vi.fn<(port: number, id: string) => Promise<void>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchBackupStatus: (port: number) => fetchBackupStatus(port),
  restorePlan: (port: number, bundle: string, dest?: string) => restorePlan(port, bundle, dest),
  commonConfigPlan: (port: number, req: unknown) => commonConfigPlan(port, req),
  commonConfigRepair: (port: number, req: unknown) => commonConfigRepair(port, req),
  createSession: (port: number, opts: CreateSessionOptions) => createSession(port, opts),
  closeSession: (port: number, id: string) => closeSession(port, id),
}));
vi.mock("../lib/dialog", () => ({ pickDirectory: () => pickDirectory() }));
// xterm 進 jsdom 會炸（canvas/WebGL）；本卡只需驗「終端機有沒有被掛上、掛在哪個 session」
vi.mock("./Terminal", () => ({
  Terminal: ({ sessionId, onEnded }: { sessionId: string; onEnded?: () => void }) => (
    <div data-testid="terminal" data-session={sessionId}>
      {/* 讓測試能模擬 PTY EOF（＝腳本跑完） */}
      <button type="button" data-testid="end-session" onClick={() => onEnded?.()} />
    </div>
  ),
}));

const BUNDLE = "claude-backup-20260727-1432.tar.gz";
const OLDER = "claude-backup-20260720-0900.tar.gz";

const OK: BackupStatus = {
  configured: true,
  backup_dir: "/out/backups",
  dir_status: "dir",
  containment: "ok",
  script_available: true,
  restore_script_available: true,
  python3_available: true,
  last_attempt_failed: false,
  bundles: [
    { name: BUNDLE, created_ts: 1785220320, size_bytes: 168820736 },
    { name: OLDER, created_ts: 1784620320, size_bytes: 160000000 },
  ],
  last_backup_ts: 1785220320,
  days_since: 3,
};

const TWO_ACCOUNTS = {
  work: { config_dir: "~/.claude", label: "工作" },
  personal: { config_dir: "~/.claude-tc", label: "私人" },
};

function mockStatus(overrides: Partial<BackupStatus> = {}) {
  fetchBackupStatus.mockResolvedValue({ ...OK, ...overrides });
}

/** 等到「展開位置」出現＝`plan` 已回來。**必須等這個而不是等 run 鍵出現**：run 鍵在 plan
 *  到達前是 disabled，而 `fireEvent.click` 會繞過 disabled 照樣觸發 handler、handler 又因
 *  `plan === null` 直接 return——那是「按了卻什麼都沒發生」的假通過（票 29 的同一課），
 *  在單檔跑時剛好會過、整套跑時就隨機逾時。 */
function ready() {
  return screen.findByText("/home/me/.claude-restore-20260727-1432");
}

function planOf(state: string, entry = "commands"): CommonConfigPlan {
  return {
    source_dir: "/src",
    operations: [{
      account: "personal", entry, target_path: `/tgt/${entry}`,
      state: state as CommonConfigPlan["operations"][number]["state"],
      action: "relink", needs_overwrite: false,
    }],
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-TW");   // 固定語言，斷言才對得上 catalog
  vi.clearAllMocks();
  restorePlan.mockResolvedValue({
    bundle: BUNDLE, dest: "/home/me/.claude-restore-20260727-1432", dest_status: "ok",
  });
  commonConfigPlan.mockResolvedValue(planOf("ok"));
  commonConfigRepair.mockResolvedValue([]);
  createSession.mockResolvedValue("session-1");
  closeSession.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("RestoreCard", () => {
  it("預設選最新的備份包，並顯示後端算出來的展開位置", async () => {
    mockStatus();
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await screen.findByText("/home/me/.claude-restore-20260727-1432");
    expect(restorePlan).toHaveBeenCalledWith(1, BUNDLE, undefined);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });

  it("換一份備份包會重算展開位置", async () => {
    // 預設位置的目錄名帶備份包時間戳：沿用上一份的位置會把兩份還原解到同一個地方
    mockStatus();
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await screen.findByText("/home/me/.claude-restore-20260727-1432");
    fireEvent.click(screen.getAllByRole("radio")[1]);
    await waitFor(() => expect(restorePlan).toHaveBeenCalledWith(1, OLDER, undefined));
  });

  it.each([
    ["not_configured", zh.blocked.not_configured, { configured: false }],
    ["dir_unusable", zh.blocked.dir_unusable, { dir_status: "missing" as const }],
    ["no_bundles", zh.blocked.no_bundles, { bundles: [] }],
    ["script_missing", zh.blocked.script_missing, { restore_script_available: false }],
    ["python3_missing", zh.blocked.python3_missing, { python3_available: false }],
  ])("阻斷態 %s 顯示可分辨的說明且不給執行鍵", async (_name, message, over) => {
    mockStatus(over as Partial<BackupStatus>);
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await screen.findByText(message);
    expect(screen.queryByRole("button", { name: zh.run })).toBeNull();
  });

  it("展開位置有問題時說明原因並停用執行鍵", async () => {
    mockStatus();
    restorePlan.mockResolvedValue({
      bundle: BUNDLE, dest: "/home/me/.claude", dest_status: "inside_source",
    });
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await screen.findByText(zh.dest.inside_source);
    expect((screen.getByRole("button", { name: zh.run }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("選了新位置就重新驗證它", async () => {
    mockStatus();
    pickDirectory.mockResolvedValue("/picked");
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await screen.findByRole("button", { name: zh.change });
    fireEvent.click(screen.getByRole("button", { name: zh.change }));
    await waitFor(() => expect(restorePlan).toHaveBeenCalledWith(1, BUNDLE, "/picked"));
  });

  it("執行時只送備份包名與展開位置，永不送命令字串", async () => {
    mockStatus();
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: zh.run }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    const opts = createSession.mock.calls[0][1];
    expect(opts).toEqual({
      path: "",
      kind: "restore",
      restoreBundle: BUNDLE,
      restoreDest: "/home/me/.claude-restore-20260727-1432",
    });
  });

  it("後端判別碼映射成文案，不把判別碼印在畫面上", async () => {
    mockStatus();
    restorePlan.mockRejectedValue(new RestoreError("unknown_bundle", 400));
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await screen.findByText(zh.errors.unknown_bundle);
    expect(screen.queryByText(/unknown_bundle/)).toBeNull();
  });

  it("掛載就檢查現役共通設置——不必先跑任何東西", async () => {
    // 還原只把備份包解到獨立的 DEST，展開本身不可能讓現役目錄冒出斷鏈；斷鏈出現的時刻是
    // 使用者把設定搬回現役目錄之後。綁在展開後只會讓它幾乎永遠說「沒有斷鏈」。
    mockStatus();
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await screen.findByText(zh.links.none);
    expect(commonConfigPlan).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: zh.links.repair })).toBeNull();
  });

  it("展開跑完會重測一次", async () => {
    mockStatus();
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    await ready();
    await waitFor(() => expect(commonConfigPlan).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: zh.run }));
    fireEvent.click(await screen.findByTestId("end-session"));
    await waitFor(() => expect(commonConfigPlan).toHaveBeenCalledTimes(2));
  });

  it("偵測到斷鏈時提供修復入口，且不自動執行", async () => {
    mockStatus();
    commonConfigPlan.mockResolvedValue(planOf("broken_link"));
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);

    await screen.findByRole("button", { name: zh.links.repair });
    // **不自動執行**：修復會改寫 symlink，是破壞性操作，要使用者明確按下去
    expect(commonConfigRepair).not.toHaveBeenCalled();
  });

  it("按下修復才動手，並送含 projects 的完整清單", async () => {
    mockStatus();
    commonConfigPlan.mockResolvedValue(planOf("broken_link"));
    commonConfigRepair.mockResolvedValue([
      { account: "personal", entry: "commands", outcome: "relinked", backup_path: null, error: null },
      { account: "personal", entry: "skills", outcome: "skipped", backup_path: null, error: null },
    ]);
    render(<RestoreCard port={1} accounts={TWO_ACCOUNTS} />);
    fireEvent.click(await screen.findByRole("button", { name: zh.links.repair }));

    await waitFor(() => expect(commonConfigRepair).toHaveBeenCalled());
    const req = commonConfigRepair.mock.calls[0][1] as { source: string; targets: string[]; entries: string[] };
    expect(req.source).toBe("work");
    expect(req.targets).toEqual(["personal"]);
    // projects 是進階項（共通設置卡不送），但移機後它同樣是斷鏈，不送就永遠修不回來
    expect(req.entries).toContain("projects");
    // 逐項回報，且「沒事做」的那些不佔版面
    await screen.findByText("personal / commands");
    expect(screen.queryByText("personal / skills")).toBeNull();
  });

  it("只有一個帳號時說沒有共通設置可查，不去問後端", async () => {
    mockStatus();
    render(<RestoreCard port={1} accounts={{ work: { config_dir: "~/.claude", label: "" } }} />);

    await screen.findByText(zh.links.notApplicable);
    expect(commonConfigPlan).not.toHaveBeenCalled();
  });

});

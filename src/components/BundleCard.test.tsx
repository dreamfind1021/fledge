// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode, act, useState } from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import zhRestore from "../locales/zh-TW/restore.json";
import { RestoreError, type BundleInfo, type CreateSessionOptions, type RestorePlan } from "../lib/sidecar";
import { BundleCard, EMPTY_BUNDLE_SELECTION, type BundleSelection } from "./BundleCard";

const pickFile = vi.fn<(label: string) => Promise<string | null>>();
const pickDirectory = vi.fn<() => Promise<string | null>>();
const restorePlanForPath = vi.fn<(port: number, path: string, dest?: string) => Promise<RestorePlan>>();
const fetchBundleInfo = vi.fn<(port: number, dest: string) => Promise<BundleInfo>>();
const createSession = vi.fn<(port: number, opts: CreateSessionOptions) => Promise<string>>();
const closeSession = vi.fn<(port: number, sessionId: string) => Promise<void>>();

vi.mock("../lib/dialog", () => ({
  pickFile: (label: string) => pickFile(label),
  pickDirectory: () => pickDirectory(),
}));
vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  restorePlanForPath: (port: number, path: string, dest?: string) => restorePlanForPath(port, path, dest),
  fetchBundleInfo: (port: number, dest: string) => fetchBundleInfo(port, dest),
  createSession: (port: number, opts: CreateSessionOptions) => createSession(port, opts),
  closeSession: (port: number, sessionId: string) => closeSession(port, sessionId),
}));
// xterm 進 jsdom 會炸（canvas/WebGL）。這裡另外要能**主動觸發 PTY 結束**——展開結束是
// 「去讀這一包內容」的唯一觸發點，用假的 Terminal 把 onEnded 掛到一個按鈕上。
vi.mock("./Terminal", () => ({
  Terminal: ({ sessionId, onEnded }: { sessionId: string; onEnded?: () => void }) => (
    <button data-testid="terminal" data-session={sessionId} onClick={() => onEnded?.()}>
      pty
    </button>
  ),
}));

const INFO: BundleInfo = {
  host: "old-mac",
  created: "20260731-1200",
  accounts: ["personal", "work"],
  extra: [".agents"],
  project_count: 9,
};

/** `BundleCard` 是受控元件——選包狀態整組住在精靈（卡片會隨換頁卸載）。測試得把
 *  `onSelection` 回寫成 props，否則畫面永遠停在初始狀態（那是父層的職責）。 */
function Harness({ spy }: { spy: (s: BundleSelection) => void }) {
  const [selection, setSelection] = useState<BundleSelection>(EMPTY_BUNDLE_SELECTION);
  return (
    <BundleCard
      port={1234}
      selection={selection}
      onSelection={(s) => {
        setSelection(s);
        spy(s);
      }}
    />
  );
}

function setup() {
  const spy = vi.fn<(s: BundleSelection) => void>();
  const ui = render(<Harness spy={spy} />);
  return { ui, spy };
}

/** 能把卡片卸載再掛回來的 harness：離開備份包頁再回來就是這個形狀。 */
function RemountHarness({ spy, port = 1234 }: { spy: (s: BundleSelection) => void; port?: number }) {
  const [selection, setSelection] = useState<BundleSelection>(EMPTY_BUNDLE_SELECTION);
  const [shown, setShown] = useState(true);
  return (
    <div>
      <button data-testid="toggle" onClick={() => setShown((v) => !v)}>toggle</button>
      {shown && (
        <BundleCard
          port={port}
          selection={selection}
          onSelection={(s) => {
            setSelection(s);
            spy(s);
          }}
        />
      )}
    </div>
  );
}

/** 最後一次回報的包資訊；大部分斷言只關心這一格。 */
const lastProbe = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls[spy.mock.calls.length - 1]?.[0]?.probe;
const allProbes = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map((c) => c[0].probe);

/** 走到「已選包、已算出展開位置」的狀態。 */
async function pickBundle(ui: ReturnType<typeof render>, path = "/Volumes/usb/claude-backup-20260731-1200.tar.gz") {
  pickFile.mockResolvedValueOnce(path);
  ui.getByText(zh.mig.bundle.pick).click();
  await waitFor(() => expect(ui.getByText(path)).toBeTruthy());
}

describe("BundleCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    restorePlanForPath.mockResolvedValue({
      bundle: "/Volumes/usb/claude-backup-20260731-1200.tar.gz",
      dest: "/Users/me/claude-restore-20260731-1200",
      dest_status: "ok",
    });
    fetchBundleInfo.mockResolvedValue(INFO);
    createSession.mockResolvedValue("sess-1");
  });
  afterEach(cleanup);

  it("選包後算出展開位置並顯示（路徑模式，不送包名）", async () => {
    const { ui } = setup();
    await pickBundle(ui);
    expect(restorePlanForPath).toHaveBeenCalledWith(
      1234, "/Volumes/usb/claude-backup-20260731-1200.tar.gz", undefined);
    expect(ui.getByText("/Users/me/claude-restore-20260731-1200")).toBeTruthy();
  });

  it("展開送的是路徑與確認過的展開位置", async () => {
    const { ui } = setup();
    await pickBundle(ui);
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(createSession).toHaveBeenCalledWith(1234, {
      path: "",
      kind: "restore",
      restoreBundlePath: "/Volumes/usb/claude-backup-20260731-1200.tar.gz",
      restoreDest: "/Users/me/claude-restore-20260731-1200",
    }));
  });

  it("展開結束才去讀這一包的內容，摘要顯示出來並回報 present", async () => {
    const { ui, spy } = setup();
    await pickBundle(ui);
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    expect(fetchBundleInfo).not.toHaveBeenCalled();      // PTY 還沒結束就問＝問到空目錄

    ui.getByTestId("terminal").click();                  // PTY EOF

    await waitFor(() => expect(ui.getByText("old-mac")).toBeTruthy());
    expect(ui.getByText("personal, work")).toBeTruthy();
    expect(lastProbe(spy)).toEqual({
      kind: "present", info: INFO, dest: "/Users/me/claude-restore-20260731-1200",
    });
  });

  it("包裡沒有專案歷史 → absent（`paths` 頁會整頁不出現）", async () => {
    fetchBundleInfo.mockResolvedValue({ ...INFO, project_count: 0 });
    const { ui, spy } = setup();
    await pickBundle(ui);
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();
    await waitFor(() => expect(lastProbe(spy)).toMatchObject({ kind: "absent" }));
  });

  // 換包後遲到的回應（Codex 票 01 實作階段 R1）：使用者已經在看第二包的摘要，第一包的
  // 回應才姍姍來遲——照樣寫進 state 的話，畫面上的摘要與實際展開的那一包對不上。
  it("連續換兩包、回應亂序抵達 → 只採用最後那一包", async () => {
    const { ui, spy } = setup();
    let releaseFirst: (info: BundleInfo) => void = () => {};
    fetchBundleInfo.mockImplementationOnce(
      () => new Promise<BundleInfo>((resolve) => { releaseFirst = resolve; }));

    await pickBundle(ui, "/tmp/first.tar.gz");
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();                  // 第一包的 bundle-info 卡住不回

    restorePlanForPath.mockResolvedValue({
      bundle: "/tmp/second.tar.gz", dest: "/tmp/dest-2", dest_status: "ok",
    });
    fetchBundleInfo.mockResolvedValue({ ...INFO, host: "second-mac" });
    await pickBundle(ui, "/tmp/second.tar.gz");
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();
    await waitFor(() => expect(ui.getByText("second-mac")).toBeTruthy());

    releaseFirst({ ...INFO, host: "first-mac" });        // 第一包的回應現在才到
    await waitFor(() => expect(ui.getByText("second-mac")).toBeTruthy());
    expect(ui.queryByText("first-mac")).toBeNull();
    expect(lastProbe(spy)).toMatchObject({ info: { host: "second-mac" } });
  });

  // Codex 票 02 R1 F1：`onEnded` 若讀「當下的 plan」而不是「這個 PTY 實際展開的位置」，
  // 舊 PTY 在使用者換包之後才 EOF，就會對**新包的展開位置**讀摘要——而新包根本還沒展開。
  it("舊的展開在換包之後才結束 → 不得對新包的位置讀摘要", async () => {
    const { ui } = setup();
    await pickBundle(ui, "/tmp/first.tar.gz");
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());

    restorePlanForPath.mockResolvedValue({
      bundle: "/tmp/second.tar.gz", dest: "/tmp/dest-2", dest_status: "ok",
    });
    await pickBundle(ui, "/tmp/second.tar.gz");     // 換包，第二包還沒展開
    ui.getByTestId("terminal").click();             // 第一包的 PTY 現在才 EOF
    await act(async () => { await Promise.resolve(); });   // 讓 EOF handler 跑完

    expect(fetchBundleInfo).not.toHaveBeenCalled();
  });

  // 同一條 F1 的另一半：換包只清了包資訊、沒讓**已經在路上的**摘要請求失效。
  it("前一包的摘要請求晚於換包才回來 → 不得被採用", async () => {
    const { ui, spy } = setup();
    let releaseFirst: (info: BundleInfo) => void = () => {};
    fetchBundleInfo.mockImplementationOnce(
      () => new Promise<BundleInfo>((resolve) => { releaseFirst = resolve; }));

    await pickBundle(ui, "/tmp/first.tar.gz");
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();             // 第一包的摘要請求發出去、卡住

    restorePlanForPath.mockResolvedValue({
      bundle: "/tmp/second.tar.gz", dest: "/tmp/dest-2", dest_status: "ok",
    });
    await pickBundle(ui, "/tmp/second.tar.gz");     // 換包（第二包還沒展開）

    releaseFirst({ ...INFO, host: "first-mac" });   // 第一包的回應現在才到
    await waitFor(() => expect(ui.queryByText("first-mac")).toBeNull());
    expect(lastProbe(spy)).toMatchObject({ kind: "unknown" });
  });

  it("換包時先把包資訊清成 unknown——舊摘要不得停在畫面上", async () => {
    const { ui, spy } = setup();
    await pickBundle(ui, "/tmp/first.tar.gz");
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();
    await waitFor(() => expect(ui.getByText("old-mac")).toBeTruthy());

    await pickBundle(ui, "/tmp/second.tar.gz");
    expect(lastProbe(spy)).toEqual({ kind: "unknown" });
    expect(ui.queryByText("old-mac")).toBeNull();
  });

  // 判別碼一律經顯式表映射；例外原文與判別碼本身都不得出現在畫面上（CLAUDE.md §4.6.13）
  it("選到的不是備份包 → 顯示映射後的訊息，包資訊維持 unknown", async () => {
    fetchBundleInfo.mockRejectedValueOnce(new RestoreError("source_not_a_bundle", 400));
    const { ui, spy } = setup();
    await pickBundle(ui);
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();
    await waitFor(() => expect(ui.getByText(zhRestore.errors.source_not_a_bundle)).toBeTruthy());
    expect(allProbes(spy)).not.toContainEqual(expect.objectContaining({ kind: "present" }));
  });

  it("算展開位置失敗 → 通用訊息，例外原文不進畫面", async () => {
    restorePlanForPath.mockRejectedValueOnce(new Error("PLAN-SENTINEL-500"));
    const { ui } = setup();
    pickFile.mockResolvedValueOnce("/tmp/x.tar.gz");
    ui.getByText(zh.mig.bundle.pick).click();
    await waitFor(() => expect(ui.getByText(zhRestore.errors.planFailed)).toBeTruthy());
    expect(ui.queryByText(/PLAN-SENTINEL/)).toBeNull();
  });

  // 展開位置不能用時（非空、在現役資料裡…）不讓使用者按下去才發現——按鈕先停用，
  // 說法與還原卡同一批文案（restore namespace），不另寫一份。
  it("展開位置不可用 → 顯示原因並停用展開", async () => {
    restorePlanForPath.mockResolvedValue({
      bundle: "/tmp/x.tar.gz", dest: "/Users/me", dest_status: "is_home",
    });
    const { ui } = setup();
    await pickBundle(ui, "/tmp/x.tar.gz");
    expect(ui.getByText(zhRestore.dest.is_home)).toBeTruthy();
    expect(ui.getByText(zh.mig.bundle.expand).closest("button")!.disabled).toBe(true);
  });

  it("換展開位置：帶著新位置重算，送出的也是新位置", async () => {
    const { ui } = setup();
    await pickBundle(ui, "/tmp/x.tar.gz");
    pickDirectory.mockResolvedValueOnce("/tmp/picked");
    restorePlanForPath.mockResolvedValue({
      bundle: "/tmp/x.tar.gz", dest: "/tmp/picked", dest_status: "ok",
    });
    ui.getByText(zh.mig.bundle.changeDest).click();
    await waitFor(() => expect(restorePlanForPath)
      .toHaveBeenLastCalledWith(1234, "/tmp/x.tar.gz", "/tmp/picked"));
  });
});

describe("BundleCard 重新掛載", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    restorePlanForPath.mockResolvedValue({
      bundle: "/tmp/x.tar.gz", dest: "/tmp/dest", dest_status: "ok",
    });
    fetchBundleInfo.mockResolvedValue(INFO);
    createSession.mockResolvedValue("sess-1");
  });
  afterEach(cleanup);

  // Codex 票 02 R2：卡片卸載期間展開目錄可能被刪／被換、sidecar 也可能換了 port，而那些
  // 變化卡片自己看不到（它根本沒掛著）。保留選包狀態是對的，但**包資訊要重新確認**——
  // 否則一份已失效的摘要就直接把導覽 gating 解開了。
  it("回到這一頁會重新確認這一包還在，重驗回來之前不放行", async () => {
    const spy = vi.fn<(s: BundleSelection) => void>();
    const ui = render(<RemountHarness spy={spy} />);

    pickFile.mockResolvedValueOnce("/tmp/x.tar.gz");
    ui.getByText(zh.mig.bundle.pick).click();
    await waitFor(() => expect(ui.getByText("/tmp/x.tar.gz")).toBeTruthy());
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();
    await waitFor(() => expect(lastProbe(spy)).toMatchObject({ kind: "present" }));
    fetchBundleInfo.mockClear();
    let release: (i: BundleInfo) => void = () => {};
    fetchBundleInfo.mockImplementationOnce(
      () => new Promise<BundleInfo>((resolve) => { release = resolve; }));

    ui.getByTestId("toggle").click();                    // 離開這一頁（卡片卸載）
    await waitFor(() => expect(ui.queryByTestId("terminal")).toBeNull());
    ui.getByTestId("toggle").click();                    // 回來（卡片重新掛載）

    // 重驗**發出去的當下**就先收緊：回來之前，舊摘要不得繼續替導覽背書
    await waitFor(() => expect(fetchBundleInfo).toHaveBeenCalledWith(1234, "/tmp/dest"));
    expect(lastProbe(spy)).toEqual({ kind: "unknown" });
    release(INFO);
    await waitFor(() => expect(lastProbe(spy)).toMatchObject({ kind: "present" }));
    // 選包與展開位置**不必**重來：那一組沒有失效風險，重選只是折磨使用者
    expect(ui.getByText("/tmp/x.tar.gz")).toBeTruthy();
  });

  it("重驗發現這一包已經不在 → 回到 unknown 並顯示原因", async () => {
    const spy = vi.fn<(s: BundleSelection) => void>();
    const ui = render(<RemountHarness spy={spy} />);

    pickFile.mockResolvedValueOnce("/tmp/x.tar.gz");
    ui.getByText(zh.mig.bundle.pick).click();
    await waitFor(() => expect(ui.getByText("/tmp/x.tar.gz")).toBeTruthy());
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();
    await waitFor(() => expect(lastProbe(spy)).toMatchObject({ kind: "present" }));

    fetchBundleInfo.mockRejectedValueOnce(new RestoreError("source_not_a_bundle", 400));
    ui.getByTestId("toggle").click();
    await waitFor(() => expect(ui.queryByTestId("terminal")).toBeNull());
    ui.getByTestId("toggle").click();

    await waitFor(() => expect(ui.getByText(zhRestore.errors.source_not_a_bundle)).toBeTruthy());
    expect(lastProbe(spy)).toEqual({ kind: "unknown" });
  });
});

// 正式入口是 `<React.StrictMode>`（`src/main.tsx`），而 StrictMode 會把 effect 跑成
// setup→cleanup→setup。掛載重驗若在 replay 時看見**尚未回灌的舊 props**，會算出同一個
// gen 再發一次請求——兩份回應共用同一個 gen，latest-wins 分不出先後，誰後到誰說了算
// （Codex 票 02 R3）。
describe("BundleCard 在 StrictMode 下", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    restorePlanForPath.mockResolvedValue({
      bundle: "/tmp/x.tar.gz", dest: "/tmp/dest", dest_status: "ok",
    });
    fetchBundleInfo.mockResolvedValue(INFO);
    createSession.mockResolvedValue("sess-1");
  });
  afterEach(cleanup);

  it("重新掛載只重驗一次，effect replay 不得再發一份", async () => {
    const spy = vi.fn<(s: BundleSelection) => void>();
    const ui = render(<StrictMode><RemountHarness spy={spy} /></StrictMode>);

    pickFile.mockResolvedValueOnce("/tmp/x.tar.gz");
    ui.getByText(zh.mig.bundle.pick).click();
    await waitFor(() => expect(ui.getByText("/tmp/x.tar.gz")).toBeTruthy());
    ui.getByText(zh.mig.bundle.expand).click();
    await waitFor(() => expect(ui.getByTestId("terminal")).toBeTruthy());
    ui.getByTestId("terminal").click();
    await waitFor(() => expect(lastProbe(spy)).toMatchObject({ kind: "present" }));
    fetchBundleInfo.mockClear();

    ui.getByTestId("toggle").click();
    await waitFor(() => expect(ui.queryByTestId("terminal")).toBeNull());
    ui.getByTestId("toggle").click();

    await waitFor(() => expect(lastProbe(spy)).toMatchObject({ kind: "present" }));
    expect(fetchBundleInfo).toHaveBeenCalledTimes(1);
  });
});

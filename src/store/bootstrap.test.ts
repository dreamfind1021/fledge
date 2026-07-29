import { describe, it, expect, vi, beforeEach } from "vitest";
import * as sidecar from "../lib/sidecar";
import { useAppStore } from "./useAppStore";

vi.mock("../lib/sidecar");

const config = (over: Partial<sidecar.AppConfigData> = {}) =>
  ({
    version: 1,
    roots: [],
    accounts: { default: { config_dir: "~/.claude", label: "預設" } },
    manual_projects: [],
    project_overrides: {},
    ui: { theme: "nightfall" },
    ...over,
  }) as sidecar.AppConfigData;

/** 讓整條序列走到底的預設 happy path mock。 */
function mockHappyPath(cfg = config()) {
  vi.mocked(sidecar.waitForSidecarPort).mockResolvedValue(4321);
  vi.mocked(sidecar.waitForSidecarToken).mockResolvedValue("tok");
  vi.mocked(sidecar.fetchHealth).mockResolvedValue({ ok: true, version: "0.5.0", claude_found: true });
  vi.mocked(sidecar.fetchConfig).mockResolvedValue(cfg);
  vi.mocked(sidecar.fetchProjects).mockResolvedValue({ projects: [], permissionError: false });
}

describe("bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 不需要重置 inFlight：每個案例都 await 到 settle，finally 會自行清掉
    useAppStore.setState({ port: null, config: null, projects: [], startup: "running", startupError: null });
  });

  it("成功時 startup 走到 ready 並回傳 firstRun=false", async () => {
    mockHappyPath();
    const r = await useAppStore.getState().bootstrap();
    expect(r).toEqual({ firstRun: false, projectsError: null });
    expect(useAppStore.getState().startup).toBe("ready");
  });

  it("is_first_run 時回傳 firstRun=true 且不載入專案", async () => {
    mockHappyPath(config({ is_first_run: true }));
    const r = await useAppStore.getState().bootstrap();
    expect(r?.firstRun).toBe(true);
    expect(sidecar.fetchProjects).not.toHaveBeenCalled();
  });

  it("任一步失敗 → startup=failed、startupError 帶原文、回傳 null", async () => {
    mockHappyPath();
    vi.mocked(sidecar.waitForSidecarPort).mockRejectedValue(new Error("spawn boom"));
    const r = await useAppStore.getState().bootstrap();
    expect(r).toBeNull();
    expect(useAppStore.getState().startup).toBe("failed");
    expect(useAppStore.getState().startupError).toMatch(/spawn boom/);
  });

  // R1：StrictMode 下 effect 跑兩次；沒有去重會把已 ready 的狀態打回 running、splash 閃第二次
  it("同步連呼回傳同一個 promise 物件，底層只跑一次", async () => {
    mockHappyPath();
    const p1 = useAppStore.getState().bootstrap();
    const p2 = useAppStore.getState().bootstrap();
    expect(p1).toBe(p2); // identity——bootstrap 不得宣告為 async，否則這裡會是兩個不同 promise
    await p1;
    expect(sidecar.waitForSidecarPort).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().startup).toBe("ready");
  });

  // R1：settle 後沒清掉 inFlight 的話，重試會撿到上一輪已 resolve 的舊 null、永遠不 restart
  it("失敗 settle 後重試會建立新 promise 並真的呼叫 restartSidecar", async () => {
    mockHappyPath();
    vi.mocked(sidecar.waitForSidecarPort).mockRejectedValueOnce(new Error("boom"));
    const first = useAppStore.getState().bootstrap();
    expect(await first).toBeNull();

    vi.mocked(sidecar.restartSidecar).mockResolvedValue(4321);
    const second = useAppStore.getState().bootstrap({ restart: true });
    expect(second).not.toBe(first);
    expect(await second).toEqual({ firstRun: false, projectsError: null });
    expect(sidecar.restartSidecar).toHaveBeenCalledTimes(1);
  });

  // Codex 實作審查：restartSidecar 在 Rust 端最長同步等 30s。若等它回來才設 running，
  // 這段期間 startup 仍是 failed → Splash 顯示「可按的重試」而非 disabled 的「重試中…」。
  it("restart 尚未完成時 startup 就已是 running（重試中的閘門靠它）", async () => {
    mockHappyPath();
    useAppStore.setState({ startup: "failed", startupError: "boom" });
    let releaseRestart!: () => void;
    vi.mocked(sidecar.restartSidecar).mockReturnValue(
      new Promise<number>((resolve) => {
        releaseRestart = () => resolve(4321);
      }),
    );

    const pending = useAppStore.getState().bootstrap({ restart: true });
    await Promise.resolve(); // 讓 run() 跑到第一個 await
    expect(useAppStore.getState().startup).toBe("running");

    releaseRestart();
    expect(await pending).not.toBeNull();
  });

  it("重試再次失敗後，仍能再重試一次", async () => {
    mockHappyPath();
    vi.mocked(sidecar.restartSidecar).mockRejectedValueOnce(new Error("restart boom"));
    expect(await useAppStore.getState().bootstrap({ restart: true })).toBeNull();

    vi.mocked(sidecar.restartSidecar).mockResolvedValue(4321);
    expect(await useAppStore.getState().bootstrap({ restart: true })).not.toBeNull();
    expect(sidecar.restartSidecar).toHaveBeenCalledTimes(2);
  });

  it("不帶 restart 時不呼叫 restartSidecar", async () => {
    mockHappyPath();
    await useAppStore.getState().bootstrap();
    expect(sidecar.restartSidecar).not.toHaveBeenCalled();
  });

  // R1／R2：專案掃描失敗不致命——config 已載入，設定頁與加根目錄都還走得通
  it("loadProjects 失敗時 startup 仍 ready，錯誤由回傳值帶出", async () => {
    mockHappyPath();
    vi.mocked(sidecar.fetchProjects).mockRejectedValue(new Error("scan failed"));
    const r = await useAppStore.getState().bootstrap();
    expect(useAppStore.getState().startup).toBe("ready");
    expect(r?.projectsError).toMatch(/scan failed/);
  });

  it("config 畸形（fetchConfig throw）時停在 failed", async () => {
    mockHappyPath();
    vi.mocked(sidecar.fetchConfig).mockRejectedValue(new Error("fetchConfig: unusable config shape"));
    expect(await useAppStore.getState().bootstrap()).toBeNull();
    expect(useAppStore.getState().startup).toBe("failed");
  });
});

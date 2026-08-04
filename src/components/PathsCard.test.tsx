// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import type { ProjectPath } from "../lib/sidecar";
import { PathsCard, type ProjectMapping } from "./PathsCard";

const pickDirectory = vi.fn<() => Promise<string | null>>();
const fetchProjectPaths = vi.fn<(port: number, dest: string) => Promise<ProjectPath[]>>();

vi.mock("../lib/dialog", () => ({ pickDirectory: () => pickDirectory(), pickFile: vi.fn() }));
vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchProjectPaths: (port: number, dest: string) => fetchProjectPaths(port, dest),
}));

const PROJECTS: ProjectPath[] = [
  { account: "work", old_path: "/Users/olduser/work/app", encoded_dir: "-Users-olduser-work-app",
    suggested: "/Users/me/work/app", suggested_exists: true },
  { account: "work", old_path: "/Volumes/NAS/side", encoded_dir: "-Volumes-NAS-side",
    suggested: "", suggested_exists: false },
];

/** 對應關係住在精靈（離開這頁再回來要還在），測試得把它回寫成 props——否則連建議值
 *  都不會出現在畫面上（那是父層的職責）。 */
function Harness({ total = 3, spy, initial = {}, port = 1234, dest = "/tmp/staging",
                  sourceGen = 1, onStatus }: {
  total?: number; spy?: (m: ProjectMapping) => void; initial?: ProjectMapping;
  port?: number; dest?: string; sourceGen?: number;
  onStatus?: (s: string) => void;
}) {
  const [mapping, setMapping] = useState<ProjectMapping>(initial);
  return (
    <PathsCard port={port} dest={dest} projectCount={total} sourceGen={sourceGen}
               mapping={mapping}
               onMapping={(m) => {
                 setMapping(m);
                 spy?.(m);
               }}
               onStatus={onStatus ?? (() => {})} />
  );
}

const setup = (props: Parameters<typeof Harness>[0] = {}) => render(<Harness {...props} />);
const skipText = (names: string) => zh.mig.paths.skipNote.replace("{{names}}", names);
const countText = (total: number, listed: number) =>
  zh.mig.paths.count.replace("{{total}}", String(total)).replace("{{listed}}", String(listed));

async function loaded(ui: ReturnType<typeof render>) {
  await waitFor(() => expect(ui.getByDisplayValue("/Users/me/work/app")).toBeTruthy());
}

describe("PathsCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    fetchProjectPaths.mockResolvedValue(PROJECTS);
  });
  afterEach(cleanup);

  it("列出每個專案的舊路徑、建議新路徑與那個位置存不存在", async () => {
    const ui = setup();
    await loaded(ui);
    expect(ui.getByText("/Users/olduser/work/app")).toBeTruthy();
    expect(ui.getByText("/Volumes/NAS/side")).toBeTruthy();
    expect(ui.getAllByText(zh.mig.paths.exists)).toHaveLength(1);   // 只有第一個已存在
  });

  // 增補 spec §2：`project_count` 只數目錄，`project_paths()` 會跳過讀不出 cwd 的專案。
  // 兩個數字不同是**預期的**——不講清楚使用者會以為少的那個是 bug
  it("包裡的專案數與可對應的筆數不同時，講清楚差在哪", async () => {
    const ui = setup({ total: 3 });
    await loaded(ui);
    expect(ui.getByText(countText(3, 2))).toBeTruthy();
    expect(ui.getByText(zh.mig.paths.countNote)).toBeTruthy();
  });

  it("留空＝照搬不改寫，而且要明講 /resume 會列不出來", async () => {
    const ui = setup();
    await loaded(ui);
    // 推不出建議值的那一項一開始就是空的
    expect(ui.getByText(skipText("/Volumes/NAS/side"))).toBeTruthy();
    fireEvent.change(ui.getByDisplayValue("/Users/me/work/app"), { target: { value: "  " } });
    await waitFor(() => expect(
      ui.getByText(skipText("/Users/olduser/work/app、/Volumes/NAS/side"))).toBeTruthy());
  });

  it("填好的對應回報給精靈，留空的不進 mapping", async () => {
    const onMapping = vi.fn<(m: ProjectMapping) => void>();
    const ui = setup({ spy: onMapping });
    await loaded(ui);
    fireEvent.change(ui.getByDisplayValue("/Users/me/work/app"),
                     { target: { value: "/Users/me/elsewhere" } });
    await waitFor(() => expect(onMapping).toHaveBeenLastCalledWith({
      "/Users/olduser/work/app": "/Users/me/elsewhere",
    }));

    // 清空要**移除**那一筆而不是留一個空字串——空字串送到後端是 `mapping_not_absolute`，
    // 而使用者的意思是「這個專案照搬」
    fireEvent.change(ui.getByDisplayValue("/Users/me/elsewhere"), { target: { value: "  " } });
    await waitFor(() => expect(onMapping).toHaveBeenLastCalledWith({}));
  });

  // 這一頁不寫任何東西，狀態全在前端——回來時已填的必須還在
  it("已填的對應由精靈保存，重新掛載後還在（建議值不覆蓋它）", async () => {
    const ui = setup({ initial: { "/Users/olduser/work/app": "/Users/me/kept" } });
    await waitFor(() => expect(ui.getByDisplayValue("/Users/me/kept")).toBeTruthy());
    expect(ui.queryByDisplayValue("/Users/me/work/app")).toBeNull();
  });

  it("新位置不存在不擋，只提示", async () => {
    const ui = setup();
    await loaded(ui);
    expect(ui.getByText(zh.mig.paths.missingNote)).toBeTruthy();
  });

  it("沒有可對應的專案 → 明確說可以直接往下走", async () => {
    fetchProjectPaths.mockResolvedValue([]);
    const ui = setup({ total: 0 });
    await waitFor(() => expect(ui.getByText(zh.mig.paths.none)).toBeTruthy());
  });

  it("讀不出專案清單 → 通用訊息，例外原文不進畫面", async () => {
    fetchProjectPaths.mockRejectedValueOnce(new Error("PATHS-SENTINEL-500"));
    const ui = setup();
    await waitFor(() => expect(ui.getByText(zh.mig.paths.errors.loadFailed)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("PATHS-SENTINEL-500");
  });
});

describe("PathsCard 的來源切換與載入狀態", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    fetchProjectPaths.mockResolvedValue(PROJECTS);
  });
  afterEach(cleanup);

  // Codex 票 04 R1 F2：`seeded` 原本是元件生命週期的全域布林，換了一包之後不會重設，
  // 新來源的建議值因此永遠填不進去
  it("換了一包（sourceGen 變）→ 重新填新包的建議值", async () => {
    const ui = render(<Harness sourceGen={1} />);
    await waitFor(() => expect(ui.getByDisplayValue("/Users/me/work/app")).toBeTruthy());

    fetchProjectPaths.mockResolvedValue([{
      account: "work", old_path: "/Users/olduser/other", encoded_dir: "-Users-olduser-other",
      suggested: "/Users/me/other", suggested_exists: false,
    }]);
    ui.rerender(<Harness sourceGen={2} dest="/tmp/staging-2" />);

    await waitFor(() => expect(ui.getByDisplayValue("/Users/me/other")).toBeTruthy());
  });

  // Codex 票 04 R1 F2：沒有 request generation 的話，舊 port 的慢回應會蓋掉新的結果
  it("舊來源的慢回應晚於新來源抵達 → 不得覆蓋", async () => {
    let releaseOld: (p: ProjectPath[]) => void = () => {};
    fetchProjectPaths.mockImplementationOnce(
      () => new Promise<ProjectPath[]>((resolve) => { releaseOld = resolve; }));
    const ui = render(<Harness sourceGen={1} />);

    fetchProjectPaths.mockResolvedValue([{
      account: "work", old_path: "/new/only", encoded_dir: "-new-only",
      suggested: "/Users/me/new", suggested_exists: false,
    }]);
    ui.rerender(<Harness sourceGen={2} dest="/tmp/staging-2" />);
    await waitFor(() => expect(ui.getByText("/new/only")).toBeTruthy());

    releaseOld(PROJECTS);                       // 舊來源的回應現在才到
    await waitFor(() => expect(ui.getByText("/new/only")).toBeTruthy());
    expect(ui.queryByText("/Users/olduser/work/app")).toBeNull();
  });

  // Codex 票 04 R1 F3：讀取失敗還放行 → 使用者在看不到任何專案、也沒有任何對應的情況下
  // 繼續，install 就把所有歷史原樣搬過去，`/resume` 全部列不出來。那**不是**他選的「照搬」
  it("載入中與失敗都要回報給精靈（它據此決定放不放行）", async () => {
    const onStatus = vi.fn<(s: string) => void>();
    fetchProjectPaths.mockRejectedValueOnce(new Error("boom"));
    const ui = render(<Harness onStatus={onStatus} />);
    await waitFor(() => expect(ui.getByText(zh.mig.paths.errors.loadFailed)).toBeTruthy());
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(["loading", "error"]);
  });

  // Codex 票 04 R2：`port == null`（sidecar 還沒起來／掛掉）時原本直接 return，連 loading
  // 都不回報——精靈那側的 status 會停在上一次的 `loaded`，於是在「根本讀不到清單」的
  // 狀態下放行
  it("sidecar 還沒起來 → 回報 loading 而不是沉默", async () => {
    const onStatus = vi.fn<(s: string) => void>();
    render(<Harness port={null as unknown as number} onStatus={onStatus} />);
    await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("loading"));
    expect(fetchProjectPaths).not.toHaveBeenCalled();
  });

  it("成功載入回報 loaded", async () => {
    const onStatus = vi.fn<(s: string) => void>();
    const ui = render(<Harness onStatus={onStatus} />);
    await waitFor(() => expect(ui.getByDisplayValue("/Users/me/work/app")).toBeTruthy());
    expect(onStatus).toHaveBeenLastCalledWith("loaded");
  });

  // Codex 票 04 R1 F4：後端逐 account 掃描，兩個帳號可以合法含同一個專案目錄。
  // mapping 的 key 是舊絕對路徑（與後端 `_validate_mapping` 的契約一致，它以 cwd 驗身），
  // 所以同一條舊路徑**本來就會同時套用到兩個帳號**——UI 要合併成一列並說清楚，
  // 而不是畫兩個看起來各自獨立、實際連動的輸入框
  it("兩個帳號有同一條舊路徑 → 合併成一列並說明會同時套用", async () => {
    fetchProjectPaths.mockResolvedValue([
      { account: "work", old_path: "/shared/proj", encoded_dir: "-shared-proj",
        suggested: "/Users/me/proj", suggested_exists: false },
      { account: "personal", old_path: "/shared/proj", encoded_dir: "-shared-proj",
        suggested: "/Users/me/proj", suggested_exists: false },
    ]);
    const ui = render(<Harness total={2} />);
    await waitFor(() => expect(ui.getByDisplayValue("/Users/me/proj")).toBeTruthy());

    expect(ui.getAllByDisplayValue("/Users/me/proj")).toHaveLength(1);   // 一列不是兩列
    expect(ui.getByText(zh.mig.paths.shared)).toBeTruthy();
    expect(ui.getByText("personal, work")).toBeTruthy();                 // 兩個帳號都列出來
  });
});

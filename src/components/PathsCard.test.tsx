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
function Harness({ total = 3, spy, initial = {} }: {
  total?: number; spy?: (m: ProjectMapping) => void; initial?: ProjectMapping;
}) {
  const [mapping, setMapping] = useState<ProjectMapping>(initial);
  return (
    <PathsCard port={1234} dest="/tmp/staging" projectCount={total}
               mapping={mapping}
               onMapping={(m) => {
                 setMapping(m);
                 spy?.(m);
               }} />
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

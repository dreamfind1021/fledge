// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import { useAppStore } from "../store/useAppStore";
import {
  SetupError,
  type Project,
  type TemplateDeployResult,
  type TemplateInfo,
  type TemplatePlan,
} from "../lib/sidecar";
import { TemplateCard } from "./TemplateCard";

const fetchTemplates = vi.fn<(port: number) => Promise<TemplateInfo[]>>();
const templatesPlan = vi.fn<(port: number, template: string, destination: string) => Promise<TemplatePlan>>();
const templatesDeploy =
  vi.fn<(port: number, template: string, destination: string) => Promise<TemplateDeployResult>>();
const pickDirectory = vi.fn<() => Promise<string | null>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchTemplates: (port: number) => fetchTemplates(port),
  templatesPlan: (port: number, template: string, destination: string) => templatesPlan(port, template, destination),
  templatesDeploy: (port: number, template: string, destination: string) =>
    templatesDeploy(port, template, destination),
}));
vi.mock("../lib/dialog", () => ({ pickDirectory: () => pickDirectory() }));

const TEMPLATES: TemplateInfo[] = [
  {
    id: "project-starter", label: "Project starter", description: "en fallback",
    source_class: "public", available: true,
  },
  {
    id: "kms-seed", label: "Knowledge base seed", description: "en fallback",
    source_class: "private", available: false,
  },
];

const project = (name: string, path: string): Project => ({
  name, path, account: "work", source: "root", root: "/Users/x/work", recent: null,
});

const plan = (over: Partial<TemplatePlan> = {}): TemplatePlan => ({
  template: "project-starter",
  destination: "/Users/x/work/fledge",
  state: "not_installed",
  operations: [{ path: "CLAUDE.md", type: "file", state: "missing" }],
  ...over,
});

const renderCard = (port: number | null = 1234) => render(<TemplateCard port={port} />);
const rows = (ui: ReturnType<typeof render>) => [...ui.container.querySelectorAll(".b4-item")];
const settled = (ui: ReturnType<typeof render>) => waitFor(() => expect(rows(ui)).toHaveLength(TEMPLATES.length));

describe("TemplateCard 範本卡（精靈版）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW"); // 固定語言，斷言才對得上 catalog
    fetchTemplates.mockReset().mockResolvedValue(TEMPLATES);
    templatesPlan.mockReset().mockResolvedValue(plan());
    templatesDeploy.mockReset().mockResolvedValue({
      template: "project-starter",
      destination: "/Users/x/work/fledge",
      results: [
        { path: "CLAUDE.md", outcome: "created", error: null },
        { path: "docs", outcome: "skipped", error: null },
      ],
    });
    pickDirectory.mockReset().mockResolvedValue(null);
    useAppStore.setState({
      port: 1234,
      projects: [project("fledge", "/Users/x/work/fledge"), project("llm-wiki", "/Users/x/work/llm-wiki")],
    });
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  // public build 只內建 project-starter，另兩個必然是「未內建」——那是正常狀態，
  // 不能隱藏（使用者會以為 Fledge 少了功能）也不能崩潰
  it("allowlist 全部列出；未內建者標「未內建」且沒有部署鈕", async () => {
    const ui = renderCard();
    await settled(ui);

    // 名稱與說明都走 catalog：後端的 label／description 一律英文，拿它當常態文案會讓中文版露出英文
    expect(rows(ui)[0].textContent).toContain(zh.sys.tpl["project-starter"].name);
    expect(rows(ui)[1].textContent).toContain(zh.sys.tpl["kms-seed"].name);
    expect(ui.container.textContent).not.toContain("Project starter");
    expect(rows(ui)[1].textContent).toContain(zh.sys.notBundled);
    expect(rows(ui)[1].querySelector(".b4-dot")?.className).toContain("na");
    // 未內建的範本按了也只會拿到 template_unavailable，不給按才誠實
    expect(ui.getAllByText(zh.sys.deploy)).toHaveLength(1);
    expect(rows(ui)[0].textContent).toContain(zh.sys.tpl["project-starter"].desc);
    expect(ui.container.textContent).not.toContain("en fallback");
  });

  it("目的地預設第一個掃到的專案，並以它預覽每個可用範本的狀態", async () => {
    const ui = renderCard();
    await settled(ui);

    await waitFor(() => expect(templatesPlan).toHaveBeenCalledWith(1234, "project-starter", "/Users/x/work/fledge"));
    expect(templatesPlan).toHaveBeenCalledTimes(1); // 未內建的不預覽
    expect(rows(ui)[0].textContent).toContain(zh.sys.state.not_installed);
    expect(ui.container.querySelector("select")).toHaveProperty("value", "/Users/x/work/fledge");
  });

  it("「其他位置…」走 picker：選到就換目的地重新預覽，取消則維持原本的", async () => {
    const ui = renderCard();
    await settled(ui);
    await waitFor(() => expect(templatesPlan).toHaveBeenCalledTimes(1));

    const select = ui.container.querySelector("select")!;
    const other = [...select.querySelectorAll("option")].find((o) => o.textContent === zh.sys.otherLocation)!;

    fireEvent.change(select, { target: { value: other.value } }); // 取消
    await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1));
    expect(select.value).toBe("/Users/x/work/fledge");
    expect(templatesPlan).toHaveBeenCalledTimes(1);

    pickDirectory.mockResolvedValue("/Users/x/elsewhere");
    fireEvent.change(select, { target: { value: other.value } });
    await waitFor(() =>
      expect(templatesPlan).toHaveBeenLastCalledWith(1234, "project-starter", "/Users/x/elsewhere"),
    );
    expect(select.value).toBe("/Users/x/elsewhere");
  });

  it("部署後顯示逐檔結果（含已存在保留原檔）並重新預覽狀態", async () => {
    const ui = renderCard();
    await settled(ui);
    await waitFor(() => expect(templatesPlan).toHaveBeenCalledTimes(1));
    templatesPlan.mockResolvedValue(plan({ state: "complete", operations: [] }));

    fireEvent.click(ui.getByText(zh.sys.deploy));

    await waitFor(() => expect(ui.getByText(zh.sys.result.created)).toBeTruthy());
    expect(templatesDeploy).toHaveBeenCalledWith(1234, "project-starter", "/Users/x/work/fledge");
    expect(ui.getByText(zh.sys.result.skipped)).toBeTruthy();
    expect(ui.container.textContent).toContain("CLAUDE.md");
    expect(ui.container.textContent).toContain("docs");
    // 狀態一律即時偵測（spec-b4 §4）：部署後要重新 plan，chip 換成最新狀態
    await waitFor(() => expect(rows(ui)[0].textContent).toContain(zh.sys.state.complete));
    expect(templatesPlan).toHaveBeenCalledTimes(2);
  });

  it("判別碼映射成文案，不把判別碼顯示給使用者", async () => {
    templatesDeploy.mockRejectedValue(new SetupError("unsafe_destination", 400));
    const ui = renderCard();
    await settled(ui);

    fireEvent.click(ui.getByText(zh.sys.deploy));

    await waitFor(() => expect(ui.getByText(zh.errors.unsafe_destination)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("unsafe_destination");
  });

  it("未映射的判別碼退到通用文案，原碼只進 console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    templatesDeploy.mockRejectedValue(new SetupError("brand_new_code", 400));
    const ui = renderCard();
    await settled(ui);

    fireEvent.click(ui.getByText(zh.sys.deploy));

    await waitFor(() => expect(ui.getByText(zh.errors.template_failed)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("brand_new_code");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // 根目錄可能一個專案都沒掃到；沒有目的地就沒有「部署到哪」，按鈕不能亮著
  it("沒有任何目的地：部署鈕停用並說明要先選目的地", async () => {
    useAppStore.setState({ projects: [] });
    const ui = renderCard();
    await settled(ui);

    expect((ui.getByText(zh.sys.deploy) as HTMLButtonElement).disabled).toBe(true);
    expect(ui.getByText(zh.sys.needDest)).toBeTruthy();
    expect(templatesPlan).not.toHaveBeenCalled();
  });

  // 選過的專案可能因為移除 root／重新掃描而從清單消失。若不把它留在 options 裡，
  // select 會找不到相符項而顯示空白，部署卻仍寫往那個看不見的舊路徑
  it("選過的專案從清單消失：仍留在下拉裡，畫面與實際部署目的地一致", async () => {
    const ui = renderCard();
    await settled(ui);

    const select = ui.container.querySelector("select")!;
    fireEvent.change(select, { target: { value: "/Users/x/work/llm-wiki" } });
    await waitFor(() => expect(templatesPlan).toHaveBeenLastCalledWith(1234, "project-starter", "/Users/x/work/llm-wiki"));

    // 專案清單重載後少了剛選的那個
    await act(async () => {
      useAppStore.setState({ projects: [project("fledge", "/Users/x/work/fledge")] });
    });

    expect(select.value).toBe("/Users/x/work/llm-wiki");
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toContain("/Users/x/work/llm-wiki");
    fireEvent.click(ui.getByText(zh.sys.deploy));
    await waitFor(() =>
      expect(templatesDeploy).toHaveBeenCalledWith(1234, "project-starter", "/Users/x/work/llm-wiki"),
    );
  });

  // 換目的地會讓兩輪預覽重疊：晚到的舊回應照樣寫進 state 的話，畫面會顯示上一個目的地的狀態
  it("舊目的地的預覽晚回：不覆蓋新目的地的畫面，舊逐檔結果也不留著", async () => {
    let releaseOld = (_p: TemplatePlan) => {};
    templatesPlan.mockImplementationOnce(() => new Promise<TemplatePlan>((resolve) => { releaseOld = resolve; }));
    const ui = renderCard();
    await settled(ui);
    await waitFor(() => expect(templatesPlan).toHaveBeenCalledTimes(1)); // 第一輪懸在半空

    // 先部署一次（第一個目的地）留下逐檔結果，再換目的地
    fireEvent.click(ui.getByText(zh.sys.deploy));
    await waitFor(() => expect(ui.getByText(zh.sys.result.created)).toBeTruthy());

    templatesPlan.mockResolvedValue(plan({ destination: "/Users/x/work/llm-wiki", state: "complete" }));
    fireEvent.change(ui.container.querySelector("select")!, { target: { value: "/Users/x/work/llm-wiki" } });
    await waitFor(() => expect(rows(ui)[0].textContent).toContain(zh.sys.state.complete));
    // 換目的地＝上一個目的地的逐檔結果不再描述畫面上的東西
    expect(ui.queryByText(zh.sys.result.created)).toBeNull();

    await act(async () => { releaseOld(plan({ state: "not_installed" })); }); // 舊的這才回來
    expect(rows(ui)[0].textContent).toContain(zh.sys.state.complete);
    expect(rows(ui)[0].textContent).not.toContain(zh.sys.state.not_installed);
  });

  // self-use build 可能同時有三個可用範本；一個壞掉不該讓另外兩個成功的狀態一起消失
  it("多個可用範本中一個預覽失敗：其餘照常顯示狀態，錯誤另外講", async () => {
    fetchTemplates.mockResolvedValue([
      TEMPLATES[0],
      { ...TEMPLATES[1], available: true },
    ]);
    templatesPlan.mockImplementation(async (_p, template) => {
      if (template === "kms-seed") throw new SetupError("template_unavailable", 400);
      return plan();
    });
    const ui = renderCard();
    await settled(ui);

    await waitFor(() => expect(ui.getByText(zh.errors.template_unavailable)).toBeTruthy());
    expect(rows(ui)[0].textContent).toContain(zh.sys.state.not_installed); // 好的那個還在
  });

  it("清單載入失敗：顯示通用文案，不外洩 HTTP 細節", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchTemplates.mockRejectedValue(new Error("HTTP 500"));
    const ui = renderCard();

    await waitFor(() => expect(ui.getByText(zh.errors.templates_failed)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("HTTP 500");
    warn.mockRestore();
  });
});

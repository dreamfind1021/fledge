// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import { useAppStore } from "../store/useAppStore";
import type { CommonConfigPlan, DirStatus, TemplateInfo, TemplatePlan } from "../lib/sidecar";
import { DevEnvSection } from "./DevEnvSection";

const checkDir = vi.fn<(port: number, path: string) => Promise<DirStatus>>();
const commonConfigPlan = vi.fn<() => Promise<CommonConfigPlan>>();
const fetchTemplates = vi.fn<() => Promise<TemplateInfo[]>>();
const templatesPlan = vi.fn<() => Promise<TemplatePlan>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  checkDir: (port: number, path: string) => checkDir(port, path),
  commonConfigPlan: () => commonConfigPlan(),
  fetchTemplates: () => fetchTemplates(),
  templatesPlan: () => templatesPlan(),
}));
vi.mock("../lib/dialog", () => ({ pickDirectory: vi.fn() }));

const accounts = {
  work: { config_dir: "~/.claude", label: "工作" },
  personal: { config_dir: "~/.claude-tc", label: "私人" },
};

const onRerun = vi.fn<() => void>();
const renderSection = () =>
  render(<DevEnvSection port={1234} accounts={accounts} onRerunOnboarding={onRerun} />);

describe("DevEnvSection 設定頁「開發環境」區", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW"); // 固定語言，斷言才對得上 catalog
    onRerun.mockReset();
    checkDir.mockReset().mockResolvedValue("dir");
    commonConfigPlan.mockReset().mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        {
          account: "personal", entry: "commands", target_path: "/t/commands",
          state: "missing", action: "create_link", needs_overwrite: false,
        },
        {
          account: "personal", entry: "CLAUDE.md", target_path: "/t/CLAUDE.md",
          state: "content_differs", action: "backup_and_copy", needs_overwrite: true,
        },
      ],
    });
    fetchTemplates.mockReset().mockResolvedValue([
      {
        id: "project-starter", label: "Project starter", description: "en",
        source_class: "public", available: true,
      },
    ]);
    templatesPlan.mockReset().mockResolvedValue({
      template: "project-starter", destination: "/p", state: "not_installed", operations: [],
    });
    useAppStore.setState({ port: 1234, projects: [] });
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  // 收合狀態下唯一看得到的訊號就是標題上的數字，所以卡片即使沒展開也要先偵測
  it("預設收合，但標題已經顯示待處理項目數", async () => {
    const ui = renderSection();

    await waitFor(() => expect(ui.getByText(zh.st.pending.replace("{{count}}", "2"))).toBeTruthy());
    expect(ui.container.querySelector(".st-fold-body")?.hasAttribute("hidden")).toBe(true);
    expect(ui.container.querySelector(".st-fold-h")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("展開後嵌著設定頁版共通設置卡與範本卡（同一元件，不是複製一份）", async () => {
    const ui = renderSection();
    await waitFor(() => expect(commonConfigPlan).toHaveBeenCalled());

    fireEvent.click(ui.getByText(zh.st.devEnv));

    expect(ui.container.querySelector(".st-fold-body")?.hasAttribute("hidden")).toBe(false);
    // 設定頁版的標誌：逐項授權勾選框 + 套用鍵（精靈版是 chip + 導覽列）
    await waitFor(() => expect(ui.container.querySelector(".st-check input")).toBeTruthy());
    expect(ui.getByText(zh.st.apply)).toBeTruthy();
    expect(ui.queryByText(zh.common.next)).toBeNull();
    // 範本卡也在
    await waitFor(() => expect(ui.getByText(zh.sys.tplTitle)).toBeTruthy());
    expect(ui.getByText(zh.sys.tpl["project-starter"].name)).toBeTruthy();
  });

  // 票 22 定案「中途離開不再自動彈」的配套出口：沒有這顆按鈕，中途離開的使用者就沒有回頭路
  it("「重跑引導」按鈕通知呼叫端重開精靈", async () => {
    const ui = renderSection();
    fireEvent.click(ui.getByText(zh.st.devEnv));

    fireEvent.click(ui.getByText("重跑引導"));

    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  it("沒有待處理項目時不掛數字", async () => {
    commonConfigPlan.mockResolvedValue({
      source_dir: "/Users/x/.claude",
      operations: [
        {
          account: "personal", entry: "commands", target_path: "/t/commands",
          state: "ok", action: "skip", needs_overwrite: false,
        },
      ],
    });
    const ui = renderSection();

    await waitFor(() => expect(commonConfigPlan).toHaveBeenCalled());
    await waitFor(() => expect(ui.container.querySelector(".st-fold-h .b4-chip")).toBeNull());
  });
});

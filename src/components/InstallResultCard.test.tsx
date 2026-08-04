// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, cleanup } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import type { InstallItemResult } from "../lib/sidecar";
import { InstallResultCard } from "./InstallResultCard";

const revealItemInDir = vi.fn<(path: string) => Promise<void>>();
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (path: string) => revealItemInDir(path),
}));

const RESULTS: InstallItemResult[] = [
  { account: "work", rel_path: "CLAUDE.md", outcome: "installed", error: null },
  { account: "work", rel_path: "skills/a.md", outcome: "installed", error: null },
  { account: "work", rel_path: "settings.json", outcome: "skipped", error: null },
  { account: "work", rel_path: ".claude.json", outcome: "excluded",
    error: "not_migrated_by_design" },
  { account: "work", rel_path: "skills/b.md", outcome: "failed", error: "permission_denied" },
];

const onRetry = vi.fn<() => void>();

const setup = (results = RESULTS, staleTemps: string[] = []) =>
  render(
    <StrictMode>
      <InstallResultCard results={results} staleTemps={staleTemps} onRetry={onRetry} />
    </StrictMode>,
  );

describe("InstallResultCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    revealItemInDir.mockResolvedValue(undefined);   // 真的 opener 一定回 Promise
  });
  afterEach(cleanup);

  it("四類結果都報出來，數量各自正確", () => {
    const ui = setup();
    const count = (title: string) =>
      ui.getByText(title).closest(".ob-spot")!.querySelector(".ob-spot-key")!.textContent;
    expect(count(zh.mig.result.installed)).toBe("2");
    expect(count(zh.mig.result.skipped)).toBe("1");
    expect(count(zh.mig.result.excluded)).toBe("1");
    expect(count(zh.mig.result.failed)).toBe("1");
  });

  // 票面：失敗項要看得出原因——只給一個數字的話使用者不知道該修什麼
  it("失敗項預設展開，逐項看得到位置與原因", () => {
    const ui = setup();
    expect(ui.getByText(
      zh.mig.result.itemReason
        .replace("{{path}}", "work/skills/b.md")
        .replace("{{reason}}", zh.mig.result.reason.permission_denied))).toBeTruthy();
  });

  // 落點層的失敗（`target_moved`／`overlapping_config_dirs`／整個帳號沒裝成）後端回的
  // `rel_path` 是空字串——直接串成 `work/` 會多出一條看不懂的斜線路徑
  it("整個落點失敗時只顯示落點名稱，不串出空路徑", () => {
    const ui = setup([{ account: "work", rel_path: "", outcome: "failed",
                        error: "target_moved" }]);
    expect(ui.getByText(
      zh.mig.result.itemReason
        .replace("{{path}}", "work")
        .replace("{{reason}}", zh.mig.result.reason.target_moved))).toBeTruthy();
  });

  // CLAUDE.md §4.6.13：後端只回判別碼，畫面上不得出現碼本身
  it("沒見過的判別碼退通用文案，碼不進畫面", () => {
    const ui = setup([{ account: "work", rel_path: "x", outcome: "failed",
                        error: "brand_new_code_from_backend" }]);
    expect(ui.getByText(
      zh.mig.result.itemReason
        .replace("{{path}}", "work/x")
        .replace("{{reason}}", zh.mig.result.reason.unknown))).toBeTruthy();
    expect(ui.container.textContent).not.toContain("brand_new_code_from_backend");
  });

  // Codex 票 06 R2 F1：逐項與落點層的失敗都是 HTTP 200 的 results——所有落點都 target_moved
  // 時一項都沒成功，畫面若照樣宣告「內容已經寫進這台機器」，就是 R1 修掉的「斷言我們不知道
  // 的事」在成功路徑上的同一個形狀
  it("一項都沒成功時不得宣告已經寫進這台機器", () => {
    const ui = setup([
      { account: "work", rel_path: "", outcome: "failed", error: "target_moved" },
      { account: "personal", rel_path: "", outcome: "failed", error: "target_moved" },
    ]);
    expect(ui.getByText(zh.mig.result.sub.none)).toBeTruthy();
    expect(ui.queryByText(zh.mig.result.sub.ok)).toBeNull();
    expect(ui.queryByText(zh.mig.result.sub.partial)).toBeNull();
  });

  it("部分失敗說「有些沒裝成功」，不說全部搬完也不說什麼都沒搬", () => {
    const ui = setup(RESULTS);        // 2 installed + 1 skipped + 1 failed
    expect(ui.getByText(zh.mig.result.sub.partial)).toBeTruthy();
    expect(ui.queryByText(zh.mig.result.sub.ok)).toBeNull();
    expect(ui.queryByText(zh.mig.result.sub.none)).toBeNull();
  });

  it("全部順利才說內容已經寫進這台機器", () => {
    const ui = setup(RESULTS.filter((r) => r.outcome === "installed"));
    expect(ui.getByText(zh.mig.result.sub.ok)).toBeTruthy();
  });

  // 「東西在那裡」與「這一輪寫進去了」是兩件事：全部 skipped 代表每個目的地都已經有同名項、
  // 我們一個位元組都沒寫。把它說成「內容已經寫進這台機器」，就是拿「不覆蓋」的結果去宣稱
  // 搬過來了——使用者第一次裝進一個他自己已經有內容的落點時就會看到這個
  it("全部跳過時說清楚這一輪沒有寫入，而不是說內容已經寫進來", () => {
    const ui = setup([{ account: "work", rel_path: "CLAUDE.md",
                        outcome: "skipped", error: null }]);
    expect(ui.getByText(zh.mig.result.sub.allSkipped)).toBeTruthy();
    expect(ui.queryByText(zh.mig.result.sub.ok)).toBeNull();
    expect(ui.queryByText(zh.mig.result.sub.none)).toBeNull();
  });

  // 而 excluded 是刻意不處理，那才是真的什麼都沒有進來
  it("只有刻意不處理的項目時說什麼都沒搬進來", () => {
    const ui = setup([{ account: "work", rel_path: ".claude.json",
                        outcome: "excluded", error: "not_migrated_by_design" }]);
    expect(ui.getByText(zh.mig.result.sub.none)).toBeTruthy();
  });

  // 有東西在那裡、但也有失敗＝部分完成（不能因為 installed 是 0 就說什麼都沒搬）
  it("跳過與失敗混合時說部分沒成功", () => {
    const ui = setup([
      { account: "work", rel_path: "CLAUDE.md", outcome: "skipped", error: null },
      { account: "work", rel_path: "x.md", outcome: "failed", error: "no_space" },
    ]);
    expect(ui.getByText(zh.mig.result.sub.partial)).toBeTruthy();
  });

  // 增補 spec §2.5.2：連結不在預覽的任何數字裡，結果的 installed 大於預覽是**正常的**。
  // 文案不講清楚，使用者會以為東西被多搬了或哪裡出錯
  it("說明「已裝好」可能比預覽多是正常的", () => {
    const ui = setup();
    expect(ui.getByText(zh.mig.result.moreNote)).toBeTruthy();
  });

  // 增補 spec §4：殘骸只告知不代勞刪除，並把人帶到 Finder
  it("有殘骸時報出數量與位置，reveal 帶的是後端給的絕對路徑", () => {
    const ui = setup(RESULTS, ["/Users/me/.claude/.fledge-install-123-abcd1234"]);
    expect(ui.getByText(zh.mig.result.stale.h.replace("{{count}}", "1"))).toBeTruthy();
    expect(ui.getByText(zh.mig.result.stale.note)).toBeTruthy();
    expect(ui.getByText("/Users/me/.claude/.fledge-install-123-abcd1234")).toBeTruthy();

    ui.getByText(zh.mig.result.stale.reveal).click();
    expect(revealItemInDir)
      .toHaveBeenCalledWith("/Users/me/.claude/.fledge-install-123-abcd1234");
  });

  it("殘骸每一個都列出來，各自有自己的 reveal", () => {
    const paths = [
      "/Users/me/.claude/.fledge-install-1-aaaa",
      "/Users/me/.agents/.fledge-install-2-bbbb",
    ];
    const ui = setup(RESULTS, paths);
    expect(ui.getByText(zh.mig.result.stale.h.replace("{{count}}", "2"))).toBeTruthy();
    const buttons = ui.getAllByText(zh.mig.result.stale.reveal);
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(revealItemInDir).toHaveBeenCalledWith(paths[1]);
  });

  it("沒有殘骸時整行不出現（常態就是沒有）", () => {
    const ui = setup(RESULTS, []);
    expect(ui.queryByText(zh.mig.result.stale.note)).toBeNull();
    expect(ui.queryByText(zh.mig.result.stale.reveal)).toBeNull();
  });

  it("reveal 失敗不會炸掉畫面（Tauri 外殼不在時也一樣）", () => {
    revealItemInDir.mockRejectedValueOnce(new Error("REVEAL-SENTINEL"));
    const ui = setup(RESULTS, ["/Users/me/.claude/.fledge-install-1-aaaa"]);
    ui.getByText(zh.mig.result.stale.reveal).click();
    expect(ui.container.textContent).not.toContain("REVEAL-SENTINEL");
  });

  // 後端會對同一個落點 append 兩筆一模一樣的結果（reparenting 偵測：觸發方先替對方記一筆、
  // 迴圈走到對方時它自己又記一筆），跨帳號同名的 rel_path 也會撞。**兩列都要在**——
  // 吃掉一列就是漏報，而數量與明細對不上更讓人以為畫面壞了
  it("一模一樣的兩筆結果都列出來，不會被吃掉一列", () => {
    const dup: InstallItemResult = { account: "work", rel_path: "", outcome: "failed",
                                     error: "overlapping_config_dirs" };
    const ui = setup([dup, { ...dup }]);
    const section = ui.getByText(zh.mig.result.failed).closest(".ob-spot")!;
    expect(section.querySelector(".ob-spot-key")!.textContent).toBe("2");
    expect(section.querySelectorAll(".ob-spot-oldpath")).toHaveLength(2);
  });

  // 票 16 第 4 項：精靈**刻意不給中途關閉**，所以安裝失敗的人原本唯一的出路是走完環境／
  // 登入／修復三頁再繞回設定頁的還原卡。這顆按鈕就是把同一個請求再送一次（marker 與
  // journal 都還在，no-clobber 保證安全），不是第二份續作實作
  it("有失敗時給「再試一次」，按下去把重試交回上層", () => {
    const ui = setup();
    ui.getByText(zh.mig.result.retry).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // 沒有失敗還給重試，等於鼓勵重複執行不可逆操作
  it("全部順利時不給「再試一次」", () => {
    const ui = setup(RESULTS.filter((r) => r.outcome === "installed"));
    expect(ui.queryByText(zh.mig.result.retry)).toBeNull();
  });

  it("某一類是空的就整段不出現（不顯示 0）", () => {
    const ui = setup(RESULTS.filter((r) => r.outcome === "installed"));
    expect(ui.queryByText(zh.mig.result.failed)).toBeNull();
    expect(ui.queryByText(zh.mig.result.skipped)).toBeNull();
  });
});

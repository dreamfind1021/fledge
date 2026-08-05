// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import zhRestore from "../locales/zh-TW/restore.json";
import { RestoreError, type AdoptConfigBody, type BundleInfo, type LandingSuggestions } from "../lib/sidecar";
import { TargetsCard } from "./TargetsCard";

const pickDirectory = vi.fn<() => Promise<string | null>>();
const fetchLandingSuggestions = vi.fn<(port: number, dest: string) => Promise<LandingSuggestions>>();
const adoptConfig = vi.fn<(port: number, body: AdoptConfigBody) => Promise<void>>();

vi.mock("../lib/dialog", () => ({ pickDirectory: () => pickDirectory(), pickFile: vi.fn() }));
vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  fetchLandingSuggestions: (port: number, dest: string) => fetchLandingSuggestions(port, dest),
  adoptConfig: (port: number, body: AdoptConfigBody) => adoptConfig(port, body),
}));

const INFO: BundleInfo = {
  host: "old-mac", created: "x",
  accounts: ["nas", "work"], extra: [".agents"], project_count: 9,
};

const SUGGESTIONS: LandingSuggestions = {
  home: "/Users/olduser",
  spots: [
    { key: ".agents", kind: "extra", old_path: "/Users/olduser/.agents",
      suggested: "/Users/me/.agents", suggested_exists: true },
    { key: "nas", kind: "account", old_path: "/Volumes/NAS/claude",
      suggested: "", suggested_exists: false },
    { key: "work", kind: "account", old_path: "/Users/olduser/.claude",
      suggested: "/Users/me/.claude", suggested_exists: false },
  ],
};

function Harness({ onDone, info = INFO }: { onDone?: () => void; info?: BundleInfo }) {
  const [saved, setSaved] = useState(false);
  return (
    <TargetsCard
      port={1234}
      dest="/tmp/staging"
      info={info}
      saved={saved}
      requestId="req-1"
      onSaved={() => {
        setSaved(true);
        onDone?.();
      }}
    />
  );
}

const setup = (props: Parameters<typeof Harness>[0] = {}) => render(<Harness {...props} />);

/** skipNote 的完整字串（插值位置也一起釘住——只比對 key 名的話，換個插值名不會被抓到）。 */
const skipText = (names: string) => zh.mig.targets.skipNote.replace("{{names}}", names);

/** 等建議值載入完成（三列都出現）。 */
async function loaded(ui: ReturnType<typeof render>) {
  await waitFor(() => expect(ui.getByDisplayValue("/Users/me/.claude")).toBeTruthy());
}

describe("TargetsCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    vi.clearAllMocks();
    fetchLandingSuggestions.mockResolvedValue(SUGGESTIONS);
    adoptConfig.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("每一項都有欄位，預填建議值並標示那個位置存不存在", async () => {
    const ui = setup();
    await loaded(ui);
    expect(ui.getByDisplayValue("/Users/me/.agents")).toBeTruthy();
    expect(ui.getByText("/Volumes/NAS/claude")).toBeTruthy();     // 舊機位置照樣顯示
    expect(ui.getAllByText(zh.mig.targets.exists)).toHaveLength(1);   // 只有 .agents 已存在
    expect(ui.getAllByText(zh.mig.targets.missing)).toHaveLength(1);  // work（nas 沒建議值不探測）
  });

  // 決策 9：舊路徑不在舊 home 底下就不猜，欄位留空並說明為什麼
  it("推不出建議值的那一項留空並說明", async () => {
    const ui = setup();
    await loaded(ui);
    expect(ui.getByText(zh.mig.targets.noSuggestion)).toBeTruthy();
  });

  it("送出的是使用者確認的落點，帳號與 extra 分開", async () => {
    const ui = setup();
    await loaded(ui);
    fireEvent.change(ui.getByDisplayValue("/Users/me/.claude"),
                     { target: { value: "/Users/me/work-claude" } });
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(adoptConfig).toHaveBeenCalledWith(1234, {
      request_id: "req-1",
      dest: "/tmp/staging",
      accounts: [{ key: "work", config_dir: "/Users/me/work-claude" }],
      extra: [{ name: ".agents", path: "/Users/me/.agents" }],
    }));
  });

  // 票 03 驗收：備份包裡有、但使用者沒給落點的帳號，**後端的預覽完全不會提到它**
  // （增補 spec §2.5.1）——這一頁必須自己講出來，否則使用者會以為都搬了
  it("留空的項目不會被搬，而且要明講是哪幾項", async () => {
    const ui = setup();
    await loaded(ui);
    expect(ui.getByText(skipText("nas"))).toBeTruthy();   // 沒建議值的那項一開始就是空的
    fireEvent.change(ui.getByDisplayValue("/Users/me/.agents"), { target: { value: "  " } });
    await waitFor(() => expect(ui.getByText(skipText(".agents、nas"))).toBeTruthy());
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(adoptConfig).toHaveBeenCalledWith(1234, {
      request_id: "req-1",
      dest: "/tmp/staging",
      accounts: [{ key: "work", config_dir: "/Users/me/.claude" }],
      extra: [],                                       // 留空的整項不送
    }));
  });

  it("一個帳號都沒填 → 擋住並說明，零請求", async () => {
    const ui = setup();
    await loaded(ui);
    fireEvent.change(ui.getByDisplayValue("/Users/me/.claude"), { target: { value: "" } });
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.needOne)).toBeTruthy());
    expect(adoptConfig).not.toHaveBeenCalled();
  });

  // 後端擋下來的判別碼都要有對應文案（不是通用訊息、更不是判別碼原文）
  it("落點重疊 → 顯示映射後的說法", async () => {
    adoptConfig.mockRejectedValueOnce(new RestoreError("overlapping_config_dirs", 400));
    const ui = setup();
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() =>
      expect(ui.getByText(zhRestore.errors.overlapping_config_dirs)).toBeTruthy());
  });

  // ── 票 15：冪等契約落地之後，前端不再推測「上一次到底寫進去了沒」 ──────────────
  //
  // 後端現在能分辨「這份 config 是不是這一次確認建的」（`request_id`），所以：
  //   · 同一次重送 → 200（後端回既有結果）→ 前端**每次都可以送**，不必記 `adopted`
  //   · 別的來源建的 → 409 + `created_by` → 把事實講出來，讓使用者決定要不要沿用
  // 票 03 R2–R4 連續三輪的 finding 全是那個推測旗標造成的，這裡拔掉的是根因。

  it("每次按下都真的送出——不再用元件內的旗標推測上一次寫進去了沒", async () => {
    // `adopted` 旗標只活在元件 state，卸載就沒了（票 03 R3）。後端冪等之後重送是安全的：
    // 同一個 request_id 回既有結果，不會建立第二份。
    const onSaved = vi.fn(async (_c: unknown, _r: boolean) => {
      throw Object.assign(new Error("reload failed"), { code: null });
    });
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} saved={false}
                   requestId="req-1" onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.errors.reloadFailed)).toBeTruthy());

    ui.getByText(zh.mig.targets.retry).click();
    await waitFor(() => expect(adoptConfig).toHaveBeenCalledTimes(2));
    // 兩次都帶同一個 request_id——那正是後端判「同一次確認」的依據
    expect(adoptConfig.mock.calls.map((c) => c[1].request_id)).toEqual(["req-1", "req-1"]);
  });

  it("設定檔是別的來源建的 → 把事實講出來，讓使用者選沿用或停下來", async () => {
    adoptConfig.mockRejectedValue(new RestoreError("config_already_initialized", 409, {
      source: "adopt-config", request_id: "req-OTHER", dest: "/tmp/unpack-A",
    }));
    const onSaved = vi.fn(async (_c: unknown, _r: boolean) => {});
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/unpack-B" info={INFO} saved={false}
                   requestId="req-B" onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();

    // 兩個展開位置都要看得見——那是使用者唯一分得出「這不是同一包」的線索
    await waitFor(() => expect(ui.getByText("/tmp/unpack-A")).toBeTruthy());
    expect(ui.getByText("/tmp/unpack-B")).toBeTruthy();
    // **不自動放行**：收尾還沒跑，下一步也就還被擋著
    expect(onSaved).not.toHaveBeenCalled();

    ui.getByText(zh.mig.targets.conflict.reuse).click();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0][1]).toBe(true);   // reused＝沿用既有的，不是這次建的
  });

  it("衝突時選「停下來」→ 不跑收尾，畫面留在這一頁", async () => {
    adoptConfig.mockRejectedValue(new RestoreError("config_already_initialized", 409, {
      source: "onboard",
    }));
    const onSaved = vi.fn(async (_c: unknown, _r: boolean) => {});
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/unpack-B" info={INFO} saved={false}
                   requestId="req-B" onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.conflict.stop)).toBeTruthy());

    ui.getByText(zh.mig.targets.conflict.stop).click();
    await waitFor(() => expect(ui.queryByText(zh.mig.targets.conflict.stop)).toBeNull());
    expect(onSaved).not.toHaveBeenCalled();
    // 回到可以重按的狀態——停下來不是死路
    expect(ui.getByText(zh.mig.targets.save)).toBeTruthy();
  });

  it("來源摘要缺 dest（onboard 建的）→ 說得出是誰建的，不印出 undefined", async () => {
    adoptConfig.mockRejectedValue(new RestoreError("config_already_initialized", 409, {
      source: "onboard",
    }));
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/unpack-B" info={INFO} saved={false}
                   requestId="req-B" onSaved={vi.fn(async () => {})} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.conflict.fromOnboard)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("undefined");
  });

  // 票 03 R4 F2 的價值在票 15 之後仍然成立：沿用既有設定之後那段說明**必須是中性的**
  // ——它會配著成功狀態一起留在畫面上，這時顯示「請移除既有設定檔」那種指示會讓使用者
  // 去做危險的事。（「409 要不要自動轉收尾」那一半已被票 15 取代：現在停下來問使用者。）
  it("沿用之後收尾失敗 → 重試只重跑收尾，不再問一次要不要沿用", async () => {
    // Codex 票 15 R1 F2：選「沿用」是**使用者的決策**，不是對後端狀態的推測——記住它
    // 是合法的。不記的話重試會重新 POST、拿到同一個 409、又要他再選一次，暫時性的讀取
    // 失敗就變成重複確認的迴圈。
    adoptConfig.mockRejectedValue(new RestoreError("config_already_initialized", 409, {
      source: "onboard",
    }));
    let reloads = 0;
    const onSaved = vi.fn(async (_c: unknown, _r: boolean) => {
      reloads += 1;
      if (reloads === 1) throw Object.assign(new Error("reload"), { code: null });
    });
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} saved={false}
                   requestId="req-1" onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.conflict.reuse)).toBeTruthy());
    ui.getByText(zh.mig.targets.conflict.reuse).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.errors.reloadFailed)).toBeTruthy());

    ui.getByText(zh.mig.targets.retry).click();
    await waitFor(() => expect(reloads).toBe(2));
    expect(adoptConfig).toHaveBeenCalledTimes(1);            // 沒有再 POST
    expect(ui.queryByText(zh.mig.targets.conflict.reuse)).toBeNull();   // 沒有再問一次
    expect(onSaved.mock.calls.map((c) => c[1])).toEqual([true, true]);  // 決策留著
  });

  it("改了落點就撤回沿用的決策——那是新的一次確認", async () => {
    // 沿用之後若收尾失敗，欄位還能編輯。使用者改了落點就是要建立**新的**設定，不該再
    // 沿用那份舊的——不撤回的話會直接走收尾（帶著新落點配舊 config），只剩父層對帳擋著。
    //
    //（「按停下來也撤回」那一行是防禦性的：`reuseAgreed` 為真時衝突 UI 已經不會再出現，
    // 所以那條路徑當下不可達，不為它寫測試。）
    adoptConfig.mockRejectedValue(new RestoreError("config_already_initialized", 409, {
      source: "onboard",
    }));
    const onSaved = vi.fn(async (_c: unknown, _r: boolean) => {
      throw Object.assign(new Error("reload"), { code: null });
    });
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} saved={false}
                   requestId="req-1" onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.conflict.reuse)).toBeTruthy());
    ui.getByText(zh.mig.targets.conflict.reuse).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.errors.reloadFailed)).toBeTruthy());
    expect(adoptConfig).toHaveBeenCalledTimes(1);

    fireEvent.change(ui.getByDisplayValue("/Users/me/.claude"),
                     { target: { value: "/Users/me/somewhere-else" } });
    ui.getByText(zh.mig.targets.retry).click();
    // 改了落點 → 重新走一次落檔（而不是拿新落點配舊 config 直接收尾）
    await waitFor(() => expect(adoptConfig).toHaveBeenCalledTimes(2));
    expect(adoptConfig.mock.calls[1][1].accounts).toEqual(
      [{ key: "work", config_dir: "/Users/me/somewhere-else" }]);
  });

  it("選了沿用之後，說明是中性的、不含刪檔指示", async () => {
    adoptConfig.mockRejectedValue(new RestoreError("config_already_initialized", 409, {
      source: "onboard",
    }));
    const onSaved = vi.fn(async (_confirmed: unknown, _reused: boolean) => {});
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} saved={false}
                   requestId="req-1" onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.conflict.reuse)).toBeTruthy());

    ui.getByText(zh.mig.targets.conflict.reuse).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.reused)).toBeTruthy());
    expect(ui.queryByText(zhRestore.errors.config_already_initialized)).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  // 票 09 R1 F2 的另一半：**沒有**沿用時要回報 false，否則父層永遠不敢說帶回了什麼。
  // 兩格分開測——只測其中一格的話，把回報寫死成常數也會綠。
  it("真的建立了新設定檔 → 回報「不是沿用」", async () => {
    // 明寫參數型別：`vi.fn(async () => {})` 會被推成零參數，`mock.calls[n][1]` 取不到
    const onSaved = vi.fn(async (_confirmed: unknown, _reused: boolean) => {});
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} requestId="req-1" saved={false}
                   onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0][1]).toBe(false);
    expect(ui.queryByText(zh.mig.targets.reused)).toBeNull();
  });

  // 增補 spec §2.8.4（Codex 階段 4 F2 的輕量緩解）：三支端點各自讀 manifest，成員清單
  // 對不上就代表 staging 在頁面之間被換過——擋住並要求回上一頁重新確認
  it("建議值的成員與上一頁的摘要對不上 → 擋住並要求回上一頁", async () => {
    fetchLandingSuggestions.mockResolvedValue({
      home: "/Users/olduser",
      spots: [{ key: "stranger", kind: "account", old_path: "/x",
                suggested: "", suggested_exists: false }],
    });
    const ui = setup();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.stale)).toBeTruthy());
    expect(ui.queryByText(zh.mig.targets.save)).toBeNull();
  });

  // Codex 票 03 R1 F1：對帳與 state 都用裸 key 的話，帳號與 extra 的命名空間就沒了。
  // 後端一直用 `extra:<name>` 區分（`validate_landing_spots`），前端不能把它丟掉。
  it("帳號與 extra 同名時各自獨立，不會被判成內容對不上", async () => {
    const info: BundleInfo = { ...INFO, accounts: ["agents"], extra: ["agents"] };
    fetchLandingSuggestions.mockResolvedValue({
      home: "/Users/olduser",
      spots: [
        { key: "agents", kind: "account", old_path: "/Users/olduser/.agents-acct",
          suggested: "/Users/me/.agents-acct", suggested_exists: false },
        { key: "agents", kind: "extra", old_path: "/Users/olduser/.agents",
          suggested: "/Users/me/.agents", suggested_exists: false },
      ],
    });
    const ui = setup({ info });

    await waitFor(() => expect(ui.getByDisplayValue("/Users/me/.agents-acct")).toBeTruthy());
    expect(ui.queryByText(zh.mig.targets.stale)).toBeNull();
    // 兩個欄位互不干擾——共用一格 state 的話改一個會連動另一個
    fireEvent.change(ui.getByDisplayValue("/Users/me/.agents-acct"),
                     { target: { value: "/Users/me/A" } });
    expect(ui.getByDisplayValue("/Users/me/.agents")).toBeTruthy();
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(adoptConfig).toHaveBeenCalledWith(1234, {
      request_id: "req-1",
      dest: "/tmp/staging",
      accounts: [{ key: "agents", config_dir: "/Users/me/A" }],
      extra: [{ name: "agents", path: "/Users/me/.agents" }],
    }));
  });

  it("成員的型別被對調（account↔extra）→ 判定內容對不上", async () => {
    const info: BundleInfo = { ...INFO, accounts: ["a"], extra: ["b"] };
    fetchLandingSuggestions.mockResolvedValue({
      home: "/Users/olduser",
      spots: [   // key 集合一模一樣，但 a 與 b 的身分對調了
        { key: "b", kind: "account", old_path: "/x", suggested: "", suggested_exists: false },
        { key: "a", kind: "extra", old_path: "/y", suggested: "", suggested_exists: false },
      ],
    });
    const ui = setup({ info });
    await waitFor(() => expect(ui.getByText(zh.mig.targets.stale)).toBeTruthy());
  });

  // Codex 票 03 R1 F2：落檔後精靈要先把新 config 讀回來才算完成——後面的頁面（登入卡等）
  // 讀的是 store 裡的 accounts，不刷新就會拿 in-memory 的預設帳號去顯示。
  //
  // R2 F1：但 `adoptConfig` 與收尾**不是同一個原子操作**。落檔已經成功、只是讀回失敗時，
  // 重按若再 POST 一次就會撞 409（`create_if_absent`），於是永遠走不到收尾——store 不會
  // 刷新、下一步永遠被擋，使用者在這一頁卡死。
  it("落檔成功但讀回失敗 → 說明設定已建立，重試只重讀不重複建立", async () => {
    let reloads = 0;
    const onSaved = vi.fn(async () => {
      reloads += 1;
      if (reloads === 1) throw new Error("RELOAD-SENTINEL");
    });
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} requestId="req-1" saved={false}
                   onSaved={onSaved} />,
    );
    await loaded(ui);

    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() =>
      expect(ui.getByText(zh.mig.targets.errors.reloadFailed)).toBeTruthy());
    expect(adoptConfig).toHaveBeenCalledTimes(1);
    expect(ui.container.textContent).not.toContain("RELOAD-SENTINEL");

    ui.getByText(zh.mig.targets.retry).click();
    await waitFor(() => expect(reloads).toBe(2));
    // 票 15 之前這裡斷言「沒有再 POST 一次」——那是為了避開 409 死路而用元件內的旗標
    // 記住「已經落檔了」。後端冪等之後**重送是安全的**（同一個 request_id 回既有結果），
    // 所以兩段都重跑，前端不必再推測上一次寫進去了沒。
    expect(adoptConfig).toHaveBeenCalledTimes(2);
    expect(adoptConfig.mock.calls.map((c) => c[1].request_id)).toEqual(["req-1", "req-1"]);
  });

  it("落檔本身失敗 → 重按會重新落檔（那一步還沒成功過）", async () => {
    adoptConfig.mockRejectedValueOnce(new RestoreError("invalid_config_dir", 400));
    const ui = setup();
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() =>
      expect(ui.getByText(zhRestore.errors.invalid_config_dir)).toBeTruthy());
    ui.getByText(zh.mig.targets.save).click();        // 主按鈕仍是「建立」不是「重新讀取」
    await waitFor(() => expect(adoptConfig).toHaveBeenCalledTimes(2));
  });

  // Codex 票 03 R4 F1：409 只證明「有一份 config」，不證明它是這次建立的、更不證明它含
  // 使用者剛確認的落點。後續 install 明確從那份 config 取目的地——沿用一份無關的設定
  // 等於把備份內容寫進使用者沒有確認過的現役目錄。父層對帳失敗時要擋住。
  it("既有設定與剛確認的落點對不上 → 不放行並說明衝突", async () => {
    adoptConfig.mockRejectedValueOnce(new RestoreError("config_already_initialized", 409));
    const onSaved = vi.fn(async () => {
      throw Object.assign(new Error("mismatch"), { code: "config_mismatch" });
    });
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} requestId="req-1" saved={false}
                   onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    // 票 15：409 先停下來問使用者。**選了沿用之後**父層的對帳才跑，而它擋得住
    await waitFor(() => expect(ui.getByText(zh.mig.targets.conflict.reuse)).toBeTruthy());
    ui.getByText(zh.mig.targets.conflict.reuse).click();
    await waitFor(() =>
      expect(ui.getByText(zhRestore.errors.config_mismatch)).toBeTruthy());
    expect(ui.getByText(zh.mig.targets.retry)).toBeTruthy();   // 上一次失敗在收尾那一段
  });

  it("載入建議值失敗 → 通用訊息，例外原文不進畫面", async () => {
    fetchLandingSuggestions.mockRejectedValueOnce(new Error("LOAD-SENTINEL-500"));
    const ui = setup();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.errors.loadFailed)).toBeTruthy());
    expect(ui.container.textContent).not.toContain("LOAD-SENTINEL-500");
  });

  it("落檔後欄位轉唯讀、不會再打一次 adopt-config", async () => {
    const ui = setup();
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() => expect(ui.getByText(zh.mig.targets.created)).toBeTruthy());
    expect(adoptConfig).toHaveBeenCalledTimes(1);
    expect(ui.queryByText(zh.mig.targets.save)).toBeNull();
  });
});

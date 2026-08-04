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

  // 409 有兩個來源，前端分不出也**不需要**分（Codex 票 03 R3）：重跑引導（設定檔本來就在），
  // 或這次 POST 其實成功了而前端不知道——請求途中使用者按了上一步讓卡片卸載、或回應在
  // 傳輸中遺失。把 409 當失敗會讓後兩者卡死：`adopted` 只活在元件 state，重進來又是 false，
  // 於是每一次重試都再撞一次 409。**設定檔已經在了就是「這一步完成了」**，往下走收尾。
  it("設定檔已經存在 → 不是死路：轉入收尾並說明設定不是這次建立的", async () => {
    adoptConfig.mockRejectedValueOnce(new RestoreError("config_already_initialized", 409));
    const onSaved = vi.fn(async () => {});
    const ui = render(
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} saved={false}
                   onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();

    // 說明是**中性 notice**，不含「移除既有設定檔」那種指示（Codex 票 03 R4 F2）：
    // 收尾成功之後這段還會留在畫面上，配著成功狀態一起顯示刪檔建議會讓人做危險的事
    await waitFor(() => expect(ui.getByText(zh.mig.targets.reused)).toBeTruthy());
    expect(ui.queryByText(zhRestore.errors.config_already_initialized)).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(1);          // 收尾照跑（父層把實際的 config 讀回來）
    // 主按鈕轉成「重新讀取」——再按不會重複 POST（那只會再撞一次 409）
    await waitFor(() => expect(ui.getByText(zh.mig.targets.retry)).toBeTruthy());
    ui.getByText(zh.mig.targets.retry).click();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(adoptConfig).toHaveBeenCalledTimes(1);
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
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} saved={false}
                   onSaved={onSaved} />,
    );
    await loaded(ui);

    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() =>
      expect(ui.getByText(zh.mig.targets.errors.reloadFailed)).toBeTruthy());
    expect(adoptConfig).toHaveBeenCalledTimes(1);
    expect(ui.container.textContent).not.toContain("RELOAD-SENTINEL");

    ui.getByText(zh.mig.targets.retry).click();       // 重試：只重讀
    await waitFor(() => expect(reloads).toBe(2));
    expect(adoptConfig).toHaveBeenCalledTimes(1);     // **沒有再 POST 一次**
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
      <TargetsCard port={1234} dest="/tmp/staging" info={INFO} saved={false}
                   onSaved={onSaved} />,
    );
    await loaded(ui);
    ui.getByText(zh.mig.targets.save).click();
    await waitFor(() =>
      expect(ui.getByText(zhRestore.errors.config_mismatch)).toBeTruthy());
    expect(ui.getByText(zh.mig.targets.retry)).toBeTruthy();   // 不再重複 POST
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

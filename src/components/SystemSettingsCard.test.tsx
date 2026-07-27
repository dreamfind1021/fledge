// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import zh from "../locales/zh-TW/onboarding.json";
import { useAppStore } from "../store/useAppStore";
import type { SubscriptionItem } from "../lib/sidecar";
import { SystemSettingsCard } from "./SystemSettingsCard";

const putKmsRoot = vi.fn<(port: number, path: string) => Promise<{ ok: boolean; kms_root: string }>>();
const pickDirectory = vi.fn<() => Promise<string | null>>();
const saveSubscriptions = vi.fn<(subs: SubscriptionItem[]) => Promise<void>>();

vi.mock("../lib/sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidecar")>()),
  putKmsRoot: (port: number, path: string) => putKmsRoot(port, path),
}));
vi.mock("../lib/dialog", () => ({ pickDirectory: () => pickDirectory() }));

const onNext = vi.fn<() => void>();
const onPrev = vi.fn<() => void>();

const renderCard = (props: Partial<Parameters<typeof SystemSettingsCard>[0]> = {}) =>
  render(
    <SystemSettingsCard port={1234} subscriptions={[]} kmsRoot="" onPrev={onPrev} onNext={onNext} {...props} />,
  );

/** 填第 i 列的名稱與費用（費用是 type=number，jsdom 會擋掉非數字字串） */
function fillRow(ui: ReturnType<typeof render>, i: number, name: string, cost: string) {
  const names = ui.container.querySelectorAll<HTMLInputElement>(`input[placeholder="${zh.sys.subsName}"]`);
  const costs = ui.container.querySelectorAll<HTMLInputElement>(`input[placeholder="${zh.sys.subsCost}"]`);
  fireEvent.change(names[i], { target: { value: name } });
  fireEvent.change(costs[i], { target: { value: cost } });
}

const addItem = (ui: ReturnType<typeof render>) => fireEvent.click(ui.getByText(zh.sys.addItem));
const next = (ui: ReturnType<typeof render>) => fireEvent.click(ui.getByText(zh.common.next));

describe("SystemSettingsCard 系統設置頁（訂閱 + KMS 根目錄）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW"); // 固定語言，斷言才對得上 catalog
    putKmsRoot.mockReset().mockResolvedValue({ ok: true, kms_root: "" });
    pickDirectory.mockReset().mockResolvedValue(null);
    saveSubscriptions.mockReset().mockResolvedValue(undefined);
    onNext.mockReset();
    onPrev.mockReset();
    useAppStore.setState({ port: 1234, saveSubscriptions, loadConfig: async () => {} });
  });
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  // 「兩區都能略過（不填即不送出）」——首次啟動兩者都空，按下一步不該打任何寫入端點
  it("兩區都沒動：下一步不送出任何請求，直接前進", async () => {
    const ui = renderCard();
    next(ui);

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(saveSubscriptions).not.toHaveBeenCalled();
    expect(putKmsRoot).not.toHaveBeenCalled();
  });

  it("「全部略過」不送出任何請求就前進", async () => {
    const ui = renderCard({ subscriptions: [{ name: "Claude", monthly_cost: 200 }], kmsRoot: "~/kb" });
    fireEvent.click(ui.getByText(zh.sys.skipAll));

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(saveSubscriptions).not.toHaveBeenCalled();
    expect(putKmsRoot).not.toHaveBeenCalled();
  });

  it("填了訂閱：下一步送出正規化後的清單並前進", async () => {
    const ui = renderCard();
    addItem(ui);
    fillRow(ui, 0, " Claude Max ", "200");
    next(ui);

    await waitFor(() => expect(saveSubscriptions).toHaveBeenCalledWith([{ name: "Claude Max", monthly_cost: 200 }]));
    expect(putKmsRoot).not.toHaveBeenCalled(); // KMS 沒填就不動它
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("按了新增卻整列空白：視為沒填，不送出也不擋前進", async () => {
    const ui = renderCard();
    addItem(ui);
    next(ui);

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(saveSubscriptions).not.toHaveBeenCalled();
  });

  it("填一半（有費用沒名稱）：擋下並顯示欄位錯誤，不送出也不前進", async () => {
    const ui = renderCard();
    addItem(ui);
    fillRow(ui, 0, "", "20");
    next(ui);

    await waitFor(() => expect(ui.getByText(zh.errors.subs_name)).toBeTruthy());
    expect(saveSubscriptions).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("費用負數：顯示費用錯誤（與後端 400 規則同一套判準）", async () => {
    const ui = renderCard();
    addItem(ui);
    fillRow(ui, 0, "Claude", "-1");
    next(ui);

    await waitFor(() => expect(ui.getByText(zh.errors.subs_cost)).toBeTruthy());
    expect(saveSubscriptions).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  // 重跑引導時卡片會帶著既有值進來。把它們刪光是明確的編輯動作，不是「沒填」——
  // 靜默不送等於吞掉使用者的改動
  it("既有訂閱被刪光：送出空清單，不當成略過", async () => {
    const ui = renderCard({ subscriptions: [{ name: "Claude", monthly_cost: 200 }] });
    expect(ui.container.querySelectorAll(`input[placeholder="${zh.sys.subsName}"]`)).toHaveLength(1);
    fireEvent.click(ui.getByText(zh.common.del));
    next(ui);

    await waitFor(() => expect(saveSubscriptions).toHaveBeenCalledWith([]));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("KMS 根目錄：瀏覽… 把選到的路徑填進輸入框，下一步只送 KMS", async () => {
    pickDirectory.mockResolvedValue("/Users/x/knowledge");
    const ui = renderCard();
    fireEvent.click(ui.getByText(zh.common.browse));

    const input = () => ui.container.querySelector<HTMLInputElement>(`input[placeholder="${zh.sys.kmsPlaceholder}"]`)!;
    await waitFor(() => expect(input().value).toBe("/Users/x/knowledge"));

    next(ui);
    await waitFor(() => expect(putKmsRoot).toHaveBeenCalledWith(1234, "/Users/x/knowledge"));
    expect(saveSubscriptions).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("KMS 沒改（值與 config 相同）：不重送", async () => {
    const ui = renderCard({ kmsRoot: "~/kb" });
    next(ui);

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(putKmsRoot).not.toHaveBeenCalled();
  });

  it("儲存失敗：顯示指向出錯區塊的訊息、留在原頁", async () => {
    saveSubscriptions.mockRejectedValue(new Error("HTTP 400"));
    const ui = renderCard();
    addItem(ui);
    fillRow(ui, 0, "Claude", "200");
    next(ui);

    await waitFor(() => expect(ui.getByText(/HTTP 400/)).toBeTruthy());
    expect(ui.container.textContent).toContain(zh.errors.subs_failed.split("{{")[0]);
    expect(putKmsRoot).not.toHaveBeenCalled(); // 前一段失敗就不繼續送下一段
    expect(onNext).not.toHaveBeenCalled();
  });

  it("訂閱成功但 KMS 失敗：錯誤指向 KMS，不謊稱訂閱沒存進去", async () => {
    putKmsRoot.mockRejectedValue(new Error("HTTP 500"));
    const ui = renderCard();
    addItem(ui);
    fillRow(ui, 0, "Claude", "200");
    fireEvent.change(ui.container.querySelector(`input[placeholder="${zh.sys.kmsPlaceholder}"]`)!, {
      target: { value: "/Users/x/kb" },
    });
    next(ui);

    await waitFor(() => expect(ui.container.textContent).toContain(zh.errors.kms_failed.split("{{")[0]));
    expect(saveSubscriptions).toHaveBeenCalledTimes(1);
    expect(ui.container.textContent).not.toContain(zh.errors.subs_failed.split("{{")[0]);
    expect(onNext).not.toHaveBeenCalled();
  });

  // 後端不在時默默前進，使用者填的東西會憑空消失
  it("port 為 null 且有待送出的改動：擋下並說明後端未連線", async () => {
    const ui = renderCard({ port: null });
    addItem(ui);
    fillRow(ui, 0, "Claude", "200");
    next(ui);

    await waitFor(() => expect(ui.getByText(zh.errors.backend_unavailable)).toBeTruthy());
    expect(onNext).not.toHaveBeenCalled();
  });

  // 在途的儲存回來後也會 onNext()，途中還能按略過就會前進兩頁
  it("送出途中導覽按鈕全部停用，略過不會與在途儲存各推進一次", async () => {
    let release = () => {};
    saveSubscriptions.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve(); }));
    const ui = renderCard();
    addItem(ui);
    fillRow(ui, 0, "Claude", "200");
    next(ui);

    const buttons = [zh.common.prev, zh.sys.skipAll, zh.common.next];
    await waitFor(() =>
      expect(buttons.map((label) => (ui.getByText(label) as HTMLButtonElement).disabled)).toEqual([true, true, true]),
    );
    fireEvent.click(ui.getByText(zh.sys.skipAll)); // 停用中，點了不該有反應
    expect(onNext).not.toHaveBeenCalled();

    await act(async () => { release(); });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("port 為 null 但沒有任何改動：仍可略過往下走", async () => {
    const ui = renderCard({ port: null });
    next(ui);

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });
});

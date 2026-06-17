import { describe, it, expect } from "vitest";
import type { Tab } from "../store/useAppStore";
import { displayTabTitle } from "./tabTitle";

// 建一個 claude Tab（title 預設 "fledge"）。
const ctab = (id: string, projectPath: string, account: string, title = "fledge"): Tab => ({
  id,
  projectPath,
  account,
  title,
  sessionId: "s",
  status: "ready",
  kind: "claude",
});

describe("displayTabTitle", () => {
  it("單一 claude 分頁 → 無後綴", () => {
    const a = ctab("1", "/p", "work");
    expect(displayTabTitle([a], a)).toBe("fledge");
  });

  it("同 (path, account) 第二、三個 → #2、#3", () => {
    const a = ctab("1", "/p", "work");
    const b = ctab("2", "/p", "work");
    const c = ctab("3", "/p", "work");
    const tabs = [a, b, c];
    expect(displayTabTitle(tabs, a)).toBe("fledge");
    expect(displayTabTitle(tabs, b)).toBe("fledge #2");
    expect(displayTabTitle(tabs, c)).toBe("fledge #3");
  });

  it("不同 account 同 path → 各自從第一個（無後綴）起算、不互相計入", () => {
    const a = ctab("1", "/p", "work");
    const b = ctab("2", "/p", "personal");
    const tabs = [a, b];
    expect(displayTabTitle(tabs, a)).toBe("fledge");
    expect(displayTabTitle(tabs, b)).toBe("fledge");
  });

  it("terminal / dashboard / memory → 一律回 raw title（不加序號）", () => {
    const term: Tab = { ...ctab("1", "/p", "work", "fledge"), kind: "terminal" };
    const dash: Tab = { ...ctab("2", "", "", "dash"), kind: "dashboard" };
    const mem: Tab = { ...ctab("3", "", "", "mem"), kind: "memory" };
    const tabs = [term, dash, mem];
    expect(displayTabTitle(tabs, term)).toBe("fledge");
    expect(displayTabTitle(tabs, dash)).toBe("dash");
    expect(displayTabTitle(tabs, mem)).toBe("mem");
  });

  it("關閉中間分頁後重新編號（原 #3 → #2）", () => {
    const a = ctab("1", "/p", "work");
    const c = ctab("3", "/p", "work");
    const afterClose = [a, c]; // 移除中間分頁（id="2"），c 應升為 #2
    expect(displayTabTitle(afterClose, c)).toBe("fledge #2");
  });
});

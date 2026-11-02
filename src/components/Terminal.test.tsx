// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "../i18n";
import { applyTermFontAction } from "../lib/termFontSize";
import { Terminal } from "./Terminal";

// 字級（票 50，spec docs/superpowers/specs/2026-11-02-terminal-font-zoom-design.md §4.2）的行為測試。
// 真的 xterm 進不了 jsdom（canvas／WebGL），換成記錄字級寫入與 fit 先後的替身；替身的欄數跟著字級算（1000 / 字級），
// 字級變了、fit 過，PTY 才會收到新欄數。jsdom 不做版面，「看不看得到」由 offsetParent 的替身決定；
// rAF 手動執行，才看得到 forceRefresh 合併之後那一次做了什麼
const h = vi.hoisted(() => ({
  log: [] as string[],
  terms: [] as Array<{ options: { fontSize?: number }; textarea: HTMLTextAreaElement | null }>,
  resize: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    element: HTMLDivElement | null = null;
    textarea: HTMLTextAreaElement | null = null;
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    options: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      // 只記字級的寫入：先換字級、再 fit 的先後是這組測試要守的
      this.options = new Proxy({ ...opts }, {
        set(target, key, value) {
          if (key === "fontSize") h.log.push(`fontSize=${value}`);
          target[key as string] = value;
          return true;
        },
      });
      h.terms.push(this as never);
    }
    loadAddon(addon: { activate?: (t: unknown) => void }) { addon.activate?.(this); }
    open(parent: HTMLElement) {
      this.element = document.createElement("div");
      const helpers = document.createElement("div");
      helpers.className = "xterm-helpers";
      this.textarea = document.createElement("textarea");
      helpers.appendChild(this.textarea);
      this.element.appendChild(helpers);
      parent.appendChild(this.element);
    }
    registerLinkProvider() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
    write(_data: unknown, cb?: () => void) { cb?.(); }
    refresh() {}
    focus() {}
    dispose() {}
    hasSelection() { return false; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    private term: { options: { fontSize?: number }; cols: number } | null = null;
    activate(term: { options: { fontSize?: number }; cols: number }) { this.term = term; }
    fit() {
      h.log.push("fit");
      if (this.term) this.term.cols = Math.round(1000 / (this.term.options.fontSize ?? 13));
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("../lib/sidecar", () => ({ resizeSession: h.resize, wsUrl: () => "ws://test" }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: () => Promise.resolve(""), writeText: () => Promise.resolve() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve(), revealItemInDir: () => Promise.resolve() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/Users/test") }));

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = "";
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  send() {}
  close() {}
}
class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

let visible = true;
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
let raf = new Map<number, FrameRequestCallback>();
let rafId = 0;
const flushRaf = () => {
  const pending = [...raf.values()];
  raf = new Map();
  pending.forEach((cb) => cb(0));
};
const term = () => h.terms[h.terms.length - 1];

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { raf.set(++rafId, cb); return rafId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { raf.delete(id); });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() { return visible ? document.body : null; },
  });
  visible = true;
  raf = new Map();
  h.log.length = 0;
  h.terms.length = 0;
  h.resize.mockClear();
  applyTermFontAction("reset");   // 字級是模組層狀態、跨測試留著：每條從 13 開始
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (offsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
});

/** 掛一個終端機、跑完掛載時那一次重繪，再把紀錄清空——之後的紀錄只有測試自己觸發的事 */
function mountTerminal({ isActive = true, zoomable }: { isActive?: boolean; zoomable?: boolean } = {}) {
  const ui = render(<Terminal port={1} sessionId="s1" tabId="t1" isActive={isActive} zoomable={zoomable} />);
  act(() => flushRaf());
  h.log.length = 0;
  h.resize.mockClear();
  return ui;
}

/** 組字中切走：compositionend 空字串＋視窗 blur → 懸置草稿顯示在游標處（Terminal.tsx 的 syncImeGhost） */
function suspendDraft() {
  const ta = term().textarea!;
  act(() => {
    ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄋㄧˇ", bubbles: true }));
    ta.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
    window.dispatchEvent(new Event("blur"));
  });
}
const ghost = (container: HTMLElement) => container.querySelector<HTMLElement>(".xterm-helpers > div")!;

describe("Terminal 的字級", () => {
  // 掛載時那一次重繪也會套用字級，所以要在它之前看——否則建立時寫成 13 也測不出來（只會先閃一下 13 再變大）
  it("建立時：zoomable 一開始就用存的字級", () => {
    applyTermFontAction("in");
    render(<Terminal port={1} sessionId="s1" tabId="t1" isActive zoomable />);
    expect(term().options.fontSize).toBe(14);
  });

  // 幽靈字是 term.open 之後才掛進 DOM 的；建立時字級就要對（同上，掛載那次重繪也會套，所以不先 mountTerminal）
  it("建立時：幽靈字（組字草稿）用存的字級", () => {
    applyTermFontAction("in");
    const { container } = render(<Terminal port={1} sessionId="s1" tabId="t1" isActive zoomable />);
    const el = container.querySelector<HTMLElement>(".xterm-helpers > div");
    expect(el).not.toBeNull();
    expect(el!.style.fontSize).toBe("14px");
  });

  it("建立時：沒有 zoomable 固定 13（設置卡）", () => {
    applyTermFontAction("in");
    mountTerminal();
    expect(term().options.fontSize).toBe(13);
  });

  it("看得到時字級變了：先換字級、再 fit", () => {
    mountTerminal({ zoomable: true });
    act(() => applyTermFontAction("in"));
    act(() => flushRaf());
    expect(h.log).toEqual(["fontSize=14", "fit"]);
  });

  it("看得到時字級變了：PTY 收到新的欄數", () => {
    mountTerminal({ zoomable: true });
    act(() => applyTermFontAction("in"));
    act(() => flushRaf());
    expect(h.resize).toHaveBeenCalledWith(1, "s1", 24, Math.round(1000 / 14));
  });

  // 組字懸置的幽靈字要跟終端機同字級，否則換字級後草稿停在舊大小（spec 反目標 A5）
  it("看得到時字級變了：幽靈字的 font-size 跟著變", () => {
    const { container } = mountTerminal({ zoomable: true });
    act(() => applyTermFontAction("in"));
    act(() => flushRaf());
    const el = container.querySelector<HTMLElement>(".xterm-helpers > div");
    expect(el).not.toBeNull();
    expect(el!.style.fontSize).toBe("14px");
  });

  // 隱藏中套用的話，xterm 的 DOM 量法會留下舊字級的尺寸、切回也不重量（spec §4.2，Codex spec R1）
  it("隱藏時字級變了：不套用", () => {
    visible = false;
    mountTerminal({ isActive: false, zoomable: true });
    act(() => applyTermFontAction("in"));
    act(() => flushRaf());
    expect(term().options.fontSize).toBe(13);
  });

  it("隱藏的分頁切回：在 fit 之前套用", () => {
    visible = false;
    const ui = mountTerminal({ isActive: false, zoomable: true });
    act(() => applyTermFontAction("in"));
    act(() => flushRaf());
    visible = true;
    ui.rerender(<Terminal port={1} sessionId="s1" tabId="t1" isActive zoomable />);
    act(() => flushRaf());
    expect(h.log).toEqual(["fontSize=14", "fit"]);
  });

  it("卸載之後字級變了：不再排重繪", () => {
    const ui = mountTerminal({ zoomable: true });
    ui.unmount();
    act(() => applyTermFontAction("in"));
    expect(raf.size).toBe(0);
  });

  it("沒有 zoomable：字級變了不排重繪", () => {
    mountTerminal();
    act(() => applyTermFontAction("in"));
    expect(raf.size).toBe(0);
  });

  it("沒有 zoomable：之後的重繪也不套用字級", () => {
    mountTerminal();
    act(() => applyTermFontAction("in"));
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => flushRaf());
    expect(term().options.fontSize).toBe(13);
  });

  // 草稿的座標是懸置當下定格的，字級變了就對不上游標（Codex plan R1）
  it("草稿懸置中字級變了：收掉草稿", () => {
    const { container } = mountTerminal({ zoomable: true });
    suspendDraft();
    expect(ghost(container).style.display).toBe("block");   // 前提：草稿真的顯示出來了
    act(() => applyTermFontAction("in"));
    act(() => flushRaf());
    expect(ghost(container).style.display).toBe("none");
  });

  // 每次回前景、切回分頁都會重繪；字級沒變就不能順手把草稿收掉
  it("草稿懸置中、字級沒變的重繪（回到前景）：草稿留著", () => {
    const { container } = mountTerminal({ zoomable: true });
    suspendDraft();
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => flushRaf());
    expect(ghost(container).style.display).toBe("block");
  });
});

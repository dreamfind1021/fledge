// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CardTerminal } from "./CardTerminal";

// xterm 進 jsdom 會炸（canvas/WebGL）；終端機換成露出 zoomable 的替身
vi.mock("./Terminal", () => ({
  Terminal: ({ zoomable }: { zoomable?: boolean }) => <div data-testid="terminal" data-zoomable={String(zoomable === true)} />,
}));

// 字級（票 50，spec N2）：設置卡的終端機高度固定，字級不跟著 Cmd+= / Cmd+- / Cmd+0 變、維持 13
describe("CardTerminal", () => {
  afterEach(cleanup); // vitest 未開 globals → testing-library 不會自動 cleanup

  it("不傳 zoomable 給 Terminal", () => {
    render(<CardTerminal port={1234} sessionId="s1" tabId="card-install" title="brew install node" />);
    expect(screen.getByTestId("terminal").dataset.zoomable).toBe("false");
  });
});

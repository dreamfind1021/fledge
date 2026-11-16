import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open }));

import { pickFile } from "./dialog";

describe("pickFile", () => {
  beforeEach(() => h.open.mockReset());

  it("選檔視窗同時看得到新的 .tar.xz 與舊的 .tar.gz", async () => {
    h.open.mockResolvedValue("/Volumes/usb/claude-backup-20261116-0900.tar.xz");
    expect(await pickFile("備份包")).toBe("/Volumes/usb/claude-backup-20261116-0900.tar.xz");
    expect(h.open).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      filters: [{ name: "備份包", extensions: ["gz", "xz"] }],
    });
  });
});

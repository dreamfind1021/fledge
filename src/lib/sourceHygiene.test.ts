import { describe, it, expect } from "vitest";

// 起因：票 25 有一次把真正的 NUL 位元組寫進 LoginCard.tsx，git 因此把整個檔案判成二進位
// （`Bin 0 -> 6607 bytes`）——該 commit 的 158 行新增完全沒有進入 diff，而本專案的整套審查
// 流程（對抗式審查、兩軸 code review、PR diff）都建立在 diff 之上，等於全部失效。
// 這條測試只做一件事：讓那類字元進不了原始檔。
//
// 用 vite 的 import.meta.glob 而非 node:fs——本專案沒有 @types/node，tsconfig 的 lib 也只有 DOM，
// 為一條測試新增依賴不划算；glob 的型別由 vite/client 提供（見 vite-env.d.ts）。
const sources = {
  ...import.meta.glob("/src/**/*.{ts,tsx,css,json}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("/sidecar/fledge_sidecar/**/*.py", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("/sidecar/tests/**/*.py", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("/src-tauri/src/**/*.rs", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

// 允許的控制字元：\t（縮排）、\n（換行）。\r 不在其中——本 repo 一律 LF。
const FORBIDDEN = /[\x00-\x08\x0B-\x0C\x0E-\x1F]/;

describe("原始檔衛生", () => {
  it("掃得到原始檔（glob 失效的話下面那條會空掃而永遠綠）", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it("不含 NUL 或其他非預期控制字元（否則 git 會判成二進位、diff 消失）", () => {
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      const hit = FORBIDDEN.exec(text);
      if (!hit) continue;
      const line = text.slice(0, hit.index).split("\n").length;
      const code = `0x${hit[0].charCodeAt(0).toString(16).padStart(2, "0")}`;
      offenders.push(`${path}:${line} 有 ${code}`);
    }
    expect(offenders).toEqual([]);
  });
});

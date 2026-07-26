import { describe, it, expect } from "vitest";

// 起因：票 25 有一次把真正的 NUL 位元組寫進 LoginCard.tsx，git 因此把整個檔案判成二進位
// （`Bin 0 -> 6607 bytes`）——該 commit 的 158 行新增完全沒有進入 diff，而本專案的整套審查
// 流程（對抗式審查、兩軸 code review、PR diff）都建立在 diff 之上，等於全部失效。
// 這條測試只做一件事：讓那類字元進不了原始檔。
//
// 用 vite 的 import.meta.glob 而非 node:fs——本專案沒有 @types/node，tsconfig 的 lib 也只有 DOM，
// 為一條測試新增依賴不划算；glob 的型別由 vite/client 提供（見 vite-env.d.ts）。
// 掃描範圍：手寫原始碼。每組各自帶一個一定存在的哨兵檔——只用「總數 > N」擋不住
// 「其中一組 glob 失效」（單一組就足以超過門檻），必須逐組驗證（Codex 票25 R2 Low）。
const GROUPS = [
  {
    name: "前端 src",
    files: import.meta.glob("/src/**/*.{ts,tsx,css,json}", { query: "?raw", import: "default", eager: true }),
    sentinel: "/src/components/LoginCard.tsx",
  },
  {
    name: "sidecar 實作",
    files: import.meta.glob("/sidecar/fledge_sidecar/**/*.py", { query: "?raw", import: "default", eager: true }),
    sentinel: "/sidecar/fledge_sidecar/routes/sessions.py",
  },
  {
    name: "sidecar 測試",
    files: import.meta.glob("/sidecar/tests/**/*.py", { query: "?raw", import: "default", eager: true }),
    sentinel: "/sidecar/tests/test_sessions.py",
  },
  {
    name: "Tauri 殼",
    // 限定 src/：`/src-tauri/**` 會掃進 target/ 裡 Cargo 產生的 .rs（本機建置產物、數 GB）
    files: import.meta.glob("/src-tauri/src/**/*.rs", { query: "?raw", import: "default", eager: true }),
    sentinel: "/src-tauri/src/lib.rs",
  },
] as { name: string; files: Record<string, unknown>; sentinel: string }[];

// 允許的控制字元只有 \t（縮排）與 \n（換行）：\x0D（CR）也在禁止範圍內——本 repo 一律 LF，
// 混進 CRLF 同樣會讓 diff 變得難讀。
const FORBIDDEN = /[\x00-\x08\x0B-\x1F]/;

describe("原始檔衛生", () => {
  // 掃描範圍限定於上面四組手寫原始碼，不是 repo-wide：組建腳本（build.rs、*.sh）、
  // 設定檔與文件不在內——它們不進 bundler，也不是這次事故的來源。
  it.each(GROUPS)("$name：glob 掃得到檔案（否則下面那條會空掃而永遠綠）", ({ files, sentinel }) => {
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(Object.keys(files)).toContain(sentinel);
  });

  it("不含 NUL 或其他非預期控制字元（否則 git 會判成二進位、diff 消失）", () => {
    const offenders: string[] = [];
    for (const group of GROUPS) {
      for (const [path, text] of Object.entries(group.files as Record<string, string>)) {
        const hit = FORBIDDEN.exec(text);
        if (!hit) continue;
        const line = text.slice(0, hit.index).split("\n").length;
        const code = `0x${hit[0].charCodeAt(0).toString(16).padStart(2, "0")}`;
        offenders.push(`${path}:${line} 有 ${code}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

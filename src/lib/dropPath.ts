// 拖檔貼路徑的格式化（純函式，可單元測）：把 Finder 拖入的絕對路徑陣列轉成可安全貼進
// shell／claude 輸入框的字串。智慧引號（決策 4-1a）：safe charset 原樣、其餘 POSIX 單引號
// 包裹；含控制字元的路徑整項跳過（不做 destructive 剝除——剝掉換行可能改寫成指向另一真實
// 檔案的路徑）；多檔以空白 join + 尾隨一個空白（iTerm2／Tabby 慣例，可立刻續打）。
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// safe charset：Unicode 字母（含中日韓）+ 數字 + / . _ - → 不加引號（中文檔名無空白觀感同原生終端）。
// 刻意保守：+ = @ ~ % , 空白等一律落到引號分支（用引號達到 iTerm2 等級的安全）。
const SAFE_PATH = /^[\p{L}\p{N}\/._-]+$/u;

function quoteForShell(p: string): string {
  if (SAFE_PATH.test(p)) return p;
  // POSIX 單引號跳脫：每個 ' 換成 '\''（收尾引號 → 跳脫的字面引號 → 重開引號）
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

export function formatPathsForPaste(paths: string[]): string {
  const usable = paths.filter((p) => !CONTROL_CHARS.test(p));
  if (usable.length === 0) return ""; // 全跳過／空輸入 → caller 不動作
  return usable.map(quoteForShell).join(" ") + " ";
}

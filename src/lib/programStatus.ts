// Program Status Protocol（OSC 7501）：程式告訴終端機自己在忙、等人、做完或出錯。
// Pi 送 `ESC ] 7501 ; state=<s>[:app=<a>][:kind=<k>][:msg=<base64>] ESC \`（Pi spec §8；Pi 的 pi-tui/program-status.js）。
// xterm 的 OSC handler 拿到的是 `;` 之後那串，這裡只取 state；msg 不解碼、不顯示。

/** 回 state 的值；支援查詢（`?`）、沒有 state 的字串回 null。未知的 state 原樣回傳，歸 idle 是 activityTracker 的事。 */
export function parseProgramStatus(data: string): string | null {
  for (const pair of data.split(":")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === "state") {
      const value = pair.slice(eq + 1);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

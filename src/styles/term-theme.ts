import type { ITheme } from "@xterm/xterm";

// 從 :root/[data-theme] 讀 CSS 變數值（hex），組 xterm 主題。
// xterm canvas 不吃 CSS 變數，必須讀成實字串再餵；在 Terminal mount 當下讀一次即可
// （主題切換是未來雙模式的事，v1 固定 nightfall）。前景/底色/游標為主，其餘 ANSI 留 xterm 預設。
export function readTermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    background: v("--term-bg"),
    foreground: v("--term-text"),
    cursor: v("--session"),
  };
}

import type { ITheme } from "@xterm/xterm";

// 從 :root/[data-theme] 讀 CSS 變數值（hex），組 xterm 主題。
// xterm canvas 不吃 CSS 變數，必須讀成實字串再餵；在 Terminal mount 當下讀一次即可
// （主題切換是未來雙模式的事，v1 固定 nightfall）。前景/底色/游標 + ANSI 16 色全由 index.css 的
// token 定義，這裡只負責讀成實 hex 餵 xterm；色票語意與設計理由見 index.css「終端機 ANSI 16 色」。
export function readTermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    background: v("--term-bg"),
    foreground: v("--term-text"),
    cursor: v("--session"),
    black: v("--term-black"),
    red: v("--term-red"),
    green: v("--term-green"),
    yellow: v("--term-yellow"),
    blue: v("--term-blue"),
    magenta: v("--term-magenta"),
    cyan: v("--term-cyan"),
    white: v("--term-white"),
    brightBlack: v("--term-bright-black"),
    brightRed: v("--term-bright-red"),
    brightGreen: v("--term-bright-green"),
    brightYellow: v("--term-bright-yellow"),
    brightBlue: v("--term-bright-blue"),
    brightMagenta: v("--term-bright-magenta"),
    brightCyan: v("--term-bright-cyan"),
    brightWhite: v("--term-bright-white"),
  };
}

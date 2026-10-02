import type { ITheme } from "@xterm/xterm";
import { onThemeChange } from "../lib/theme";

// 從 :root/[data-theme] 讀 CSS 變數值（hex），組 xterm 主題。
// xterm canvas 不吃 CSS 變數，必須讀成實字串再餵：Terminal mount 當下讀一次，
// 之後切主題由 followTheme() 重讀（票 07）。前景/底色/游標/選取 + ANSI 16 色全由 index.css 的
// token 定義，這裡只負責讀成實 hex 餵 xterm；色票語意與設計理由見 index.css 各主題區塊的 ANSI 註解。
export function readTermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    background: v("--term-bg"),
    foreground: v("--term-text"),
    // 游標另開 token：淺色主題的 --session 在淺底上只有約 1.5，找不到游標（票 07，spec §3.5）
    cursor: v("--term-cursor"),
    // 方塊游標底下那個字的顏色：xterm 預設 #000000 壓淺色主題的游標色只有 3.36（spec §12.6）
    cursorAccent: v("--term-cursor-accent"),
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
    // 選取色只在淺色主題定義：午夜藍讀到空字串就不傳，xterm 用預設的半透明白（畫面跟改之前一樣）；
    // 淺色主題的預設半透明白在淺底上看不到。xterm 會把這個值原樣當一般格子選中時的底色（不透明色不會自動變淡；反白的格子另有算法，spec §12.4），
    // 所以 CSS 裡寫的就是畫出來的淡藍（index.css、index.contrast.test.ts）
    ...(v("--term-selection") ? { selectionBackground: v("--term-selection") } : {}),
  };
}

/**
 * xterm 的 minimumContrastRatio（不在 ITheme 裡，另外讀）：淺色主題 4.5、午夜藍 1（spec §12.5）。
 * 讀不到、看不懂、小於 1 → 1＝xterm 預設、不調色
 */
export function readTermMinContrast(): number {
  const n = Number(getComputedStyle(document.documentElement).getPropertyValue("--term-min-contrast").trim());
  return n >= 1 ? n : 1;
}

/**
 * 輸入法懸置草稿的元素（純視覺、不進 PTY），Terminal.tsx 掛到 .xterm-helpers 底下。字色是終端機前景色、打淡化，
 * 看得出還沒送出。它是 DOM 元素、不是 xterm 畫的字：minimumContrastRatio 管不到，對比由 term-theme.test.ts 建一個出來驗（票 38）
 */
export function createImeGhost(): HTMLDivElement {
  const ghost = document.createElement("div");
  // 淡化 0.62：淺色主題對終端機底剛好過 4.5（0.55 只有約 3.85，票 38）
  ghost.style.cssText =
    "position:absolute;pointer-events:none;z-index:2;display:none;white-space:pre;" +
    "opacity:0.62;border-bottom:1px dashed currentColor;" +
    "font-family:JetBrains Mono,ui-monospace,monospace;font-size:13px;";
  ghost.style.color = readTermTheme().foreground ?? "#ccc";
  return ghost;
}

/**
 * 已開著的終端機跟著主題換色（票 07，spec §4.5）。回傳取消訂閱的函式，終端機卸載時呼叫——
 * 否則切主題時會去碰已經 dispose 的 xterm。每次都組一個新的 theme 物件：淺→深時選取色要回到 xterm 預設，
 * 物件裡不帶 selectionBackground 才會回去
 */
export function followTheme(term: { options: { theme?: ITheme; minimumContrastRatio?: number } }, imeGhost: HTMLElement): () => void {
  return onThemeChange(() => {
    const theme = readTermTheme();
    term.options.theme = theme;
    term.options.minimumContrastRatio = readTermMinContrast();
    imeGhost.style.color = theme.foreground ?? "#ccc";
  });
}

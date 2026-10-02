import { describe, expect, it } from "vitest";
import { THEMES, THEME_SCHEME, type ThemeId } from "./lib/themeIds";
import {
  DARK_THEMES, LIGHT_THEMES, NOT_NIGHTFALL_THEMES,
  contrast, over, readCss, resolveColor, rootBlock, stops, stripComments, themeBlock, themesInCss, token, tokenNames,
} from "./testing/cssRules";

// 主題 token 的對比防線（票 06 起；票 07 起每個主題都跑）。
//
// Tasks.contrast.test.ts 等規則層測試守的是「某條 CSS 規則用的 token 夠不夠」，
// 這裡守的是上游：**token 本身**對每一種底色夠不夠。少了這層，
// 有人把 --faint 調回原本的 #5E6981 時，48 條文字規則會一起悄悄失效，
// 而每條規則各自的測試（如果有的話）都不會動。
//
// 四級文字色（--text / --text-2 / --dim / --faint）全部納入。
// 主題清單從 src/lib/themeIds.ts 匯入，不在測試裡再抄一份——少跑一個主題時下面的雙向比對會紅。
const RAW = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// 文字實際會坐在這些底色上。--active 不在裡面，理由見下面那條測試
const TEXT_BACKDROPS = ["bg", "sidebar", "surface", "surface-2", "hover"];
// 由最清楚到最淡排。--text-2 是 2026-09-09 補定義的第四級（檔案樹檔名，票 18）——
// 那個顏色本來就在畫面上，只是靠一個沒定義的 token 的 fallback 撐著。
const TEXT_INKS = ["text", "text-2", "dim", "faint"];
const FUNCTIONAL = ["primary", "session", "ai", "warning", "error"];
const ANSI = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright-black", "bright-red", "bright-green", "bright-yellow", "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
];

describe.each(THEMES)("%s 的文字色階", (theme) => {
  it.each(TEXT_INKS.flatMap((ink) => TEXT_BACKDROPS.map((bg) => [ink, bg])))(
    "--%s 對 --%s 至少 4.5:1",
    (ink, bg) => {
      expect(contrast(token(ink, theme), token(bg, theme))).toBeGreaterThanOrEqual(4.5);
    },
  );

  // --active 只鋪在 .sidebar-item.is-active 與 .lrow.active 底下，
  // 那兩處的 --faint 內容是圖示與分隔符（.sidebar-item-ico.is-discovered、.lrow .sep），
  // 不是文字，門檻 3:1。把它一起塞進上面那組會逼出更亮的值、把色階壓得更平。
  it("--faint 對 --active 至少 3:1（該處只有圖示與分隔符）", () => {
    expect(contrast(token("faint", theme), token("active", theme))).toBeGreaterThanOrEqual(3);
  });

  // 色階要分得出來，否則「這是次要資訊」的暗示就沒了。
  // 這條同時擋住「為了過對比把 --faint 一路調到跟 --dim 一樣」。
  // 比的是對 --bg 的對比、不是亮度，所以深底與淺底同一個寫法
  it("四級色階由最清楚到最淡、每一級彼此拉得開", () => {
    const bg = token("bg", theme);
    const steps = TEXT_INKS.map((t) => contrast(token(t, theme), bg));
    for (let i = 1; i < steps.length; i += 1) {
      // 順序反了代表 TEXT_INKS 排錯或某個 token 被調過頭，兩種都要炸
      expect(steps[i - 1], `${TEXT_INKS[i - 1]} 應該比 ${TEXT_INKS[i]} 清楚`).toBeGreaterThan(steps[i]);
      expect(steps[i - 1] - steps[i], `${TEXT_INKS[i - 1]} 與 ${TEXT_INKS[i]} 差太近`).toBeGreaterThanOrEqual(1);
    }
  });

  it("終端機的字對終端機底至少 4.5:1", () => {
    expect(contrast(token("term-text", theme), token("term-bg", theme))).toBeGreaterThanOrEqual(4.5);
  });
});

// 功能色拿來寫字時用 --X-text（spec §3.3）。午夜藍的 --X-text 是 --X 的別名、不加門檻：
// 午夜藍的 --error #EF4444 對 --surface 只有 4.38，那是現況，本票不改午夜藍（spec §6.2，Codex spec R1）
describe.each(NOT_NIGHTFALL_THEMES)("%s 的文字用功能色", (theme) => {
  it.each(FUNCTIONAL.flatMap((k) => [...TEXT_BACKDROPS, "active"].map((bg) => [k, bg])))(
    "--%s-text 對 --%s 至少 4.5:1",
    (k, bg) => {
      expect(contrast(token(`${k}-text`, theme), token(bg, theme))).toBeGreaterThanOrEqual(4.5);
    },
  );

  // 只對純底色算不夠：記憶面板選中列的小籤、待辦「下一步」選中時，字壓在一層淡淡的同色上（Codex spec R1 實算 4.07～4.30）。
  // 18% 是推導基準，不是「最濃」的證明——實際的合成底由規則層測試逐條驗（spec §3.2 第 4 點）
  // 名稱裡要印兩次 k：it.each 的 %s 依序吃參數，只給一個的話第二個 %s 會印成 undefined
  it.each(FUNCTIONAL.map((k) => [k, k]))("--%s-text 對「--%s 18% 疊在 --active」至少 4.5:1", (k) => {
    const tinted = resolveColor(`color-mix(in srgb, var(--${k}) 18%, var(--active))`, theme);
    expect(contrast(token(`${k}-text`, theme), tinted)).toBeGreaterThanOrEqual(4.5);
  });

});

// 終端機裡全是字，亮色也是：xterm 預設把粗體畫成亮色（Codex daylight spec R2）。每個主題都跑——
// 深色主題沒開最低對比調整（--term-min-contrast 1），這組是終端機彩色字唯一的守門（票 40，Codex spec R2）。
// 黑與亮黑不在這組：深色主題的「黑」是刻意的淡（午夜藍 1.6），只對淺色要求，見下一組
const ANSI_DARK_FAINT = ["black", "bright-black"];
describe.each(THEMES)("%s 的終端機字色", (theme) => {
  it.each(ANSI.filter((c) => !ANSI_DARK_FAINT.includes(c)))("終端機 --term-%s 對終端機底至少 4.5:1", (c) => {
    expect(contrast(token(`term-${c}`, theme), token("term-bg", theme))).toBeGreaterThanOrEqual(4.5);
  });

  it("游標對終端機底至少 3:1（非文字）", () => {
    expect(contrast(token("term-cursor", theme), token("term-bg", theme))).toBeGreaterThanOrEqual(3);
  });

  // 方塊游標把那一格的字畫成 cursorAccent、底畫成 cursor。沒設定時是 xterm 預設的 #000000：
  // 黑字壓淺色主題的 #056D5F 只有 3.36，Claude Code 的輸入框上就有游標（spec §12.6）
  it("方塊游標底下的字對游標至少 4.5:1", () => {
    expect(contrast(token("term-cursor-accent", theme), token("term-cursor", theme))).toBeGreaterThanOrEqual(4.5);
  });
});

// 只對淺色要求的終端機門檻：黑與亮黑（深色主題的「黑」是刻意的淡）、選取色（只在淺色定義）
describe.each(LIGHT_THEMES)("%s 的終端機（淺色）", (theme) => {
  it.each(ANSI_DARK_FAINT)("終端機 --term-%s 對終端機底至少 4.5:1", (c) => {
    expect(contrast(token(`term-${c}`, theme), token("term-bg", theme))).toBeGreaterThanOrEqual(4.5);
  });

  // 一般背景的格子被選取時，xterm 6 的兩種繪製（WebGL、DOM）都拿「終端機底疊上選取色」的不透明結果當底色；
  // 給不透明色就原樣畫出來，**不會自動變淡**——它先算好不透明版，才替另一個繪製用不到的欄位套 30%
  // （node_modules/@xterm/xterm/src/browser/services/ThemeService.ts 的 _setTheme，Codex plan R1）。
  // 選取色寫成 --term-blue 那種深藍的話，選中的藍字對比是 1:1、整段消失。
  // 門檻 3 不是 4.5：選取是暫時的，擋的是「選中就看不見」（彩色字約 3:1 是知情接受，spec §12.3）。
  // 不驗反白（SGR 7）與有明確背景色的格子：兩種繪製算法不同，DOM 下反白選取約 1.5，是知情接受（spec §12.4）。
  // 深色主題不在這組（xterm 預設的半透明白，不定義 --term-selection）
  it.each(["text", ...ANSI])("選取中的 --term-%s 對選取色至少 3:1", (c) => {
    expect(contrast(token(`term-${c}`, theme), token("term-selection", theme))).toBeGreaterThanOrEqual(3);
  });
});

// 淺色主題開 xterm 的 minimumContrastRatio（spec §12.5）：Claude Code 深色主題用 RGB 寫死的次要字 #999999
// 在淺色終端機底上約 2.5，Fledge 的 token 管不到；xterm 會把不到門檻的字調到門檻。
// 深色主題是 1＝xterm 預設、不調色：Claude Code 深色主題本來就是為深底設計的（午夜藍維持現況；票 40 的新深色主題同理由比照）
describe("終端機的最低文字對比", () => {
  const minContrast = (theme: ThemeId) => Number(/--term-min-contrast:\s*([^;]*);/.exec(themeBlock(theme))?.[1]);
  it.each(DARK_THEMES)("%s 是 1（xterm 預設，不調色）", (theme) => {
    expect(minContrast(theme)).toBe(1);
  });
  // 放在這組：同樣是「深色主題維持 xterm 預設」（daylight spec §12.6）
  it.each(DARK_THEMES)("%s 的方塊游標字色是 #000000（xterm 預設）", (theme) => {
    expect(token("term-cursor-accent", theme)).toBe("#000000");
  });
  it.each(LIGHT_THEMES)("%s 至少 4.5", (theme) => {
    expect(minContrast(theme)).toBeGreaterThanOrEqual(4.5);
  });
  // 淺色的游標兩格是「等於另一格」的規則：admin/derive_theme.py 照規則算、寫成色碼（不寫 var() 別名——term-theme.ts 用 JS 讀它們交給 xterm）。
  // 腳本的 check 只證明「CSS＝腳本現在的輸出」；這兩條獨立於腳本，規則被改掉又重產時照樣抓得到兩格不再連動
  // （票 37，Codex spec R1）。跟上面深色的「方塊游標字色是 #000000」對稱
  it.each(LIGHT_THEMES)("%s 的方塊游標字色＝終端機底", (theme) => {
    expect(token("term-cursor-accent", theme)).toBe(token("term-bg", theme));
  });
  it.each(LIGHT_THEMES)("%s 的游標＝--session-text", (theme) => {
    expect(token("term-cursor", theme)).toBe(token("session-text", theme));
  });
});

// 每個主題必須定義同一組 token：少一個就會像票 07 demo 那樣靜默壞掉（側欄的列擠成一團），只有集合比對抓得到
describe("主題區塊的 token 集合", () => {
  const nightfall = tokenNames(themeBlock("nightfall"));
  // 唯一的例外：選取色只在淺色定義，午夜藍不定義 → 讀到空字串 → xterm 用預設的半透明白（spec §3.5）
  const LIGHT_ONLY = ["term-selection"];

  it.each(THEMES)("%s 的 token ＝ 午夜藍的 token（淺色另加只在淺色的例外）", (theme) => {
    const expected = THEME_SCHEME[theme] === "light" ? [...nightfall, ...LIGHT_ONLY] : [...nightfall];
    expect([...tokenNames(themeBlock(theme))].sort()).toEqual(expected.sort());
  });

  it("午夜藍不定義只在淺色的例外", () => {
    for (const t of LIGHT_ONLY) expect(nightfall.has(t)).toBe(false);
  });

  // 結構 token 跟主題無關：只在 :root，主題區塊裡出現就代表有人又把它寫回去了（spec §3.1）
  it("圓角與列距只在 :root", () => {
    const STRUCT = ["win-radius", "row-radius", "tab-radius", "item-py"];
    const root = tokenNames(rootBlock());
    for (const t of STRUCT) expect(root.has(t), `:root 少了 --${t}`).toBe(true);
    for (const theme of THEMES) {
      for (const t of STRUCT) expect(tokenNames(themeBlock(theme)).has(t), `${theme} 不該定義 --${t}`).toBe(false);
    }
  });
});

// 深淺寫了兩份：CSS 的 color-scheme 給 WebKit 畫原生元件（捲軸、<select>），THEME_SCHEME 給原生視窗外觀與測試分組（票 40，spec §4.1）。
// 兩份要一致：表寫深、CSS 寫淺（或反過來）時，標題列和捲軸會是兩種顏色，測試分組也會拿錯的規則驗它
describe("每個主題的 color-scheme ＝ THEME_SCHEME", () => {
  it.each(THEMES)("%s", (theme) => {
    const m = /(?:^|[;{\s])color-scheme:\s*([a-z]+)\s*;/.exec(themeBlock(theme));
    expect(m?.[1], `${theme} 區塊的 color-scheme`).toBe(THEME_SCHEME[theme]);
  });
});

// 看不懂的 data-theme（localStorage 被外力改壞）要退回午夜藍，而不是一片沒有顏色的首幀——
// index.html 的啟動腳本不驗證，靠的就是這一條（spec §4.2）
describe("看不懂的主題退回午夜藍", () => {
  it("午夜藍的區塊同時掛在 :root", () => {
    expect(stripComments(readCss("/src/index.css"))).toMatch(/(^|\})\s*:root\s*,\s*\[data-theme="nightfall"\]\s*\{/);
  });
});

// 午夜藍以外的主題能不能生效，不能靠區塊在 index.css 裡的先後順序（票 38）：午夜藍掛在 :root（權重 0,1,0），
// 其他主題若只寫 [data-theme="…"] 也是 0,1,0，權重相同就是寫在後面的贏——有人把午夜藍的區塊搬到檔尾，
// 那些使用者整片變回午夜藍，而上面每一條測試都只讀區塊內容，照樣全綠。帶上 :root（0,2,0）之後，區塊怎麼排都是它贏。
// 分界是「不是午夜藍」（午夜藍兼任看不懂時的退路），跟深淺無關（票 40）
describe("午夜藍以外的主題的選擇器不靠區塊順序", () => {
  it.each(NOT_NIGHTFALL_THEMES)("%s 的區塊寫成 :root[data-theme=…]", (theme) => {
    expect(stripComments(readCss("/src/index.css"))).toMatch(new RegExp(`(^|\\})\\s*:root\\[data-theme="${theme}"\\]\\s*\\{`));
  });
});

describe("主題清單與 CSS 雙向一致", () => {
  // 產品決定的五個選項（daylight spec §2.1、票 40 spec §2.1），不是任意清單；外觀選項照這個順序排
  it("THEMES 恰好是五個產品選項", () => {
    expect([...THEMES]).toEqual(["nightfall", "nightfall-cocoa", "nightfall-iron", "daylight-cool", "daylight-warm"]);
  });

  it("index.css 的主題區塊＝THEMES（多一塊、少一塊都紅）", () => {
    expect(themesInCss().sort()).toEqual([...THEMES].sort());
  });
});

// 測試工具本身的防線：主題參數要一路傳到底（spec §6.1）。漏傳一層，淺色的測試會悄悄算成午夜藍而假綠
describe("測試工具的主題參數", () => {
  const light: ThemeId = "daylight-cool";
  it("token 解得開別名：午夜藍的 --primary-text ＝ --primary", () => {
    expect(token("primary-text", "nightfall")).toBe(token("primary", "nightfall"));
  });
  // 兩個成分各自都要用指定主題：只比「跟午夜藍不同」的話，漏傳其中一個成分也會不同而假綠
  const mix = (a: string, b: string, p: number) =>
    "rgb(" + [1, 3, 5].map((i) => Number((parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p)).toFixed(6))).join(" ") + ")";
  it("resolveColor 的 color-mix 遞迴用的是指定主題（兩個成分都是）", () => {
    expect(resolveColor("color-mix(in srgb, var(--primary) 50%, var(--bg))", light)).toBe(mix(token("primary", light), token("bg", light), 0.5));
  });
  it("stops 與 over 用的是指定主題", () => {
    expect(stops("linear-gradient(135deg, var(--bg), var(--surface) 70%)", light)).toEqual([token("bg", light), token("surface", light)]);
    expect(over("color-mix(in srgb, var(--primary) 18%, transparent)", "var(--surface)", light))
      .toBe(resolveColor("color-mix(in srgb, var(--primary) 18%, var(--surface))", light));
  });
});

// 上面那組從 token 值算對比，**算不出 opacity 疊出來的實際顏色**。
// 2026-09-02 票 06 把 --faint 調到 5.88，但 .tk-date 與 .splash-ver 有 opacity: .75，
// 實際只有 3.80——token 測試全綠、文字仍然不合格。
//
// 這條的第一版只看「同一條規則裡同時宣告 color 與 opacity」，被 Codex 抓到漏洞：
// **祖先的 opacity 會淡化整個子樹**，而祖先那條規則本身沒有 color。實例是
// .b4-card.is-na（opacity .55）裡的 .b4-card-desc（--dim），實際對比 2.66。
//
// 所以改成白名單：**任何** 0 與 1 之間的 opacity 都要在下面列名，理由寫在旁邊。
// 黑名單擋不住沒想到的形狀，白名單會逼新的用法來這裡登記。
const KEYFRAMES = /@keyframes[^{]*\{/g;
const stripKeyframes = (css: string) => {
  let out = css;
  for (;;) {
    KEYFRAMES.lastIndex = 0;
    const m = KEYFRAMES.exec(out);
    if (!m) return out;
    let depth = 1, i = m.index + m[0].length;
    while (i < out.length && depth > 0) {
      if (out[i] === "{") depth += 1;
      else if (out[i] === "}") depth -= 1;
      i += 1;
    }
    out = out.slice(0, m.index) + out.slice(i);   // 動畫步驟用 opacity 是正常的
  }
};

// 明列允許用 opacity 淡化的選擇器。每一條都要有理由。
const ALLOWED_OPACITY: Record<string, string> = {
  // 純裝飾的背景光暈，不承載任何資訊
  ".ob-glow": "裝飾光暈",
  ".ob-glow-two": "裝飾光暈",
  ".splash-glow--warm": "裝飾光暈",
  ".splash-glow--cool": "裝飾光暈",
  // 狀態指示點與刻度：非文字元件，門檻 3:1
  ".tab-dot.is-connecting": "分頁狀態點，實際 3.77 過 3:1",
  ".tab-dot.is-offline": "分頁狀態點 opacity .85，過 3:1",
  // ↓ 這兩條實際低於 3:1，2026-09-03 真機看過後**知情接受**（票 09 已關）。
  //   列在這裡是為了不讓它們被誤認為已達標——判準同待辦刻度的 2.68，
  //   見 repo 根 CONTEXT.md 的 ## Accessibility scope
  ".splash-dots i": "載入動畫的呼吸點，谷值 1.43 低於 3:1，知情接受（會動，谷值不等於使用者看到的）",
  ".tab-dot.is-ended": "分頁狀態點，實際 2.49 低於 3:1，知情接受",
};
// WCAG 1.4.3 明文豁免停用（inactive）的控制項，不必逐條登記
const DISABLED = /:disabled|\.is-disabled/;

describe("不得用 opacity 淡化", () => {
  it("所有 0 與 1 之間的 opacity 都要在白名單裡", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const [path, css] of Object.entries(RAW)) {
      const stripped = stripKeyframes(css.replace(/\/\*[\s\S]*?\*\//g, ""));
      for (const m of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const op = m[2].match(/(?:^|;)\s*opacity\s*:\s*([\d.]+)/);
        if (!op) continue;
        const v = Number(op[1]);
        if (v <= 0 || v >= 1) continue;          // 0 與 1 是顯示／隱藏，不是淡化
        scanned += 1;
        const sel = m[1].trim().replace(/\s+/g, " ");
        if (DISABLED.test(sel) || sel in ALLOWED_OPACITY) continue;
        offenders.push(`${path} ${sel} → opacity ${op[1]}`);
      }
    }
    // 掃到 0 條會讓迴圈空轉而測試全綠——先確認 regex 真的有命中
    expect(scanned).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it("白名單本身不得有死條目", () => {
    const all = Object.values(RAW)
      .map((css) => stripKeyframes(css.replace(/\/\*[\s\S]*?\*\//g, "")))
      .flatMap((css) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter((m) => /(?:^|;)\s*opacity\s*:\s*0?\.\d+/.test(m[2]))
        .map((m) => m[1].trim().replace(/\s+/g, " ")));
    // 選擇器改名或規則刪掉之後，白名單條目會變成沒人管的殘留而看起來還在保護什麼
    for (const sel of Object.keys(ALLOWED_OPACITY)) {
      expect(all, `白名單的 ${sel} 在 CSS 裡已經不存在`).toContain(sel);
    }
  });
});

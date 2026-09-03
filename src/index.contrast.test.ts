import { describe, expect, it } from "vitest";

// 主題 token 的對比防線（票 06）。
//
// Tasks.contrast.test.ts 守的是「某條 CSS 規則用的 token 夠不夠」，
// 這裡守的是上游：**token 本身**對每一種底色夠不夠。少了這層，
// 有人把 --faint 調回原本的 #5E6981 時，48 條文字規則會一起悄悄失效，
// 而每條規則各自的測試（如果有的話）都不會動。
//
// 只涵蓋 nightfall。daylight 尚未出貨（`--faint: #AEB4BE` 對它的 --bg 只有 1.94，
// 連非文字的 3:1 都不到），那套色階需要自己的一次視覺審查，見票 07。
const RAW = import.meta.glob("/src/**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const indexCss = (() => {
  const t = RAW["/src/index.css"];
  if (typeof t !== "string") throw new Error("glob 沒讀到 index.css");   // 讀不到要炸，不能靜默跳過
  return t;
})();
const nightfall = (() => {
  const from = indexCss.indexOf('[data-theme="nightfall"]');
  const to = indexCss.indexOf('[data-theme="daylight"]');
  if (from < 0 || to <= from) throw new Error("index.css 找不到 nightfall 區塊");
  return indexCss.slice(from, to);
})();
const token = (name: string) => {
  const m = nightfall.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`token --${name} 不在 nightfall 區塊裡`);
  return m[1];
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// 文字實際會坐在這些底色上。--active 不在裡面，理由見下面那條測試
const TEXT_BACKDROPS = ["bg", "sidebar", "surface", "surface-2", "hover"];
const TEXT_INKS = ["text", "dim", "faint"];

describe("nightfall 的文字色階", () => {
  it.each(TEXT_INKS.flatMap((ink) => TEXT_BACKDROPS.map((bg) => [ink, bg])))(
    "--%s 對 --%s 至少 4.5:1",
    (ink, bg) => {
      expect(contrast(token(ink), token(bg))).toBeGreaterThanOrEqual(4.5);
    },
  );

  // --active 只鋪在 .sidebar-item.is-active 與 .lrow.active 底下，
  // 那兩處的 --faint 內容是圖示與分隔符（.sidebar-item-ico.is-discovered、.lrow .sep），
  // 不是文字，門檻 3:1。把它一起塞進上面那組會逼出更亮的值、把色階壓得更平。
  it("--faint 對 --active 至少 3:1（該處只有圖示與分隔符）", () => {
    expect(contrast(token("faint"), token("active"))).toBeGreaterThanOrEqual(3);
  });

  // 色階要分得出來，否則「這是次要資訊」的暗示就沒了。
  // 這條同時擋住「為了過對比把 --faint 一路調到跟 --dim 一樣亮」
  it("三級色階彼此拉得開", () => {
    const bg = token("bg");
    const [text, dim, faint] = TEXT_INKS.map((t) => contrast(token(t), bg));
    expect(text).toBeGreaterThan(dim);
    expect(dim).toBeGreaterThan(faint);
    expect(dim - faint).toBeGreaterThanOrEqual(1);
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
  ".tov-marks i": "總覽刻度，實際 3.30 過 3:1",
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

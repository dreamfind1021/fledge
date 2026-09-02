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
const RAW = import.meta.glob("/src/index.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
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

import { useTranslation } from "react-i18next";
import { THEMES, setTheme, useTheme, type ThemeId } from "../lib/theme";
import { THEME_SCHEME } from "../lib/themeIds";
import "./LangSwitch.css";

// 程式代號 → theme.json 的 key（代號有連字號，catalog 的 key 用駝峰）
const LABEL: Record<ThemeId, string> = {
  nightfall: "nightfall",
  "nightfall-cocoa": "nightfallCocoa",
  "nightfall-iron": "nightfallIron",
  "daylight-cool": "daylightCool",
  "daylight-warm": "daylightWarm",
};

const SCHEMES = ["dark", "light"] as const;

/**
 * 外觀選項（票 07，spec docs/planning/daylight-themes-design.md §5.1）：設定視窗的「外觀」區與精靈的外觀頁共用。
 * 深色一排、淺色一排，各排照 THEMES 的順序。分組讀 THEME_SCHEME，新增的主題自動排進對的那一排
 * （一列六顆在英文的設定視窗放不下，spec docs/superpowers/specs/2026-10-03-cherry-blossom-theme-design.md §2.2、§5）。
 * 沿用語言切換鈕的膠囊（沒選的只有字、選中淡底＋寫字用的主色），不新增按鈕樣式；
 * 大小由外層容器決定（精靈裡的 .ob-theme 放大一號、兩排置中）。點了立刻生效、立刻記住，不經過「完成」或「下一步」
 */
export function ThemePicker() {
  const { t } = useTranslation("theme");
  const current = useTheme();
  return (
    <div className="theme-picker">
      {SCHEMES.map((scheme) => (
        <div key={scheme} className="lang-switch">
          {THEMES.filter((id) => THEME_SCHEME[id] === scheme).map((id) => (
            <button
              key={id}
              type="button"
              className={id === current ? "lang-switch-btn is-on" : "lang-switch-btn"}
              aria-pressed={id === current}
              onClick={() => setTheme(id)}
            >
              {t(LABEL[id])}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

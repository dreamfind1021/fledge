import { useTranslation } from "react-i18next";
import { THEMES, setTheme, useTheme, type ThemeId } from "../lib/theme";
import "./LangSwitch.css";

// 程式代號 → theme.json 的 key（代號有連字號，catalog 的 key 用駝峰）
const LABEL: Record<ThemeId, string> = {
  nightfall: "nightfall",
  "daylight-cool": "daylightCool",
  "daylight-warm": "daylightWarm",
};

/**
 * 外觀選項（票 07，spec docs/planning/daylight-themes-design.md §5.1）：設定視窗的「外觀」區與精靈的外觀頁共用。
 * 一列三顆，沿用語言切換鈕的膠囊（沒選的只有字、選中淡橘底＋橘字），不新增按鈕樣式；
 * 大小由外層容器決定（精靈裡的 .ob-theme 放大一號）。點了立刻生效、立刻記住，不經過「完成」或「下一步」
 */
export function ThemePicker() {
  const { t } = useTranslation("theme");
  const current = useTheme();
  return (
    <div className="lang-switch">
      {THEMES.map((id) => (
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
  );
}

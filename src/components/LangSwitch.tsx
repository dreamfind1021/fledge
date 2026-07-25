import { useTranslation } from "react-i18next";
import "./LangSwitch.css";

// 語言名稱一律用該語言自己的寫法（autonym）：兩種介面語言下顯示都相同，故刻意不進 catalog（§4.6.13 例外）
const LANGS = [
  { code: "zh-TW", label: "中文" },
  { code: "en", label: "English" },
] as const;

/** 語言切換：寫入 localStorage（i18n.ts 權威序最高的一階）後才切，切換立刻生效、重開仍記得 */
export function LangSwitch() {
  const { i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;

  return (
    <div className="lang-switch">
      {LANGS.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          className={code === current ? "lang-switch-btn is-on" : "lang-switch-btn"}
          aria-pressed={code === current}
          onClick={() => {
            // 先落 localStorage 再切：setItem 失敗時不會留下「這次變了、下次忘記」的不一致
            if (typeof localStorage !== "undefined") localStorage.setItem("fledge-lang", code);
            void i18n.changeLanguage(code);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

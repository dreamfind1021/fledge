import { useTranslation } from "react-i18next";
import "./LangSwitch.css";

// 語言名稱一律用該語言自己的寫法（autonym）：兩種介面語言下顯示都相同，故刻意不進 catalog（§4.6.13 例外）
const LANGS = [
  { code: "zh-TW", label: "中文" },
  { code: "en", label: "English" },
] as const;

/** 語言切換：切換成功才落 localStorage 快取（i18n.ts 權威序最高的一階），切換立刻生效、重開仍記得 */
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
          onClick={async () => {
            // 切換與寫快取不是原子操作，順序決定失敗時留下哪一種不一致：
            // 先切再寫 → 最壞情況是「切了但記不住」；反過來則是「這次沒變、下次卻變了」
            try {
              await i18n.changeLanguage(code);
            } catch (e) {
              console.warn("[i18n] 語言切換失敗，不動快取", e);
              return;
            }
            try {
              localStorage.setItem("fledge-lang", code);
            } catch (e) {
              // Storage 被停用或配額滿：這次仍是想要的語言，只是重開會忘記，不該連切都切不動
              console.warn("[i18n] 語言偏好無法寫入 localStorage", e);
            }
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

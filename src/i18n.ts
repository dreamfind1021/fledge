// i18n 最小基建（design §13；技術路線依 docs/planning/i18n-design.md）：
// 語言決定權威序＝localStorage > OS 偵測 > en
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhTW from "./locales/zh-TW/dashboard.json";
import en from "./locales/en/dashboard.json";
import memoryZhTW from "./locales/zh-TW/memory.json";
import memoryEn from "./locales/en/memory.json";
import sidebarZhTW from "./locales/zh-TW/sidebar.json";
import sidebarEn from "./locales/en/sidebar.json";
import onboardingZhTW from "./locales/zh-TW/onboarding.json";
import onboardingEn from "./locales/en/onboarding.json";
import backupZhTW from "./locales/zh-TW/backup.json";
import backupEn from "./locales/en/backup.json";
import splashZhTW from "./locales/zh-TW/splash.json";
import splashEn from "./locales/en/splash.json";
import appZhTW from "./locales/zh-TW/app.json";
import appEn from "./locales/en/app.json";

// Storage 可能不存在或拋 SecurityError（被停用、隱私模式）。這行在 module 層跑，
// 拋出去就是 import 期崩潰＝整個 app 開不起來，所以讀不到一律當沒設定、退回 OS 偵測。
function readStoredLang(): string | null {
  try {
    return localStorage.getItem("fledge-lang");
  } catch {
    return null;
  }
}

const stored = readStoredLang();
const osLang = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")
  ? "zh-TW" : "en";

i18n.use(initReactI18next).init({
  resources: {
    "zh-TW": { dashboard: zhTW, memory: memoryZhTW, sidebar: sidebarZhTW, onboarding: onboardingZhTW, backup: backupZhTW, splash: splashZhTW, app: appZhTW },
    en: { dashboard: en, memory: memoryEn, sidebar: sidebarEn, onboarding: onboardingEn, backup: backupEn, splash: splashEn, app: appEn },
  },
  lng: stored ?? osLang,
  fallbackLng: "en",
  defaultNS: "dashboard",
  interpolation: { escapeValue: false }, // React 已 escape
  // <Trans> 直接還原的語意標籤（i18n-design §2.3：catalog 只放語意標記、樣式一律留在 CSS）。
  // 預設清單是 br/strong/i/p，這裡多加 code——引導文案要標示路徑與指令字面值。
  react: { transKeepBasicHtmlNodesFor: ["br", "strong", "i", "p", "code"] },
});

// `index.html` 的 lang 是靜態 en：這裡與切換時同步真實語言，字型／斷行／螢幕閱讀器才吃得到
const syncDocumentLang = (lng: string) => {
  if (typeof document !== "undefined") document.documentElement.lang = lng;
};
syncDocumentLang(i18n.language);
i18n.on("languageChanged", syncDocumentLang);

export default i18n;

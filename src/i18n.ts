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

const stored = typeof localStorage !== "undefined" ? localStorage.getItem("fledge-lang") : null;
const osLang = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")
  ? "zh-TW" : "en";

i18n.use(initReactI18next).init({
  resources: {
    "zh-TW": { dashboard: zhTW, memory: memoryZhTW, sidebar: sidebarZhTW },
    en: { dashboard: en, memory: memoryEn, sidebar: sidebarEn },
  },
  lng: stored ?? osLang,
  fallbackLng: "en",
  defaultNS: "dashboard",
  interpolation: { escapeValue: false }, // React 已 escape
});

export default i18n;

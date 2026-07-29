import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { FeatherMark } from "./Logo";
import "./Splash.css";

// 啟動畫面（design §4.2–4.4）。視覺權威：docs/design/a-splash.html 定案版。
//
// 為什麼是 webview 內的 overlay 而非獨立 Tauri window：省掉跨 window 的 z-order／focus／關閉
// 競態，動畫直接用 CSS。代價是 webview 建構前那 <1s 的 OS 空窗遮不到（design §5.1）。

// 最短顯示：自掛載起算。入場弧本身約 920ms 演完，1.2s 只多留約 280ms——手動驗收時
// 實際看下來「來不及看清」，2s 才讓落定後的畫面有停留感。
const MIN_DISPLAY_MS = 2000;
const HINT_AFTER_MS = 5000;  // 逾時提示門檻（首開 ~14s 的場景）
const FADE_MS = 320;

export function Splash({ onDone, onRetry }: { onDone: () => void; onRetry: () => void }) {
  const { t } = useTranslation("splash");
  const startup = useAppStore((s) => s.startup);
  const startupError = useAppStore((s) => s.startupError);

  const [hinted, setHinted] = useState(false);
  const [fading, setFading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // 使用者按過重試才要把 running 顯示成「重試中」——初次啟動的 running 是一般等待態
  const [retried, setRetried] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const mountedAt = useRef(Date.now());

  // 版本號取自 tauri.conf.json（不是 /api/health）：錯誤態正是最需要版本號、
  // 而 sidecar 沒起來的時候。取不到就不顯示（jsdom 測試環境走這條）。
  useEffect(() => {
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setHinted(true), HINT_AFTER_MS);
    return () => window.clearTimeout(id);
  }, []);

  // 淡出只有一條規則：自掛載起滿 MIN_DISPLAY_MS 且序列 ready。
  // 早期失敗後快速重試成功時會自動補滿餘額；長時間失敗則早已超過、立刻淡出——
  // 所以不需要「重試不套最短顯示」這種例外（design §4.2）。
  useEffect(() => {
    if (startup !== "ready") return;
    const remaining = Math.max(0, MIN_DISPLAY_MS - (Date.now() - mountedAt.current));
    const fadeId = window.setTimeout(() => setFading(true), remaining);
    const doneId = window.setTimeout(onDone, remaining + FADE_MS);
    return () => {
      window.clearTimeout(fadeId);
      window.clearTimeout(doneId);
    };
  }, [startup, onDone]);

  const failed = startup === "failed";
  const retrying = retried && startup === "running";

  return (
    <div className={`splash${fading ? " splash--out" : ""}`} data-testid="splash">
      <div className="splash-glow splash-glow--warm" />
      <div className="splash-glow splash-glow--cool" />

      {/* 品牌三段刻意不進 catalog、兩語都顯示英文——視覺定案把它們當品牌識別而非介面文案
          （CLAUDE.md §4.6.13 記錄例外，與 Onboarding 的品牌 header 一致） */}
      <div className="splash-brand">
        <div className="splash-logo">
          <span className="splash-feather">
            <FeatherMark size={68} />
          </span>
          <span className="splash-name">Fledge</span>
        </div>
        <div className="splash-tag">Where your AI projects take off.</div>
        <div className="splash-built">Built for Claude Code</div>
      </div>

      <div className={`splash-status${failed || retrying ? " splash-status--error" : ""}`}>
        {failed || retrying ? (
          <div className="splash-err">
            <div className="splash-err-head">
              <AlertTriangle size={17} aria-hidden="true" />
              {t("errors.startup_failed")}
            </div>
            <p className="splash-err-fix">{t("errors.startup_fix")}</p>
            <button
              className="splash-err-btn"
              disabled={retrying}
              onClick={() => {
                setRetried(true);
                onRetry();
              }}
            >
              {retrying ? t("actions.retrying") : t("actions.retry")}
            </button>
            {startupError && (
              <>
                <button
                  className="splash-err-more"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((v) => !v)}
                >
                  {t("actions.details")}
                </button>
                {detailsOpen && (
                  /* 技術原文只在這裡露出（英文），不進任何 user-facing 文案的插值位。
                     打包版預設沒有 devtools，沒有這一塊使用者回報時只能說「開不起來」。 */
                  <div className="splash-err-detail">
                    {startupError}
                    {version && `\nFledge ${version}`}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="splash-wait" role="status">
            {hinted && <span className="splash-wait-text">{t("wait.hint")}</span>}
            {/* 呼吸點：沿用 app 內 session 活動指示的視覺語言 */}
            <span className="splash-dots" aria-hidden="true">
              <i /><i /><i /><i /><i />
            </span>
          </div>
        )}
      </div>

      {version && <div className="splash-ver">v{version}</div>}
    </div>
  );
}

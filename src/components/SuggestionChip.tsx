import { useState } from "react";
import { useTranslation } from "react-i18next";
import { confirmSuggestion, dismissSuggestion } from "../lib/sidecar";

// 建議 chip：topic 名 + ✓✕。await 真成功才 onAfterWrite()；失敗顯 error、不樂觀消失。
export function SuggestionChip({ port, projectPath, topic, topicName, onAfterWrite }: {
  port: number | null; projectPath: string; topic: string; topicName?: string; onAfterWrite: () => void;
}) {
  const { t } = useTranslation("memory");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState(false);
  const run = async (fn: (p: number, a: string, b: string) => Promise<void>) => {
    if (port == null || pending) return;
    setPending(true); setErr(false);
    // await 真成功（Task 1.5 已讓 wrapper 在 !ok 時 throw）才 onAfterWrite；兩路徑都 reset pending（避免 reload 後資料未變時卡 disabled）
    try { await fn(port, projectPath, topic); onAfterWrite(); setPending(false); }
    catch { setErr(true); setPending(false); }
  };
  return (
    <span className={`relchip sug${err ? " err" : ""}`}>
      <span className="ic" aria-hidden="true">◈</span>{topicName || topic.split("/").pop()}
      <span className="sg">{t("related.suggest")}</span>
      <span className="yn">
        <button type="button" aria-label={t("a11y.confirmSuggest")} disabled={pending}
          onClick={() => run(confirmSuggestion)}>✓</button>
        <button type="button" aria-label={t("a11y.dismissSuggest")} disabled={pending}
          onClick={() => run(dismissSuggestion)}>✕</button>
      </span>
      {err ? <span className="cerr">{t("settings.saveError", { msg: "" })}</span> : null}
    </span>
  );
}

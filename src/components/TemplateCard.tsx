import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store/useAppStore";
import { pickDirectory } from "../lib/dialog";
import {
  SetupError,
  fetchTemplates,
  templatesDeploy,
  templatesPlan,
  type TemplateFileResult,
  type TemplateInfo,
  type TemplateOutcome,
  type TemplatePlan,
  type TemplateState,
} from "../lib/sidecar";

interface TemplateCardProps {
  port: number | null;
}

// 下拉裡「其他位置…」那一項的值。目的地一律是絕對路徑（專案清單或 picker 給的），
// 故任何不以 `/` 開頭的字串都不可能與真實選項相撞。
const OTHER = "__fledge_other__";

// chip 用的色調。狀態點只有 ok／todo／warn／na 四種，這裡多一個 info（demo 的「尚未部署」用它）
type ChipTone = "ok" | "todo" | "warn" | "info";

// 後端 plan 的整體狀態 → chip。用 Record 窮舉而非樣板字串：後端新增狀態時這裡編譯失敗，
// 而不是靜默顯示成 key 原文（比照 CommonConfigCard 的 STATE_TEXT）。
const STATE_CHIP: Record<TemplateState, { key: string; tone: ChipTone }> = {
  not_installed: { key: "sys.state.not_installed", tone: "info" },
  partial: { key: "sys.state.partial", tone: "info" },
  complete: { key: "sys.state.complete", tone: "ok" },
  conflict: { key: "sys.state.conflict", tone: "warn" },
};

const OUTCOME_TONE: Record<TemplateOutcome, ChipTone> = {
  created: "ok",
  skipped: "todo",   // 「已存在，保留原檔」是永不覆蓋的正常結果，不是失敗
  conflict: "warn",
  stale: "warn",
  failed: "warn",
};

// 判別碼 → catalog key。**刻意用顯式表而非 `errors.${code}` 動態查**（CommonConfigCard 用動態查）：
// `probe_failed` 在共通設置卡是「讀不到帳號的設定目錄」，在這裡是「讀不到部署目的地」，
// 同一個碼在兩張卡必須是不同的文案。表外的碼一律退通用訊息、原碼只進 console。
const ERROR_TEXT: Record<string, string> = {
  unknown_template: "errors.unknown_template",
  template_unavailable: "errors.template_unavailable",
  invalid_destination: "errors.invalid_destination",
  unsafe_destination: "errors.unsafe_destination",
  probe_failed: "errors.probe_dest_failed",
};

/** 精靈系統設置頁的第三張卡（票 28）：列出 allowlist 的全部範本、選一個目的地把範本部署過去。
 *
 * 兩件刻意為之的事：
 * - **`available=false` 照列不隱藏**。public build 只內建 `project-starter`，另兩個必然是「未內建」；
 *   那是正常狀態，藏起來會讓使用者以為這個版本少了東西。未內建者不給部署鈕——按了也只會拿到
 *   `template_unavailable`。
 * - **逐列一個部署鈕**，而不是 demo 那顆放在「部署到」列尾的單一按鈕：清單有三列，單一按鈕指涉不明
 *   （要部署哪一個？），而 demo 是靜態示意、沒有模擬選擇語意。比照 EnvCard 的逐列「安裝」。 */
export function TemplateCard({ port }: TemplateCardProps) {
  const { t, i18n } = useTranslation("onboarding");
  // 目的地下拉的資料來源＝已掃到的專案。精靈走到本頁時根目錄早已落檔、store 也已載過專案
  // （`completeOnboarding` 的第二步），故直接讀 store 而不再打一次 `GET /api/projects`。
  const projects = useAppStore((s) => s.projects);

  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);   // null＝跟著預設（第一個掃到的專案）
  const [custom, setCustom] = useState<string | null>(null);   // picker 選的位置，要留在下拉裡
  // 預覽與逐檔結果都連同「產生它們的資料上下文」一起存：換 sidecar／換目的地就整批失效
  // （比照 CommonConfigCard 的 ctx——只比對相等的話 A→B→A 會讓舊結果復活）
  const [plans, setPlans] = useState<{ ctx: string; map: Record<string, TemplatePlan> } | null>(null);
  const [results, setResults] =
    useState<{ ctx: string; map: Record<string, TemplateFileResult[]> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);       // 正在部署的範本 id
  // latest-request-wins：換目的地會讓兩輪預覽重疊，晚到的舊回應照樣寫進 state 的話畫面會退回上一輪
  const reqId = useRef(0);
  const mounted = useRef(true);
  const selectId = useId();

  const dest = chosen ?? projects[0]?.path ?? "";
  const ctx = JSON.stringify([port, dest]);

  const describeError = useCallback(
    (e: unknown): string => {
      const key = e instanceof SetupError && e.code != null ? ERROR_TEXT[e.code] : undefined;
      if (key) return t(key);
      // 未映射的判別碼與連線錯誤都退到通用訊息；細節留在 console 供除錯（spec-b4 §5）
      console.warn("[templates] 未映射的錯誤", e);
      return t("errors.template_failed");
    },
    [t],
  );

  // 範本清單（與目的地無關，只跟著 port 重載）
  useEffect(() => {
    if (port == null) return;
    let alive = true;
    (async () => {
      try {
        const list = await fetchTemplates(port);
        if (alive) setTemplates(list);
      } catch (e) {
        if (!alive) return;
        console.warn("[templates] 清單載入失敗", e);
        setError(t("errors.templates_failed"));
      }
    })();
    return () => { alive = false; };
  }, [port, t]);

  /** 對每個**可用**範本預覽目前狀態。未內建的不預覽——後端只會回 `template_unavailable`。 */
  const loadPlans = useCallback(async () => {
    const available = (templates ?? []).filter((tpl) => tpl.available);
    if (port == null || dest === "" || available.length === 0) return;
    const myId = ++reqId.current;
    const myCtx = ctx;
    setError(null);
    try {
      const list = await Promise.all(available.map((tpl) => templatesPlan(port, tpl.id, dest)));
      if (reqId.current !== myId) return;
      setPlans({ ctx: myCtx, map: Object.fromEntries(available.map((tpl, i) => [tpl.id, list[i]])) });
    } catch (e) {
      if (reqId.current !== myId) return;
      // 預覽沒完成就沒有可信的狀態可顯示：留著上一輪的會變成「錯誤訊息配一組過期 chip」
      setPlans(null);
      setError(describeError(e));
    }
  }, [port, dest, templates, ctx, describeError]);

  // deploy 回來時要比對「畫面現在的上下文」，而它 closure 裡的 ctx 是送出當下那一版，故只能靠 ref。
  // 在 commit 後才更新（不寫在 render body）——render 可能被 concurrent 丟棄。
  const ctxRef = useRef(ctx);
  useLayoutEffect(() => {
    ctxRef.current = ctx;
    // 換了目的地（或 sidecar）＝上一輪的預覽與部署結果都不再描述畫面上的那個目的地
    setPlans((p) => (p != null && p.ctx !== ctx ? null : p));
    setResults((r) => (r != null && r.ctx !== ctx ? null : r));
  }, [ctx]);

  useEffect(() => { loadPlans(); }, [loadPlans]);
  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
      reqId.current += 1;     // 使在途請求失效，卸載後不再 setState
    };
  }, []);

  const deploy = async (id: string) => {
    if (port == null || dest === "") return;
    const myCtx = ctx;
    setBusy(id);
    setError(null);
    try {
      const res = await templatesDeploy(port, id, dest);
      if (!mounted.current || ctxRef.current !== myCtx) return;
      // 同一個目的地可以連續部署多個範本，逐範本累加；上下文換過就從空的開始
      setResults((r) => ({
        ctx: myCtx,
        map: { ...(r?.ctx === myCtx ? r.map : {}), [id]: res.results },
      }));
      // 失敗項的判別碼不進畫面（逐檔只顯示「處理失敗」），但要留在 console
      for (const f of res.results) {
        if (f.outcome === "failed") console.warn(`[templates] ${id}/${f.path} 失敗：${f.error}`);
      }
      await loadPlans();   // 狀態一律即時偵測（spec-b4 §4）：部署後不能停在過時的預覽
    } catch (e) {
      if (!mounted.current || ctxRef.current !== myCtx) return;
      setError(describeError(e));
    } finally {
      // busy 一律解除（連作廢的那一輪也是）——不解除按鈕會永久停用到切頁重掛（票 25 R4）
      if (mounted.current) setBusy(null);
    }
  };

  const onDestChange = async (value: string) => {
    if (value !== OTHER) {
      setChosen(value);
      return;
    }
    const picked = await pickDirectory();
    // 取消 → 什麼都不動：select 綁的是 dest，會自己回到原本那一個
    if (!picked) return;
    setCustom(picked);
    setChosen(picked);
  };

  const destOptions = projects.map((p) => ({ value: p.path, label: `${p.name} — ${p.path}` }));
  if (custom != null && !destOptions.some((o) => o.value === custom)) {
    destOptions.push({ value: custom, label: custom });
  }

  const chipFor = (tpl: TemplateInfo): { key: string; tone: ChipTone } | null => {
    if (!tpl.available) return { key: "sys.notBundled", tone: "todo" };
    const plan = plans?.ctx === ctx ? plans.map[tpl.id] : undefined;
    return plan ? STATE_CHIP[plan.state] : null;
  };

  return (
    <div className="b4-sec">
      <p className="b4-sec-h">{t("sys.tplTitle")}</p>
      <div className="b4-card">
        {error && <div className="ob-error" role="alert">{error}</div>}

        <div className="b4-list">
          {(templates ?? []).map((tpl) => {
            const chip = chipFor(tpl);
            const files = results?.ctx === ctx ? results.map[tpl.id] : undefined;
            return (
              <div key={tpl.id} className="b4-row-group">
                <div className="b4-item">
                  <span className={`b4-dot ${tpl.available ? "ok" : "na"}`} />
                  <div className="b4-tpl-text">
                    <span className="b4-item-name">{tpl.label}</span>
                    {/* 說明以 id 對 catalog；catalog 沒有這個 id（後端新增了範本）才退後端的英文
                        description——後端一律回英文（§4.6.13），拿它當常態文案會露出未翻譯的字串 */}
                    <p className="b4-card-desc">
                      {i18n.exists(`sys.tpl.${tpl.id}`, { ns: "onboarding" })
                        ? t(`sys.tpl.${tpl.id}`)
                        : tpl.description}
                    </p>
                  </div>
                  <span className="b4-item-right">
                    {chip && <span className={`b4-chip ${chip.tone}`}>{t(chip.key)}</span>}
                    {tpl.available && (
                      <button
                        className="b4-btn-sm primary"
                        onClick={() => deploy(tpl.id)}
                        disabled={dest === "" || busy != null}
                      >{t("sys.deploy")}</button>
                    )}
                  </span>
                </div>

                {/* 逐檔結果（部署後）。永不覆蓋是後端的不變式，這裡只如實呈現每個檔案的下場 */}
                {files && (
                  <div className="b4-files">
                    {files.map((f) => (
                      <div key={f.path} className="b4-file">
                        <span className="b4-item-meta">{f.path}</span>
                        <span className={`b4-chip ${OUTCOME_TONE[f.outcome]}`}>
                          {t(`sys.result.${f.outcome}`)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="b4-field b4-field-dest">
          <label htmlFor={selectId}>{t("sys.deployTo")}</label>
          <select
            id={selectId}
            className="ob-input"
            value={dest}
            onChange={(e) => onDestChange(e.target.value)}
          >
            {destOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            <option value={OTHER}>{t("sys.otherLocation")}</option>
          </select>
        </div>

        {dest === "" && <p className="b4-hint">{t("sys.needDest")}</p>}
        <p className="b4-hint">{t("sys.deployHint")}</p>
      </div>
    </div>
  );
}

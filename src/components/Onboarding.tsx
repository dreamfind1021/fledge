import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { useTranslation, Trans } from "react-i18next";
import { useAppStore } from "../store/useAppStore";
import { scanPreview, DEFAULT_ACCOUNT_KEY } from "../lib/sidecar";
import { pickDirectory } from "../lib/dialog";
import {
  wizardSteps,
  stepIndex,
  clampStepIndex,
  progressCells,
  type WizardMode,
  type WizardStep,
} from "../lib/onboardingSteps";
import { FeatherMark } from "./Logo";
import { LangSwitch } from "./LangSwitch";
import { EnvCard } from "./EnvCard";
import { LoginCard } from "./LoginCard";
import { CommonConfigCard } from "./CommonConfigCard";
import { SystemSettingsCard } from "./SystemSettingsCard";
import { BundleCard, EMPTY_BUNDLE_SELECTION, type BundleSelection } from "./BundleCard";
import { TargetsCard } from "./TargetsCard";
import "./Onboarding.css";

interface OnboardingProps {
  onClose: () => void;
}

interface DraftRoot {
  path: string;
  account: string;
  count: number;
}

export function Onboarding({ onClose }: OnboardingProps) {
  const { t } = useTranslation("onboarding");
  const port = useAppStore((s) => s.port);
  const config = useAppStore((s) => s.config);
  const projects = useAppStore((s) => s.projects);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const loadConfig = useAppStore((s) => s.loadConfig); // onboard 失敗時向後端對帳落檔狀態
  // 首次時 config 為 in-memory DEFAULT（票 31 起是單一帳號 default）
  const accountKeys = config ? Object.keys(config.accounts) : [DEFAULT_ACCOUNT_KEY];

  // 歡迎頁的二選一。移機分支（票 12 Plan B）的頁面序列與全新設定從第二頁起就完全分岔。
  const [mode, setMode] = useState<WizardMode>("fresh");
  // 導覽 state 存「哪一頁」而不是「第幾頁」：移機序列的 `paths` 會因備份包內容而增刪，且那是
  // 非同步得知的，存索引會讓同一個數字在序列變動後指到別頁（Codex F1，見 onboardingSteps）
  const [current, setCurrent] = useState<WizardStep>("welcome");
  const [draftRoots, setDraftRoots] = useState<DraftRoot[]>([]);
  const [newPath, setNewPath] = useState("");
  const [newAccount, setNewAccount] = useState(accountKeys[0] ?? DEFAULT_ACCOUNT_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // onboard 是 first-run only（設定檔已存在回 409），落檔與否決定「根目錄頁還能不能編輯」與
  // 「主按鈕要不要再打一次 onboard」。不讀 config.is_first_run 判斷——後續頁的 config write
  // 會讓該欄變 undefined（Codex F-7 已警告不可當 render gate），只拿它當初值：唯有明確為 true
  // 才是「尚未落檔」，重跑引導時（設定檔早已存在）一進來就算已落檔。
  const [configCreated, setConfigCreated] = useState(config?.is_first_run !== true);
  // 備份包的選擇（票 02）：選了哪一包、解到哪裡、裡面有什麼。**整組住在這裡而不是卡片裡**
  // ——卡片會隨換頁卸載，只把包資訊留在上層會讓「還沒選任何包的卡片」顯示上一包的摘要
  // （Codex 票 02 R1 F2）。其中包資訊還是**序列本身的輸入**：`paths` 頁在包裡沒有專案歷史
  // 時整頁不出現，而那要展開後才知道。
  const [bundle, setBundle] = useState<BundleSelection>(EMPTY_BUNDLE_SELECTION);
  const overlayRef = useRef<HTMLDivElement>(null);

  const steps = wizardSteps({
    accountCount: accountKeys.length,
    mode,
    // `unknown` 要傳 undefined 而不是 false：那是「還不知道」，此時先留著 `paths` 頁
    hasProjectHistory:
      bundle.probe.kind === "unknown" ? undefined : bundle.probe.kind === "present",
  });
  const index = stepIndex(current, steps, mode);
  const step = steps[index];

  const goTo = (target: WizardStep) => {
    setCurrent(target);
    setError(null); // 訊息是當前頁的暫態回饋，換頁後留著只會誤導
    setNotice(null);
    if (overlayRef.current) overlayRef.current.scrollTop = 0; // overlay 可捲動，換頁要從頂端看起
  };
  // 夾取只擋兩端越界（首頁的上一步、末頁的下一步都是無效動作），語意定位交給 stepIndex()
  const adjacentStep = (delta: number) => steps[clampStepIndex(index + delta, steps.length)];
  const next = () => goTo(adjacentStep(1));
  const prev = () => goTo(adjacentStep(-1));
  // 選路線與前進是同一個動作。指名頁而不是索引：兩條序列的第二頁本來就是不同的頁
  const start = (picked: WizardMode) => {
    setMode(picked);
    goTo(picked === "restore" ? "bundle" : "roots");
  };

  /** 移機各頁共用的導覽列。`blocked` 是「這一頁還沒有往下走的依據」（票 02 的包資訊）。 */
  const migNav = (blocked = false) => (
    <div className="ob-actions">
      <button onClick={prev} className="ob-btn-ghost">{t("common.prev")}</button>
      <button onClick={next} className="ob-btn" disabled={blocked}>{t("common.next")}</button>
    </div>
  );

  /**
   * 移機分支的空殼頁：只有標題與導覽，內容由票 03–08 逐一填實。
   * 票 01 只負責「兩條路的序列不同、每一頁走得過去」；`bundle` 已由票 02 填實。
   */
  const migShell = (key: "targets" | "paths" | "install" | "repair") => (
    <div>
      <h2 className="ob-h">{t(`mig.${key}.h`)}</h2>
      {migNav()}
    </div>
  );

  const browse = async () => {
    const p = await pickDirectory();
    if (p) setNewPath(p);
  };

  const addDraftRoot = async () => {
    const raw = newPath.trim();
    if (!raw || port == null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await scanPreview(port, raw);
      // invalid/missing/not_dir：路徑不可用 → 不加 draft、即時回饋（onboard 原子，
      // 預先擋掉才不會在 finish 時整批 400）
      if (res.status === "invalid" || res.status === "missing" || res.status === "not_dir") {
        setError(t(`errors.${res.status}`));
        return;
      }
      // denied：路徑有效但當下不可讀（count 可能為 0）→ 仍加入，用 amber notice 而非紅色
      // error（紅 banner 會讓「其實加成功」看起來像失敗）
      if (res.status === "denied") setNotice(t("errors.denied"));
      // dedup 放進 functional updater 內讀最新 state（避免快速連點看到舊 draftRoots）
      setDraftRoots((rs) =>
        rs.some((r) => r.path === res.path) ? rs : [...rs, { path: res.path, account: newAccount, count: res.count }],
      );
      setNewPath("");
    } catch (e) {
      // 連線/後端錯誤要可見，但原文只進 console（spec-b4 §5）
      console.error("[onboarding] 試掃失敗", e);
      setError(t("errors.scan_failed"));
    } finally {
      setBusy(false);
    }
  };

  const setDraftAccount = (path: string, account: string) =>
    setDraftRoots((rs) => rs.map((r) => (r.path === path ? { ...r, account } : r)));
  const removeDraft = (path: string) => {
    setDraftRoots((rs) => rs.filter((r) => r.path !== path));
    setNotice(null); // denied 提示是 add 動作的暫態回饋，移除 draft 後該清掉、免殘留誤導
  };

  // 根目錄頁的主按鈕：落檔後留在精靈往下走（ADR-0003）。回頭再按不會重打 onboard。
  const saveRootsAndContinue = async () => {
    if (configCreated) {
      next();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completeOnboarding(
        draftRoots.map((r) => ({ path: r.path, default_account: r.account })),
      );
      setConfigCreated(true);
      next();
    } catch (e) {
      // 落檔是不可逆的，誤判成未落檔會讓使用者再按一次撞 409 死循環。而失敗有兩種形狀：
      //   ① onboard 成功、後半的專案重載才失敗 → store config 已是帶 is_first_run:false 的回應
      //   ② 落檔已發生但事實沒進 store —— onboard() 是 resp.ok 之後才 resp.json()，body 截斷或
      //      sidecar 在 config.save() 之後斷線都屬此類
      // ② 用快照推斷不出來，所以快照說「還沒落檔」時不採信，回頭問後端（is_first_run 是後端依
      // 設定檔存在與否即時算的，唯一權威）。連後端都問不到就維持未落檔——狀態不明時，讓下一次
      // 重試去撞 409 也好過默默往下走。
      let saved = useAppStore.getState().config?.is_first_run !== true;
      if (!saved) {
        try {
          await loadConfig();
          saved = useAppStore.getState().config?.is_first_run !== true;
        } catch (reconcileError) {
          console.warn("[onboarding] 落檔狀態對帳失敗，維持未落檔", reconcileError);
        }
      }
      if (saved) setConfigCreated(true);
      // onboard 409/400/連線錯誤要可見（Codex final review L2）；已落檔時不能謊稱寫入失敗。
      // 原文只進 console（spec-b4 §5）——`fetchProjects failed: 500` 之類對使用者沒有意義
      console.error("[onboarding] 落檔或專案重載失敗", e);
      setError(t(saved ? "errors.projects_reload_failed" : "errors.onboard_failed"));
    } finally {
      setBusy(false);
    }
  };

  // 落檔後要顯示的是**設定檔裡已經有的**根目錄：`draftRoots` 只裝「這一次新加的」，重跑引導
  // （票 29 的入口）時必然是空的——只認它會讓根目錄頁變成「設定檔已建立」配一張空清單。
  // 專案數取自 store 已載入的專案（依所屬 root 歸屬），不必為了顯示再掃一次。
  const savedRoots: DraftRoot[] = (config?.roots ?? []).map((r) => ({
    path: r.path,
    account: r.default_account,
    count: projects.filter((p) => p.root === r.path).length,
  }));
  // 首次啟動時 draft 有內容就用 draft（那才有 scan-preview 的即時計數），落檔後回頭看也還是它；
  // 重跑引導沒有 draft，就顯示設定檔的內容
  const shownRoots = draftRoots.length > 0 ? draftRoots : savedRoots;

  const totalProjects = shownRoots.reduce((s, r) => s + r.count, 0);
  const distinctAccounts = new Set(shownRoots.map((r) => r.account)).size;

  return (
    <div className="ob-overlay" ref={overlayRef}>
      {/* 裝飾光暈：pointer-events none，不影響互動 */}
      <div className="ob-glow" aria-hidden="true" />
      <div className="ob-glow-two" aria-hidden="true" />

      <div className="ob-inner">
        {/* 語言切換：絕對定位在容器右上，不佔流佈局（各頁高度不因它變動） */}
        {step === "welcome" && (
          <div className="ob-lang">
            <LangSwitch />
          </div>
        )}

        {/* 品牌 header：每一頁都顯示。三段品牌字串刻意不進 catalog、兩語都顯示英文原文
            （§4.6.13 記錄例外，比照 memory.json 的 type enum 與 LangSwitch 的語言 autonym）——
            hi-fi demo 也沒給這兩句 data-t，等同視覺定案把它們當品牌識別而非介面文案。 */}
        <div className="ob-logo">
          <FeatherMark size={46} />
          <span className="ob-logo-name">Fledge</span>
        </div>
        <div className="ob-tag">Where your AI projects take off.</div>
        <div className="ob-built">Built for Claude Code</div>

        {/* 卡片主體 */}
        <div className="ob-card">
          {/* 進度條：格數＝實際頁數（單帳號少一格），填到目前頁為止 */}
          <div
            className="ob-steps"
            role="progressbar"
            aria-label={t("common.progress")}
            aria-valuenow={index + 1}
            aria-valuemin={1}
            aria-valuemax={steps.length}
          >
            {progressCells(index, steps.length).map((on, i) => (
              <div key={i} className={`ob-step-bar${on ? " is-on" : ""}`} />
            ))}
          </div>

          {/* 錯誤 / 注意訊息 */}
          {error && <div className="ob-error" role="alert">{error}</div>}
          {notice && <div className="ob-notice" role="status">{notice}</div>}

          {/* ── 歡迎 ── */}
          {step === "welcome" && (
            <div className="ob-step-center">
              <h2 className="ob-h">{t("welcome.h")}</h2>
              <p className="ob-sub"><Trans t={t} i18nKey="welcome.sub" /></p>
              <div className="ob-actions-center">
                <button onClick={() => start("fresh")} className="ob-btn">{t("welcome.fresh")}</button>
                <button onClick={() => start("restore")} className="ob-btn-ghost">
                  {t("welcome.restore")}
                </button>
              </div>
            </div>
          )}

          {/* ── 根目錄（本頁落檔）：只在全新設定的序列裡。移機的對應頁是 `targets`（授權落點、
                 走 adopt-config 而非 onboard），刻意是另一個 step 身分，見票 03 ── */}
          {step === "roots" && (
            <div>
              <h2 className="ob-h">{t("roots.h")}</h2>
              <p className="ob-sub">{t("roots.sub")}</p>
              <div className="ob-note">
                {configCreated ? t("roots.created") : <Trans t={t} i18nKey="roots.note" />}
              </div>

              {/* 已加入的根目錄列表；落檔後純顯示——改動要走設定頁，不再有第二次 onboard */}
              {shownRoots.map((r) => (
                <div key={r.path} className="ob-row">
                  <span className="ob-row-path">{r.path}</span>
                  <select
                    value={r.account}
                    onChange={(e) => setDraftAccount(r.path, e.target.value)}
                    disabled={configCreated}
                    className="ob-sel"
                  >
                    {accountKeys.map((a) => (<option key={a} value={a}>{a}</option>))}
                  </select>
                  <span className="ob-row-count">
                    <Check size={12} strokeWidth={2} />{r.count}
                  </span>
                  <button
                    onClick={() => removeDraft(r.path)}
                    disabled={configCreated}
                    className="ob-btn-del"
                  >{t("common.del")}</button>
                </div>
              ))}

              {/* 新增根目錄輸入列 */}
              {!configCreated && (
                <div className="ob-add-row">
                  <input
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder={t("roots.placeholder")}
                    className="ob-input"
                  />
                  <button onClick={browse} className="ob-btn-ghost">{t("common.browse")}</button>
                  <select
                    value={newAccount}
                    onChange={(e) => setNewAccount(e.target.value)}
                    className="ob-sel"
                  >
                    {accountKeys.map((a) => (<option key={a} value={a}>{a}</option>))}
                  </select>
                  <button onClick={addDraftRoot} disabled={busy} className="ob-btn">{t("roots.add")}</button>
                </div>
              )}

              <div className="ob-actions">
                <button onClick={prev} className="ob-btn-ghost">{t("common.prev")}</button>
                <button
                  onClick={saveRootsAndContinue}
                  disabled={busy || (!configCreated && draftRoots.length === 0)}
                  className="ob-btn"
                >{configCreated ? t("common.next") : t("roots.next")}</button>
              </div>
            </div>
          )}

          {/* ── 移機分支的四頁（票 12 Plan B）：目前是空殼，票 02–08 逐一填實 ── */}
          {/* 備份包頁（票 02）：包資訊還是 `unknown` 就走不出去——後面每一頁要列什麼、
              `paths` 頁在不在，全都來自這一包 */}
          {step === "bundle" && (
            <div>
              <BundleCard port={port} selection={bundle} onSelection={setBundle} />
              {bundle.probe.kind === "unknown" && (
                <p className="ob-note">{t("mig.bundle.needInfo")}</p>
              )}
              {migNav(bundle.probe.kind === "unknown")}
            </div>
          )}
          {/* 落點頁（票 03）：落檔是不可逆的，確認之前不放行——後面每一頁都從落檔後的
              config.json 讀落點。包資訊還是 unknown 就沒有展開位置可用（正常流程走不到
              這裡，bundle 頁的 gating 擋著），退回空殼而不是拿 undefined 去打端點 */}
          {step === "targets" && (
            bundle.probe.kind === "unknown" ? migShell("targets") : (
              <div>
                <TargetsCard
                  port={port}
                  dest={bundle.probe.dest}
                  info={bundle.probe.info}
                  saved={configCreated}
                  // **先把剛建立的設定讀回 store 才算完成**（Codex 票 03 R1 F2）：後面的
                  // 頁面（登入卡等）讀的是 store 的 accounts，只翻旗標會讓使用者看到
                  // in-memory 的預設帳號。讀不回來就 throw 回卡片——它會顯示錯誤且不轉
                  // 唯讀，下一步也就仍然被擋著。
                  onSaved={async () => {
                    await loadConfig();
                    setConfigCreated(true);
                  }}
                />
                {migNav(!configCreated)}
              </div>
            )
          )}
          {step === "paths" && migShell("paths")}
          {step === "install" && migShell("install")}
          {step === "repair" && migShell("repair")}

          {/* ── 環境偵測（票 23）：標題、清單與導覽都在卡片內，重新檢查與下一步同列 ── */}
          {step === "env" && <EnvCard port={port} onPrev={prev} onNext={next} />}

          {/* ── 登入（票 25）：每個帳號一張卡 + Codex 一張，導覽在卡片內 ── */}
          {step === "login" && (
            <LoginCard
              port={port}
              accounts={config?.accounts ?? {}}
              onPrev={prev}
              onNext={next}
            />
          )}

          {/* ── 共通設置（票 26）：逐項狀態 + 非破壞性套用，導覽在卡片內 ── */}
          {step === "common" && (
            <CommonConfigCard
              port={port}
              accounts={config?.accounts ?? {}}
              onPrev={prev}
              onNext={next}
            />
          )}

          {/* ── 系統設置（票 27）：訂閱 + 知識庫根目錄，兩區都可略過；範本卡待票 28 ── */}
          {step === "system" && (
            <SystemSettingsCard
              port={port}
              subscriptions={config?.subscriptions ?? []}
              kmsRoot={config?.kms_root ?? ""}
              onPrev={prev}
              onNext={next}
            />
          )}

          {/* ── 完成 ── */}
          {step === "done" && (
            <div className="ob-step-center">
              <h2 className="ob-h">{t("done.h")}</h2>
              <p className="ob-summary">
                <Trans
                  t={t}
                  i18nKey="done.summary"
                  values={{ projects: totalProjects, roots: shownRoots.length, accounts: distinctAccounts }}
                />
              </p>
              <p className="ob-sub">{t("done.hint")}</p>
              <div className="ob-actions-center">
                <button onClick={prev} className="ob-btn-ghost">{t("common.prev")}</button>
                <button onClick={onClose} className="ob-btn">{t("done.enter")}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { useTranslation, Trans } from "react-i18next";
import { useAppStore } from "../store/useAppStore";
import { useEffect } from "react";
import { scanPreview, runInstall, fetchBundleInfo, RestoreError, DEFAULT_ACCOUNT_KEY,
         type InstallItemResult } from "../lib/sidecar";
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
import { PathsCard, type PathsStatus, type ProjectMapping } from "./PathsCard";
import { InstallPreviewCard } from "./InstallPreviewCard";
import { InstallResultCard } from "./InstallResultCard";
import { RepairCard } from "./RepairCard";
import "./Onboarding.css";

interface OnboardingProps {
  onClose: () => void;
  /**
   * 中斷續作（票 07）：從還原卡的「繼續移機」進來時，直接落在移機分支的安裝頁，並把上次
   * 填的展開位置與專案路徑對應預填回去。
   *
   * **只是預填值不是授權**（增補 spec §3.4）：使用者仍要看預覽、按下安裝，真正的驗證全在
   * `install.plan()`（bundle 形狀、身分綁定、mapping 三態驗證、落點重疊、containment）。
   */
  resume?: { sourceRoot: string; mapping: { old: string; new: string }[] };
}

interface DraftRoot {
  path: string;
  account: string;
  count: number;
}

/** 安裝這一步的狀態（票 06）。`done` 之後**不再提供安裝按鈕**——那是整條流程裡唯一
 *  不可逆的動作，重複送出沒有意義（no-clobber 下第二次全是 skipped，卻讓人以為裝了兩份）。 */
type InstallRun =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; results: InstallItemResult[]; staleTemps: string[] };

export function Onboarding({ onClose, resume }: OnboardingProps) {
  const { t } = useTranslation("onboarding");
  const port = useAppStore((s) => s.port);
  const config = useAppStore((s) => s.config);
  const projects = useAppStore((s) => s.projects);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const loadConfig = useAppStore((s) => s.loadConfig); // onboard 失敗時向後端對帳落檔狀態
  // 首次時 config 為 in-memory DEFAULT（票 31 起是單一帳號 default）
  const accountKeys = config ? Object.keys(config.accounts) : [DEFAULT_ACCOUNT_KEY];

  // 歡迎頁的二選一。移機分支（票 12 Plan B）的頁面序列與全新設定從第二頁起就完全分岔。
  const [mode, setMode] = useState<WizardMode>(resume ? "restore" : "fresh");
  // 導覽 state 存「哪一頁」而不是「第幾頁」：移機序列的 `paths` 會因備份包內容而增刪，且那是
  // 非同步得知的，存索引會讓同一個數字在序列變動後指到別頁（Codex F1，見 onboardingSteps）
  const [current, setCurrent] = useState<WizardStep>(resume ? "install" : "welcome");
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
  // **這一輪真的從備份包帶回了設定嗎**。與 `configCreated` 是兩件事：那個對「機器上
  // 本來就有設定檔」也是 true（重跑引導、`config` 還沒載入），拿它當「帶回了什麼」的
  // 依據就會宣稱沒發生過的事（Codex 票 09 R1 F2）。只有 `adopt-config` 真的建立了新
  // 設定檔、而且父層把它讀回 store 之後才成立。
  //
  // **綁 `bundle.gen`**（Codex 票 09 R2 F4）：換包之後設定檔已經在了，`configCreated`
  // 仍是 true、卡片是 saved、`onSaved` 不會再跑——旗標若不綁來源，A 包帶回的內容就會
  // 掛在 B 包的流程上被說成「這一包帶回來的」。`mapping`／`pathsStatus`／`previewStatus`
  // ／`installRun` 全都綁 gen，這是同一族防線，新 state 不能漏套。
  const [adoptedFrom, setAdoptedFrom] = useState<{ gen: number; value: boolean }>(
    { gen: -1, value: false });
  // 備份包的選擇（票 02）：選了哪一包、解到哪裡、裡面有什麼。**整組住在這裡而不是卡片裡**
  // ——卡片會隨換頁卸載，只把包資訊留在上層會讓「還沒選任何包的卡片」顯示上一包的摘要
  // （Codex 票 02 R1 F2）。其中包資訊還是**序列本身的輸入**：`paths` 頁在包裡沒有專案歷史
  // 時整頁不出現，而那要展開後才知道。
  const [bundle, setBundle] = useState<BundleSelection>(EMPTY_BUNDLE_SELECTION);
  // 專案路徑對應（票 04）。**這一頁不寫任何東西**——改寫在 install 時才發生，所以對應
  // 關係住在這裡、一路帶到安裝頁，按下安裝之前隨時能回去改。
  //
  // **綁在 `bundle.gen` 上**（Codex 票 04 R1 F1）：換包、換展開位置、重新展開都會讓它
  // 失效——舊 key 不屬於新包，送進 plan 是 `mapping_unknown_project`；兩包剛好有同一條
  // 舊路徑時更糟，上一包的人工選擇會靜靜套到新包上。
  const [mapping, setMapping] = useState<ProjectMapping>(
    () => Object.fromEntries((resume?.mapping ?? []).map((m) => [m.old, m.new])));
  // **狀態綁著它是哪一包讀出來的**（Codex 票 04 R2）：只存 status 的話，換包之後 gating
  // 會先看到上一包的 `loaded`——在新包的清單根本還沒讀之前就放行。
  const [pathsStatus, setPathsStatus] = useState<{ gen: number; value: PathsStatus }>(
    { gen: -1, value: "loading" });
  // 預覽的載入狀態同款綁著來源（票 05）：算不出這次會發生什麼，就不該讓使用者按下
  // 不可逆的安裝
  const [previewStatus, setPreviewStatus] = useState<{ gen: number; value: PathsStatus }>(
    { gen: -1, value: "loading" });
  // 安裝的執行與結果（票 06）同款綁著來源：一份結果報告是「對某一包做的」，換包之後它
  // 不屬於新的包——留著會讓使用者以為新的包也已經裝過了
  const [installRun, setInstallRun] = useState<{ gen: number; value: InstallRun }>(
    { gen: -1, value: { kind: "idle" } });
  // 本次流程（同一個 `bundle.gen`）累積裝成的 node。與 `installRun` 是兩件事：那個是
  // 「最後一輪跑出什麼」（結果頁要照實顯示這一輪），這個是「這次移機總共搬回了什麼」
  // （完成頁要的）。重試會覆寫前者，但不該讓後者忘掉前幾輪。
  // `unknown`＝有一輪的結果沒能回報（連線斷／非合約 500）。那一輪**可能已經完整跑完**，
  // 而重試會讓 no-clobber 把那些項目回報成 `skipped`——累積器看不到它們，數字就會少報甚至
  // 歸零。前端沒有辦法知道真相（那要對 provenance journal 對帳，是後端的能力），所以旗標
  // 一旦豎起來就**不報數字**，比照票 06 的 `installUnknown`（Codex 票 08 R2 F3）。
  const [installedTally, setInstalledTally] =
    useState<{ gen: number; keys: string[]; unknown: boolean }>(
      { gen: -1, keys: [], unknown: false });
  // 當下的來源身分（render body 同步寫回）：續作探測的錯誤路徑要靠它判斷「這個訊息還
  // 屬不屬於現在這一包」——`setBundle` 的 functional update 讀得到最新的 gen，`setError`
  // 讀不到（比照 `InstallPreviewCard.liveSource`）
  // 續作入場探測的兩個獨立條件（見下面那支 effect）：`resumeGen`＝它綁定的來源身分
  // （使用者一換包就永久失效），`resumeApplied`＝**成功套用之後**才消費掉
  const resumeGen = useRef<number | null>(null);
  const resumeApplied = useRef(false);
  const liveGen = useRef(bundle.gen);
  liveGen.current = bundle.gen;
  const mappingGen = useRef(bundle.gen);
  if (mappingGen.current !== bundle.gen) {
    // render body 同步清空：等 effect 會讓 PathsCard 先用舊 mapping seed 一次
    mappingGen.current = bundle.gen;
    if (Object.keys(mapping).length > 0) setMapping({});
    if (pathsStatus.gen !== bundle.gen) setPathsStatus({ gen: bundle.gen, value: "loading" });
    if (previewStatus.gen !== bundle.gen) setPreviewStatus({ gen: bundle.gen, value: "loading" });
    if (installRun.gen !== bundle.gen) {
      setInstallRun({ gen: bundle.gen, value: { kind: "idle" } });
    }
  }
  const run: InstallRun = installRun.gen === bundle.gen
    ? installRun.value : { kind: "idle" };
  const previewReady = previewStatus.gen === bundle.gen && previewStatus.value === "loaded";
  // 完成頁的移機總結（票 16 第 2 項）。**累積本次流程裝成的 node，不是最後一輪的結果**
  // （Codex 票 08 R1 F1）：部分成功後按「再試一次」會覆寫 `run`，而第二輪因 no-clobber
  // 把前一輪裝好的回報成 `skipped`——只看最後一輪就會少報。存 node 身分而不是計數，
  // 是為了讓「同一項在兩輪都算成」不會被數兩次（no-clobber 下不該發生，但這是計數的
  // 正確性前提，不該建立在別處的行為上）。
  // 同樣綁 `bundle.gen`：換包就重新開始數，上一包裝了什麼與這一包無關。
  const tally = installedTally.gen === bundle.gen
    ? installedTally : { gen: bundle.gen, keys: [] as string[], unknown: false };
  const installedCount = tally.keys.length;
  const adoptedFromBundle = adoptedFrom.gen === bundle.gen && adoptedFrom.value;
  const overlayRef = useRef<HTMLDivElement>(null);

  // 續作（票 07）：安裝頁的每一項都從那份展開的包算出來，所以進去之前要先確認它還讀得出來
  // （狀態端點驗過一次，但那是在使用者按下繼續之前）。
  //
  // **只換 `probe`、不動 `gen`**：`gen` 是「來源身分」，而續作不是換包——來源從一開始就是
  // 這一個。動它會觸發 render body 的換包清空，把剛預填好的專案對應洗掉（票 04 的機制）。
  useEffect(() => {
    // 這支 effect 依賴 `port` 與 `t`，sidecar 重啟換 port、或使用者退回歡迎頁切語言都會
    // 讓它重跑。**兩件事要分開判**（Codex 票 07 R2／R3）：
    //   ①「使用者已經換過包」→ 續作**永久失效**：重跑時 `startGen` 會重新擷取當下的 gen，
    //     於是換包之後的比對照樣成立、probe 又被換回舊來源（R2）
    //   ②「探測還沒成功」→ 換 port 應該**重試**：把消費點放在請求開始前的話，sidecar 在
    //     探測途中重啟就永久取消了它——既不重試也不報錯，續作頁停在空殼（R3）
    if (resume === undefined || port == null) return;
    if (resumeGen.current === null) resumeGen.current = bundle.gen;   // 進場時綁定
    if (resumeGen.current !== bundle.gen || resumeApplied.current) return;
    let live = true;
    // **遲到的回應不得覆蓋使用者後來選的包**（Codex 票 07 R1 F2）：這支探測在飛的時候，
    // 使用者可以回上一頁換一包（BundleCard 會把 `gen` 推進）。沒有這道比對的話，畫面上
    // 是新包、預覽與安裝卻用續作帶進來的舊來源。與 `InstallPreviewCard`／`PathsCard` 的
    // `liveSource` 同一個模式——續作這條路徑當初漏了套。
    const startGen = bundle.gen;
    void (async () => {
      try {
        const info = await fetchBundleInfo(port, resume.sourceRoot);
        if (!live) return;
        setBundle((cur) => (cur.gen === startGen
          ? { ...cur, probe: { kind: "present", info, dest: resume.sourceRoot } }
          : cur));
        resumeApplied.current = true;     // **成功套用之後**才消費，失敗留給換 port 重試
      } catch (e) {
        // 判別碼與例外原文只進 console（CLAUDE.md §4.6.13）
        console.error("[onboarding] 續作讀不到包資訊", e);
        // 已經換過包就不報這個錯：那份續作來源已經與畫面無關，訊息只會誤導
        if (live && liveGen.current === startGen) {
          setError(t("mig.install.errors.resumeFailed"));
        }
      }
    })();
    return () => { live = false; };
  }, [resume, port, t]);   // eslint-disable-line react-hooks/exhaustive-deps

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
   * 移機分支頁面的**降級外殼**：包資訊還是 `unknown` 時（正常流程走不到，`bundle` 頁的
   * gating 擋著）沒有展開位置可用，退回只有標題與導覽的空殼，而不是拿 undefined 去打端點。
   *
   * 票 01 時它是「還沒填實的頁」的佔位；三頁都填實之後只剩這個降級用途——`repair`
   * 因此不再在列（票 08：那一頁不依賴備份包的內容）。
   */
  const migShell = (key: "targets" | "paths" | "install") => (
    <div>
      <h2 className="ob-h">{t(`mig.${key}.h`)}</h2>
      {migNav()}
    </div>
  );

  const browse = async () => {
    const p = await pickDirectory();
    if (p) setNewPath(p);
  };

  /**
   * 安裝（票 06）：整條移機流程裡**唯一會寫使用者現役目錄**的動作，不可逆。
   *
   * 落點不由這裡送——server 從已落檔的 config.json 讀並重算 plan（ADR-0002）；這一頁
   * 給的只有展開位置與專案路徑對應。失敗時退回 `idle` 讓使用者能再送一次：留在
   * 「安裝中」會變成一條沒有出口的死路。
   */
  const startInstall = async () => {
    if (port == null || bundle.probe.kind === "unknown") return;
    const gen = bundle.gen;
    const dest = bundle.probe.dest;
    setInstallRun({ gen, value: { kind: "running" } });
    setError(null);
    setNotice(null);
    try {
      const outcome = await runInstall(port, dest, mapping);
      setInstallRun({
        gen,
        value: { kind: "done", results: outcome.results, staleTemps: outcome.stale_temps },
      });
      // 完成頁要的是「這次移機總共搬回了什麼」，所以**累積**而不是覆寫（Codex 票 08 R1 F1）。
      // `gen` 不同就從頭數——那是換了一包，上一包裝了什麼與這一包無關。
      setInstalledTally((cur) => {
        const same = cur.gen === gen;
        const keys = new Set(same ? cur.keys : []);
        for (const r of outcome.results) {
          if (r.outcome === "installed") keys.add(`${r.account}/${r.rel_path}`);
        }
        // 一輪成功**不會**洗掉先前的「結果不明」：那一輪裝了什麼仍然沒人知道
        return { gen, keys: [...keys], unknown: same && cur.unknown };
      });
    } catch (e) {
      // 判別碼與例外原文只進 console（CLAUDE.md §4.6.13）——`HTTP 500` 對使用者沒有意義
      console.error("[onboarding] 移機安裝失敗", e);
      // **失敗有兩種，文案不能混**（Codex 票 06 R1）：後端明確回了判別碼＝請求在動手
      // 之前就被擋下（落點還沒落檔、來源不是備份包、journal 開不起來——全在寫入前），
      // 那時可以斷言什麼都沒發生。**拿不到判別碼**（連線斷、回應遺失、非合約 500）就
      // **不知道寫到哪裡了**：後端可能已經完整跑完，只是答案沒回來。此時說「安裝沒能
      // 完成」是在斷言一件我們不知道的事。
      const refused = e instanceof RestoreError && e.code !== null;
      setError(t(refused ? "mig.install.errors.installFailed"
                         : "mig.install.errors.installUnknown"));
      // 兩種都退回可再送：重跑是安全的（no-clobber 不覆蓋、journal 認得前一輪發布的
      // node），而不讓重送才是真的死路。**已經寫進去的東西會在重跑的結果裡顯示成
      // 「跳過」**——那也是使用者唯一能拿到的「東西確實在那裡」的證據
      setInstallRun({ gen, value: { kind: "idle" } });
      if (!refused) {
        // 結果不明的那一輪：重試會把它裝過的東西回報成 `skipped`，累積器看不到
        setInstalledTally((cur) => (cur.gen === gen
          ? { ...cur, unknown: true } : { gen, keys: [], unknown: true }));
      }
    }
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
                  onSaved={async (confirmed, reused) => {
                    await loadConfig();
                    // **對帳**（Codex 票 03 R4 F1）：後端回 409 時只證明「有一份 config」，
                    // 不證明它是這次建立的。後續 install-plan／install 直接從這份 config 取
                    // 目的地——沿用一份無關的設定等於把備份內容寫進使用者沒確認過的現役
                    // 目錄。讀回來的落點必須逐一等於剛才確認的那組，否則不放行。
                    const cfg = useAppStore.getState().config;
                    const live = cfg?.accounts ?? {};
                    const same =
                      Object.keys(live).length === confirmed.accounts.length
                      && confirmed.accounts.every(
                        (a) => live[a.key]?.config_dir === a.config_dir);
                    if (!same) {
                      throw Object.assign(new Error("config mismatch"),
                                          { code: "config_mismatch" });
                    }
                    setConfigCreated(true);
                    // 沿用既有設定檔（409）時 config 裡的東西是使用者原本就有的，
                    // **不是**這個備份包帶回來的（Codex 票 09 R1 F2）
                    setAdoptedFrom({ gen: bundle.gen, value: !reused });
                  }}
                />
                {/* 從備份包帶回的 Fledge 自身設定（票 09／增補 spec 缺口 5）。這三個值
                    一直都在包裡（`backup-claude.sh` 打包整份 `~/.fledge/config.json`），
                    只是移機路徑以前不讀它，於是新機的訂閱、工作根目錄、知識庫根目錄
                    全是空的而且**沒有任何一頁讓使用者發現**。

                    **不能綁 `configCreated`**（Codex 票 09 R1 F2）：它的初值是
                    `config?.is_first_run !== true`，對「這台機器本來就有設定檔」與
                    `config === null` 都是 true——摘要掛上去就會把使用者**原本就有的**
                    設定冒充成這個備份包帶回來的。要綁的是「這一輪真的建立了新設定檔
                    且已讀回」，那個事實只有 `TargetsCard` 知道（409＝沿用既有的）。

                    帶回哪些由後端在 `adopt-config` 裡決定（舊機的路徑在新機不存在就
                    不帶回），前端只讀落檔後的 config——自己從包裡推會變成第二份判準。 */}
                {adoptedFromBundle && (
                  <>
                    <dl className="ob-sum">
                      <dt>{t("mig.targets.adopted.subscriptions")}</dt>
                      <dd>{t("mig.targets.adopted.count",
                             { count: config?.subscriptions?.length ?? 0 })}</dd>
                      <dt>{t("mig.targets.adopted.roots")}</dt>
                      <dd>{t("mig.targets.adopted.count",
                             { count: config?.roots?.length ?? 0 })}</dd>
                      <dt>{t("mig.targets.adopted.kms")}</dt>
                      <dd>{config?.kms_root || t("mig.targets.adopted.kmsNone")}</dd>
                    </dl>
                    <p className="ob-note">{t("mig.targets.adopted.note")}</p>
                  </>
                )}
                {migNav(!configCreated)}
              </div>
            )
          )}
          {/* 專案路徑對應（票 04）：純收集，不落檔也不擋——留空即照搬（`/resume` 列不出來，
              文案講明）。包資訊還是 unknown 就沒有展開位置可用，退回空殼 */}
          {step === "paths" && (
            bundle.probe.kind === "unknown" ? migShell("paths") : (
              <div>
                <PathsCard
                  port={port}
                  dest={bundle.probe.dest}
                  projectCount={bundle.probe.info.project_count}
                  sourceGen={bundle.gen}
                  mapping={mapping}
                  onMapping={setMapping}
                  onStatus={(value) => setPathsStatus({ gen: bundle.gen, value })}
                />
                {/* 清單讀不出來就擋住（Codex 票 04 R1 F3）：使用者在看不到任何專案、
                    也沒有任何對應的情況下往下走，install 會把所有歷史原樣搬過去、
                    `/resume` 全部列不出來——那**不是**他選的「留空即照搬」。
                    包裡本來就沒有專案時不擋（`project_count` 為 0 沒有東西要對應）。 */}
                {migNav(bundle.probe.info.project_count > 0
                  && !(pathsStatus.gen === bundle.gen && pathsStatus.value === "loaded"))}
              </div>
            )
          )}
          {/* 安裝預覽（票 05）＋執行與結果（票 06）。預覽是不可逆操作前的最後一道人工
              確認，這一頁在按下安裝之前不寫任何東西；算不出預覽就按不下去（票 04 R1 F3）。
              裝完之後預覽由結果報告取代，主按鈕才變成「下一步」——**安裝只做一次**。 */}
          {step === "install" && (
            bundle.probe.kind === "unknown" ? migShell("install") : (
              <div>
                {run.kind === "done" ? (
                  <InstallResultCard results={run.results} staleTemps={run.staleTemps}
                                     onRetry={startInstall} />
                ) : (
                  <InstallPreviewCard
                    port={port}
                    dest={bundle.probe.dest}
                    sourceGen={bundle.gen}
                    mapping={mapping}
                    onStatus={(value) => setPreviewStatus({ gen: bundle.gen, value })}
                  />
                )}
                {run.kind === "running" && (
                  <p className="ob-note">{t("mig.install.runNote")}</p>
                )}
                <div className="ob-actions">
                  {/* 寫入進行中不可離開：換頁會讓使用者以為安裝可以中止（它不能）。
                      裝完之後放行回頭——結果綁著這一包留著，回上一頁不會讓它重裝 */}
                  <button
                    onClick={prev}
                    disabled={run.kind === "running"}
                    className="ob-btn-ghost"
                  >{t("common.prev")}</button>
                  {run.kind === "done" ? (
                    <button onClick={next} className="ob-btn">{t("common.next")}</button>
                  ) : (
                    <button
                      onClick={startInstall}
                      disabled={run.kind === "running" || !previewReady}
                      className="ob-btn"
                    >{run.kind === "running"
                      ? t("mig.install.running") : t("mig.install.run")}</button>
                  )}
                </div>
              </div>
            )
          )}
          {/* ── 修復連結（票 08）：備份包存的是連結**本身**而不是它指向的東西，搬回新機
                 之後那些連結還指著舊機器的絕對路徑。與設定頁的還原卡共用 `RepairCard`
                 ——誰是 source、要送哪些 entry、斷鏈怎麼數，兩處各寫一遍必然漂移。 ── */}
          {step === "repair" && (
            <div>
              <h2 className="ob-h">{t("mig.repair.h")}</h2>
              <p className="ob-sub">{t("mig.repair.sub")}</p>
              <RepairCard port={port} accounts={config?.accounts ?? {}} />
              <p className="ob-note">{t("mig.repair.scope")}</p>
              {migNav()}
            </div>
          )}

          {/* ── 環境偵測（票 23）：標題、清單與導覽都在卡片內，重新檢查與下一步同列 ── */}
          {step === "env" && <EnvCard port={port} onPrev={prev} onNext={next} />}

          {/* ── 登入（票 25）：每個帳號一張卡 + Codex 一張，導覽在卡片內 ── */}
          {/* 移機分支多一段說明（票 08，上游 spec §9 第 5 條）：**憑證刻意不在備份包裡**，
              所以這一步不能省。不寫的話使用者會以為「都搬回來了怎麼還要登入」，進而懷疑
              前面幾步是不是沒做成。文案放這裡而不是改 `LoginCard`——那張卡兩條路共用，
              為了一段文案給它一個 mode 開關並不划算。 */}
          {step === "login" && mode === "restore" && (
            <p className="ob-note">{t("mig.login.why")}</p>
          )}
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
          {/* 完成頁的總結**依 mode 分流**（票 16 第 2 項）：全新設定的成果是「掃描到 N 個
              專案」，移機的成果是「搬了 N 項資產」。移機沿用前者會全是 0——那些數字數的是
              `roots`／掃描結果，而移機的落檔走 `adopt-config`，真機驗收時完成頁對著剛裝好的
              6 項資產說「0 個專案、0 個根目錄、0 個帳號」。**即使票 09 讓 roots 有了值，
              「掃描到幾個專案」對移機仍是錯的框架**，所以改的是框架不是數字來源。 */}
          {step === "done" && (
            <div className="ob-step-center">
              <h2 className="ob-h">{t("done.h")}</h2>
              <p className="ob-summary">
                {mode === "restore" ? (
                  tally.unknown ? t("done.migSummaryUnknown") : (
                    <Trans
                      t={t}
                      i18nKey="done.migSummary"
                      values={{ installed: installedCount, accounts: accountKeys.length }}
                    />
                  )
                ) : (
                  <Trans
                    t={t}
                    i18nKey="done.summary"
                    values={{ projects: totalProjects, roots: shownRoots.length, accounts: distinctAccounts }}
                  />
                )}
              </p>
              <p className="ob-sub">{mode === "restore" ? t("done.migHint") : t("done.hint")}</p>
              {/* 上游 spec §9 第 3 條要寫進 UI：`.claude.json` 刻意不搬（它混著真資產、機器
                  身分與快取），所以舊機的權限清單與 MCP 設定要重新累積。這件事只有移機的人
                  會遇到，而且不講的話會被當成 bug。 */}
              {mode === "restore" && <p className="ob-note">{t("done.migCaveats")}</p>}
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

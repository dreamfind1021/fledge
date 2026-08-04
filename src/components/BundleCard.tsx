import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  restorePlanForPath,
  fetchBundleInfo,
  type BundleInfo,
  type RestorePlan,
} from "../lib/sidecar";
import { pickFile, pickDirectory } from "../lib/dialog";
import { useCardSession } from "../lib/useCardSession";
import { CardTerminal } from "./CardTerminal";

/**
 * 備份包在精靈裡的三態（票 01 實作階段 R1 定的建模）。
 *
 * 這是**序列本身的輸入**：`paths` 頁在包裡沒有專案歷史時整頁不出現，而那是非同步得知的。
 * `unknown` 必須與 `absent` 分開——前者是「還不知道」（`wizardSteps` 收 `undefined`、先留著
 * `paths` 頁），後者是「問過了，確實沒有」（收 `false`、整頁拿掉）。混成一個布林的話，
 * 「還沒問到」會被當成「沒有專案」，使用者會在摘要回來的瞬間看到序列縮短。
 */
export type BundleProbe =
  | { kind: "unknown" }
  | { kind: "present"; info: BundleInfo; dest: string }
  | { kind: "absent"; info: BundleInfo; dest: string };

/**
 * 備份包頁的**完整**選擇狀態。三者一組、住在精靈而不是卡片裡。
 *
 * 為什麼不能只把 `probe` 提上去（Codex 票 02 R1 F2）：選的是哪一包、解到哪裡如果留在
 * 卡片內部，卡片一卸載（回歡迎頁、或只是走到下一頁再回來）那些就沒了，`probe` 卻還在
 * ——於是一張「還沒選任何包」的卡片會顯示上一包的摘要，而且下一步是啟用的。三者同生
 * 共死，畫面上的摘要才恆等於「目前選的這一包、解到這個位置」。
 */
export interface BundleSelection {
  /**
   * 每次選擇變動就遞增：換包、換展開位置、重新展開、sidecar 換 port。
   *
   * 所有非同步回應（算位置、讀摘要、PTY 結束）落地前都要核對它。少了這道，舊 PTY 在
   * 換包之後才 EOF 會對**新包的位置**讀摘要（而新包還沒展開），前一包在路上的摘要請求
   * 也會蓋掉新的一輪（Codex 票 02 R1 F1）。
   */
  gen: number;
  bundlePath: string | null;
  plan: RestorePlan | null;
  probe: BundleProbe;
}

export const EMPTY_BUNDLE_SELECTION: BundleSelection = {
  gen: 0, bundlePath: null, plan: null, probe: { kind: "unknown" },
};

/** 後端判別碼 → catalog key。**顯式表**（比照 `RestoreCard`）：動態組 key 會讓沒見過的
 *  判別碼變成畫面上的 i18n key 原文，未知碼一律退回通用訊息（CLAUDE.md §4.6.13）。
 *  文案取自 `restore` namespace——路徑模式的每個判別碼在還原卡已經有說法，各寫一份必然漂移。 */
const CODE_KEY: Record<string, string> = {
  bundle_source_ambiguous: "restore:errors.bundle_source_ambiguous",
  bundle_required: "restore:errors.bundle_required",
  bundle_path_invalid: "restore:errors.bundle_path_invalid",
  bundle_not_found: "restore:errors.bundle_not_found",
  bundle_not_a_file: "restore:errors.bundle_not_a_file",
  bundle_unreadable: "restore:errors.bundle_unreadable",
  dest_invalid: "restore:errors.dest_invalid",
  dest_required: "restore:errors.dest_required",
  source_not_a_bundle: "restore:errors.source_not_a_bundle",
};

/** 展開位置不能用的原因，與還原卡同一批說法（`restore` namespace）。 */
const DEST_KEY: Record<string, string> = {
  is_root: "restore:dest.is_root",
  is_home: "restore:dest.is_home",
  inside_source: "restore:dest.inside_source",
  not_empty: "restore:dest.not_empty",
  not_dir: "restore:dest.not_dir",
  denied: "restore:dest.denied",
};

interface BundleCardProps {
  port: number | null;
  selection: BundleSelection;
  onSelection: (selection: BundleSelection) => void;
}

/**
 * 移機精靈的第一頁：挑一份備份包、看它會展開到哪裡、看著它展開，然後確認「這是不是我要的
 * 那一包」。全程不動現役資料——展開的目的地是一個全新目錄，後端 `dest_status` 先擋掉根目錄／
 * 家目錄／現役資料裡面／非空等位置。
 *
 * 備份包**用系統檔案選擇器挑**，走後端的路徑模式（增補 spec §2.7）：新機器的包不可能在
 * `backup_dir` 裡，名字模式一律 `unknown_bundle`。選了檔案不等於信任內容——包裡的 manifest
 * 一律是不可信輸入，形狀驗證發生在展開之後的 `bundle-info`。
 */
export function BundleCard({ port, selection, onSelection }: BundleCardProps) {
  const { t } = useTranslation(["onboarding", "restore"]);
  const { gen, bundlePath, plan, probe } = selection;
  const [planError, setPlanError] = useState<string | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  // 每一輪選擇的身分。**render body 同步指派**（比照 useCardSession 的 portRef）：props
  // 的更新要等 re-render，而作廢必須在按下去的當下就生效，否則同一個 tick 內回來的舊回應
  // 仍會通過核對。
  const genRef = useRef(gen);
  genRef.current = gen;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const portRef = useRef(port);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
    };
  }, []);

  /** 讓在途的每一個回應作廢，並回傳新的一輪身分。
   *
   * **同步推進 `selectionRef` 而不只是 `genRef`**（Codex 票 02 R3）：`onSelection` 要等父層
   * re-render 才回灌 props，在那之前 `selectionRef.current` 還是舊的一份。StrictMode 會把
   * effect 跑成 setup→cleanup→setup，第二次 setup 若讀到尚未回灌的舊 probe，就會算出**同一個**
   * gen 再發一次請求——兩份回應共用同一個 gen，`readInfo` 的 latest-wins 分不出先後，誰後到
   * 誰說了算。同步寫回去之後，replay 看到的 probe 已是 `unknown`，重驗那個 effect 直接跳過。 */
  const bump = useCallback((next: Partial<BundleSelection> = {}) => {
    const cur = selectionRef.current;
    const nextSelection: BundleSelection = {
      ...cur, probe: { kind: "unknown" }, ...next, gen: cur.gen + 1,
    };
    selectionRef.current = nextSelection;
    genRef.current = nextSelection.gen;
    onSelection(nextSelection);
    return nextSelection.gen;
  }, [onSelection]);

  // sidecar 換 port＝換了一個後端：在途的摘要請求是對舊 sidecar 發的，不該落地
  // （`useCardSession` 只負責清掉 session 本身）
  useEffect(() => {
    if (portRef.current === port) return;   // 首次 mount 只是把基準設好
    portRef.current = port;
    bump();
  }, [port, bump]);

  const {
    running, starting, error: sessionError, setError: setSessionError, start,
  } = useCardSession<{ gen: number; dest: string }>(port);
  // `onEnded` 是掛在終端機上的 callback，觸發時要問「是哪一個 PTY 結束了」——讀 ref 而不是
  // 閉包捕獲的 `running`，否則拿到的是掛載當下那一份
  const runningRef = useRef(running);
  runningRef.current = running;

  const mapCode = useCallback(
    (code: string | null) => (code !== null && CODE_KEY[code] ? t(CODE_KEY[code]) : null),
    [t],
  );

  /** 算「這一包會解到哪裡、那個位置能不能用」。`dest` 未給＝用後端算的預設位置。
   *  `myGen` 是發出這一次請求時的選擇身分，回應落地前要它還是最新的那一輪。 */
  const loadPlan = useCallback(
    async (myGen: number, path: string, dest?: string) => {
      if (port == null) return;
      setPlanError(null);
      try {
        const next = await restorePlanForPath(port, path, dest);
        if (!mounted.current || genRef.current !== myGen) return;
        onSelection({ gen: myGen, bundlePath: path, plan: next, probe: { kind: "unknown" } });
      } catch (e) {
        // 例外原文只進 console：判別碼與 `String(e)` 都不得出現在畫面上（CLAUDE.md §4.6.13）
        console.error("[BundleCard] 取得展開位置失敗", e);
        if (!mounted.current || genRef.current !== myGen) return;
        onSelection({ gen: myGen, bundlePath: path, plan: null, probe: { kind: "unknown" } });
        setPlanError(mapCode((e as { code?: string | null }).code ?? null)
          ?? t("restore:errors.planFailed"));
      }
    },
    [port, onSelection, mapCode, t],
  );

  const onPick = useCallback(async () => {
    const picked = await pickFile(t("mig.bundle.filter"));
    if (picked === null) return;
    // 換包＝這一包的內容還沒問過。**先整組換掉再算位置**：舊摘要停在畫面上會讓使用者拿
    // 前一包的內容去確認新的一包，而 `paths` 頁的去留也還綁在舊答案上。
    setInfoError(null);
    setSessionError(null);
    const myGen = bump({ bundlePath: picked, plan: null });
    await loadPlan(myGen, picked);
  }, [bump, loadPlan, setSessionError, t]);

  const onChangeDest = useCallback(async () => {
    const path = selectionRef.current.bundlePath;
    if (path === null) return;
    const dir = await pickDirectory();
    if (dir === null) return;
    // 換位置同樣作廢在途的一切：先前那次展開解到的是**別的**目錄
    const myGen = bump({ plan: null });
    await loadPlan(myGen, path, dir);
  }, [bump, loadPlan]);

  const onExpand = useCallback(async () => {
    // 同一條不變式在 handler 裡再驗一次：按鈕的 disabled 擋不住程式化呼叫，而送錯的後果是
    // 內容被解到一個沒被檢查過的位置（比照 RestoreCard.onRun）。
    const cur = selectionRef.current;
    if (cur.bundlePath === null || cur.plan === null || cur.plan.dest_status !== "ok") return;
    setInfoError(null);
    const myGen = bump();              // 重新展開＝先前那次的答案與在途回應全部作廢
    await start({
      cardId: "bundle",
      // 前端永不送命令字串（沿用 kind=install 的 allowlist 不變式）。path 傳空字串是因為
      // 展開不屬於任何專案，後端固定跑在 home。
      options: {
        path: "", kind: "restore",
        restoreBundlePath: cur.bundlePath, restoreDest: cur.plan.dest,
      },
      // **這個 PTY 展開的是哪一包、解到哪裡**——EOF 時要用它，不能用「當下的 plan」：
      // 使用者可能已經換了包，而新的那一包根本還沒展開（Codex 票 02 R1 F1）
      meta: { gen: myGen, dest: cur.plan.dest },
      mapError: mapCode,
      fallbackError: () => t("mig.bundle.errors.expandFailed"),
    });
  }, [bump, start, mapCode, t]);

  /** 讀展開目錄的內容並回報。`myGen` 是發出時的選擇身分，回應落地前要它還是最新那一輪。 */
  const readInfo = useCallback(async (myGen: number, dest: string) => {
    if (port == null) return;
    setInfoError(null);
    try {
      const info = await fetchBundleInfo(port, dest);
      if (!mounted.current || genRef.current !== myGen) return;
      // 有沒有專案歷史決定 `paths` 頁的去留，所以這裡就分好 present／absent，不讓上層再判一次
      onSelection({
        ...selectionRef.current,
        probe: { kind: info.project_count > 0 ? "present" : "absent", info, dest },
      });
    } catch (e) {
      console.error("[BundleCard] 讀取備份包內容失敗", e);
      if (!mounted.current || genRef.current !== myGen) return;
      setInfoError(mapCode((e as { code?: string | null }).code ?? null)
        ?? t("mig.bundle.errors.infoFailed"));
    }
  }, [port, onSelection, mapCode, t]);

  /** PTY 結束才去讀這一包的內容——展開還沒完成就問，讀到的是一個半滿的目錄。 */
  const onEnded = useCallback(async () => {
    const live = runningRef.current;
    if (live === null) return;
    const { gen: myGen, dest } = live.meta;
    // 這是**哪一輪**的展開結束了。不是最新那一輪就整個丟掉：使用者已經換包或換了位置，
    // 拿它的結果去讀摘要等於對一個沒展開過的目錄問內容。
    if (genRef.current !== myGen) return;
    await readInfo(myGen, dest);
  }, [readInfo]);

  // 回到這一頁＝重新確認這一包還在（Codex 票 02 R2）。**卡片卸載期間發生的事它看不見**：
  // 展開目錄可能被刪或被換、sidecar 可能換了 port（重新掛載時 `portRef` 直接以新 port 初始化，
  // 上面那個 effect 會當成首次 mount 而不作廢）。保留選包與展開位置是對的——那一組沒有失效
  // 風險；但**包資訊必須重驗**，否則一份已失效的摘要就直接把導覽 gating 解開了。
  // `bump()` 先把它收回 `unknown`，重驗成功才重新放行。
  useEffect(() => {
    const cur = selectionRef.current;
    if (cur.probe.kind === "unknown" || cur.plan === null) return;
    const dest = cur.plan.dest;
    void readInfo(bump(), dest);
    // 只在掛載時跑一次：後續的變動各自有自己的入口（換包、換位置、重新展開、換 port）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const destMessage = plan !== null && plan.dest_status !== "ok"
    ? t(DEST_KEY[plan.dest_status] ?? "restore:errors.dest_invalid")
    : null;
  const info = probe.kind === "unknown" ? null : probe.info;

  return (
    <div>
      <h2 className="ob-h">{t("mig.bundle.h")}</h2>
      <p className="ob-sub">{t("mig.bundle.sub")}</p>

      <div className="ob-row">
        <button onClick={onPick} className="ob-btn-ghost" disabled={port == null || starting}>
          {t("mig.bundle.pick")}
        </button>
        {bundlePath !== null && <span className="ob-path">{bundlePath}</span>}
      </div>

      {plan !== null && (
        <div className="ob-row">
          <span className="ob-label">{t("mig.bundle.dest")}</span>
          <span className="ob-path">{plan.dest}</span>
          <button onClick={onChangeDest} className="ob-btn-ghost" disabled={starting}>
            {t("mig.bundle.changeDest")}
          </button>
        </div>
      )}

      {destMessage !== null && <p className="ob-warn">{destMessage}</p>}
      {(planError ?? sessionError ?? infoError) && (
        <p className="ob-error">{planError ?? sessionError ?? infoError}</p>
      )}

      {plan !== null && (
        <button
          onClick={onExpand}
          className="ob-btn"
          disabled={starting || plan.dest_status !== "ok"}
        >
          {starting ? t("mig.bundle.expanding")
            : info !== null ? t("mig.bundle.reexpand") : t("mig.bundle.expand")}
        </button>
      )}

      {running !== null && port != null && (
        <CardTerminal
          port={port}
          sessionId={running.sessionId}
          tabId={running.tabId}
          title={t("mig.bundle.expanding")}
          onEnded={onEnded}
        />
      )}

      {info !== null && (
        <dl className="ob-sum">
          <dt>{t("mig.bundle.sum.host")}</dt>
          <dd>{info.host || t("mig.bundle.sum.none")}</dd>
          <dt>{t("mig.bundle.sum.created")}</dt>
          <dd>{info.created || t("mig.bundle.sum.none")}</dd>
          <dt>{t("mig.bundle.sum.accounts")}</dt>
          <dd>{info.accounts.join(", ") || t("mig.bundle.sum.none")}</dd>
          <dt>{t("mig.bundle.sum.extra")}</dt>
          <dd>{info.extra.join(", ") || t("mig.bundle.sum.none")}</dd>
          <dt>{t("mig.bundle.sum.projects")}</dt>
          <dd>{t("mig.bundle.sum.projects_v", { count: info.project_count })}</dd>
        </dl>
      )}
      {info !== null && <p className="ob-note">{t("mig.bundle.sum.note")}</p>}
    </div>
  );
}

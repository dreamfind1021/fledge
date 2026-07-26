import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import {
  COMMON_CONFIG_ENTRIES,
  SetupError,
  checkDir,
  commonConfigApply,
  commonConfigPlan,
  type CommonConfigAction,
  type CommonConfigOpResult,
  type CommonConfigOperation,
  type CommonConfigOutcome,
  type CommonConfigPlan,
  type CommonConfigState,
} from "../lib/sidecar";

interface AccountInfo {
  config_dir: string;
  label: string;
}

interface CommonConfigCardProps {
  port: number | null;
  accounts: Record<string, AccountInfo>;
  onPrev: () => void;
  onNext: () => void;
}

// 狀態點與 chip 共用一組色調（demo 的視覺語彙：綠＝就緒、灰＝待辦、琥珀＝會動到既有東西）
type Tone = "ok" | "todo" | "warn";

interface Chip {
  key: string;
  tone: Tone;
}

// 後端 state → 現況文案。用 Record 窮舉而非 `cc.state.${state}` 樣板：後端新增一種狀態時
// 這裡編譯失敗，而不是靜默顯示成 key 原文（catalog key 沿用判別碼原名，spec-b4 §5 命名約定）。
const STATE_TEXT: Record<CommonConfigState, string> = {
  ok: "cc.state.ok",
  missing: "cc.state.missing",
  wrong_link: "cc.state.wrong_link",
  broken_link: "cc.state.broken_link",
  empty_dir: "cc.state.empty_dir",
  real_file: "cc.state.real_file",
  real_dir: "cc.state.real_dir",
  content_differs: "cc.state.content_differs",
  unexpected_type: "cc.state.unexpected_type",
  source_missing: "cc.state.source_missing",
  source_unsupported: "cc.state.source_unsupported",
};

// 動作 → chip。backup_and_* 的 needs_overwrite 必為真，故實際走 chipFor 的前置分支；
// 列在這裡只為讓表窮舉 action union（同上，後端加動作要編譯失敗）。
const ACTION_CHIP: Record<CommonConfigAction, Chip> = {
  skip: { key: "cc.ready", tone: "ok" },
  create_link: { key: "cc.willLink", tone: "todo" },
  copy: { key: "cc.willCopy", tone: "todo" },
  relink: { key: "cc.willRelink", tone: "warn" },
  backup_and_link: { key: "cc.keep", tone: "warn" },
  backup_and_copy: { key: "cc.keep", tone: "warn" },
};

const OUTCOME_TONE: Record<CommonConfigOutcome, Tone> = {
  created: "ok",
  relinked: "ok",
  copied: "ok",
  skipped: "todo",
  conflict: "warn",
  stale: "warn",
  failed: "warn",
};

/** 這一項會顯示成什麼 chip。順序有意義：破壞性項目先攔下來標「保留不動」，
 *  精靈根本不會授權它（送空 overwrite 清單）。 */
function chipFor(op: CommonConfigOperation): Chip {
  if (op.needs_overwrite) return { key: "cc.keep", tone: "warn" };
  // skip 有三種來源：ok（真的已就緒）、source_missing／source_unsupported（source 側缺項或
  // 不可共用）。後兩者顯示「已就緒」會讓使用者以為同步好了——那是騙人。
  if (op.action === "skip" && op.state !== "ok") return { key: "cc.unavailable", tone: "todo" };
  return ACTION_CHIP[op.action];
}

/** 精靈的共通設置頁：顯示每個共通項目前的狀態與將要執行的動作，套用只做**不會蓋掉任何東西**
 *  的操作。
 *
 * 兩件刻意為之的事：
 * - **apply 一律送空 `overwrite`**（spec-b4 定案 8）。會覆蓋既有內容的項目標「保留不動」並指
 *   向設定頁——首次引導的使用者最不清楚後果，逐項授權留給票 29 的設定頁版。
 * - **目錄不存在的帳號不列為 target**。`apply` 會 `mkdir` target dir，照送等於替只用一個帳號
 *   的使用者建出他沒要求的帳號目錄。全部都不存在時整張卡「不適用」。 */
export function CommonConfigCard({ port, accounts, onPrev, onNext }: CommonConfigCardProps) {
  const { t, i18n } = useTranslation("onboarding");
  const [plan, setPlan] = useState<CommonConfigPlan | null>(null);
  // null＝還沒判定；[]＝判定完沒有可用 target（不適用）
  const [targets, setTargets] = useState<string[] | null>(null);
  // 逐項結果連同它產生時的資料上下文一起存：上下文一變（換 sidecar／換帳號）就整批失效。
  // 用上下文判定而不是「這次 load 是不是 apply 觸發的」——`load` 的 deps 含 `t`，光是切換
  // 語言就會重建它，那時清掉剛套用的結果毫無道理（Codex R2 ③）
  const [results, setResults] =
    useState<{ ctx: string; map: Record<string, CommonConfigOpResult> } | null>(null);
  // 有候選帳號目錄「存在但不能用」（denied／not_dir）或探測本身失敗——與「還沒建立」不同，
  // 說成「不存在」是假話，兩者要分開的文案
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // latest-request-wins（同 EnvCard）：重啟 sidecar 換 port 會讓兩輪偵測重疊，
  // 晚到的舊回應照樣寫進 state 的話，畫面會退回上一輪結果或蓋上一條過期錯誤
  const reqId = useRef(0);
  const mounted = useRef(true);

  const accountKeys = Object.keys(accounts);
  // source＝實體檔持有者。取第一個登記帳號（預設 work=~/.claude，spec §6.3）——精靈不讓使用者
  // 挑 source：首次引導沒有足夠資訊做這個決定，要換由設定頁處理。
  const source = accountKeys[0] ?? null;
  const candidates = accountKeys.slice(1);
  // effect dep 用簽章而非 accounts 物件：父層每次 render 都給新引用（config?.accounts ?? {}）。
  // 只看 key 與 config_dir——label 改名不影響共通設置。用 JSON 而非自訂分隔符拼接：
  // macOS 路徑允許 `|` 與 `=`，手寫分隔符會讓兩組不同帳號拼出同一個簽章。
  const accountsSig = JSON.stringify(accountKeys.map((k) => [k, accounts[k].config_dir]));
  // 這一輪操作面對的**資料上下文**：換 sidecar（port）或換帳號就是換了一個世界，先前送出的
  // 請求結果不再屬於當前畫面。與 `reqId`（load-vs-load 的先後）是兩件事，**刻意不共用**——
  // 讓 apply 去推進 reqId 會作廢正在跑的合法 load，那個 load 的 `loading` 就沒人解除，
  // apply 再失敗就永久停用按鈕（Codex R2 ①，與票 25 R4 同一族）
  const ctx = JSON.stringify([port, source, accountsSig]);

  const describeError = useCallback(
    (e: unknown): string => {
      const code = e instanceof SetupError ? e.code : null;
      // catalog 就是判別碼文案的真值來源（key 直接用判別碼原名，spec-b4 §5 命名約定）——
      // 不另外維護一份「哪些碼有文案」的清單，漏補文案時自動退到通用訊息
      if (code != null && i18n.exists(`errors.${code}`, { ns: "onboarding" })) {
        return t(`errors.${code}`);
      }
      // 未映射的判別碼與連線錯誤都退到通用訊息；細節留在 console 供除錯
      console.warn("[common-config] 未映射的錯誤", e);
      return t("errors.common_config_failed");
    },
    [t, i18n],
  );

  /** 重新偵測。不碰 `results`——逐項結果的有效期綁在資料上下文（`ctx`）上，見上面的註解。 */
  const load = useCallback(async () => {
    if (port == null || source == null) return;
    const myId = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      let live: string[];
      try {
        const statuses = await Promise.all(
          candidates.map((key) => checkDir(port, accounts[key].config_dir)),
        );
        live = candidates.filter((_, i) => statuses[i] === "dir");
        // missing＝單純還沒有第二個帳號目錄；denied／not_dir＝存在但不能用。兩者都排除
        // （apply 會 mkdir），但只有前者能說「不存在，你只用一個帳號」
        if (reqId.current === myId) {
          setBlocked(statuses.some((s) => s !== "dir" && s !== "missing"));
        }
      } catch (e) {
        if (reqId.current !== myId) return;
        // 探測不到就當不適用：對「未確認存在」的目錄送 apply 會替使用者建出目錄
        setError(t("errors.check_dir_failed", { reason: String(e) }));
        setBlocked(true);
        setTargets([]);
        setPlan(null);
        return;
      }
      if (reqId.current !== myId) return;
      if (live.length === 0) {
        setTargets([]);
        setPlan(null);
        return;
      }
      const next = await commonConfigPlan(port, {
        source,
        targets: live,
        entries: COMMON_CONFIG_ENTRIES,
      });
      if (reqId.current !== myId) return;
      // targets 與 plan 一起換（同一批 setState 只重繪一次）：先設 targets 再等 plan 的話，
      // 這段往返期間畫面會是「新帳號分組配舊 plan」，新那一組空著（Codex R2 ④ 附帶）
      setTargets(live);
      setPlan(next);
    } catch (e) {
      if (reqId.current !== myId) return;
      setPlan(null);
      setError(describeError(e));
    } finally {
      if (reqId.current === myId) setLoading(false);
    }
    // accounts／candidates 的內容變化由 accountsSig 代表（父層每 render 換引用，直接列會無限重跑）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, source, accountsSig, t, describeError]);

  // apply 回來時要比對「畫面現在的上下文」，而它自己 closure 裡的 `ctx` 是送出當下那一版，
  // 故只能靠 ref。在 commit 後才更新（不寫在 render body）——render 可能被 concurrent 中途
  // 丟棄，那時 ref 會指向使用者根本沒切換過去的那一版（Codex R2 ②）。apply 由使用者事件觸發、
  // 必定發生在 commit 之後，讀到的因此永遠是「畫面上那一版」。
  //
  // refresh 則直接用 apply 自己捕獲的 `load`：走到那一行代表 ctx 沒變過，也就是 port／source／
  // accounts 都還是同一組，該 closure 打的必然是同一個 sidecar。
  const ctxRef = useRef(ctx);
  useLayoutEffect(() => { ctxRef.current = ctx; }, [ctx]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
      reqId.current += 1;     // 使在途請求失效，卸載後不再 setState
    };
  }, []);

  const apply = async () => {
    if (port == null || source == null || targets == null || targets.length === 0) return;
    // 送出當下的資料上下文。回來時上下文若已改變，這批結果屬於上一個 sidecar／上一組帳號，
    // 寫進新畫面就是張冠李戴（Codex R1 High）——只有 mounted 擋不住，元件還在，變的是它面對的
    // 世界。**不推進 `reqId`**：那會作廢正在跑的合法 load（Codex R2 ①）。
    const myCtx = ctx;
    setBusy(true);
    setError(null);
    try {
      const list = await commonConfigApply(port, {
        source,
        targets,
        entries: COMMON_CONFIG_ENTRIES,
        // 精靈只做非破壞性操作（spec-b4 定案 8）：needs_overwrite 的項目後端會回 conflict 不動
        overwrite: [],
      });
      if (ctxRef.current !== myCtx) return;
      setResults({ ctx: myCtx, map: Object.fromEntries(list.map((r) => [`${r.account}/${r.entry}`, r])) });
      // 失敗項的判別碼不進畫面（逐項只顯示「處理失敗」），但要留在 console——
      // 沒有它使用者回報「失敗」時無從追查
      for (const r of list) {
        if (r.outcome === "failed") {
          console.warn(`[common-config] ${r.account}/${r.entry} 失敗：${r.error}`, r.backup_path);
        }
      }
      // 狀態一律即時偵測（spec-b4 §4）：套用後不能停在過時的 plan
      await load();
    } catch (e) {
      if (ctxRef.current !== myCtx) return;
      setError(describeError(e));
    } finally {
      // busy 一律解除（連作廢的那一輪也是）——不解除按鈕會永久停用到切頁重掛（票 25 R4）
      if (mounted.current) setBusy(false);
    }
  };

  const ops = plan?.operations ?? [];
  const hasConflict = ops.some((o) => o.needs_overwrite);
  // 精靈真的做得到的事＝非 skip 且不需授權。**conflict 項不算**：精靈永遠不授權它，
  // 算進來會讓「套用」永遠亮著、按了永遠回 conflict。反過來，套用後仍有可做的項目
  // （例如某項 failed）時按鈕自然留著，使用者可以再按一次重試——不用記「按過了」。
  const canApply = ops.some((o) => o.action !== "skip" && !o.needs_overwrite);
  // 「沒事可做」只在每一項都真的就緒時才說。source_missing／source_unsupported 也是 skip，
  // 但那不是「已經是你要的狀態」（那一列標的是「無法處理」）
  const allReady = ops.length > 0 && ops.every((o) => o.state === "ok");
  const isNotApplicable = targets != null && targets.length === 0;
  // 不適用卡要指出是哪個目錄卡住（candidates 全空＝只登記一個帳號，另一套文案）
  const unusableDirs = candidates
    .filter((k) => !(targets ?? []).includes(k))
    .map((k) => accounts[k].config_dir)
    .join(", ");
  const showApply = !isNotApplicable && plan != null && canApply;

  const renderRow = (op: CommonConfigOperation) => {
    // 上下文對不上的結果直接視為不存在（換 sidecar／換帳號後那批 outcome 已經沒有意義）
    const res = results?.ctx === ctx ? results.map[`${op.account}/${op.entry}`] : undefined;
    // 套用過的項目，chip 改顯示逐項結果（現況文字仍是重新偵測後的最新狀態）
    const chip: Chip = res
      ? { key: `results.${res.outcome}`, tone: OUTCOME_TONE[res.outcome] }
      : chipFor(op);
    return (
      <div key={`${op.account}/${op.entry}`} className="b4-item">
        <span className={`b4-dot ${chip.tone}`} />
        <span className="b4-item-name">{op.entry}</span>
        <span className="b4-item-meta">{t(STATE_TEXT[op.state], { source })}</span>
        <span className="b4-item-right">
          <span className={`b4-chip ${chip.tone}`}>{t(chip.key)}</span>
        </span>
      </div>
    );
  };

  return (
    <div>
      <h2 className="ob-h">{t("cc.h")}</h2>
      <p className="ob-sub">{t("cc.sub")}</p>

      {error && <div className="ob-error" role="alert">{error}</div>}
      {plan === null && !isNotApplicable && loading && <p className="ob-sub">{t("cc.checking")}</p>}

      {/* 不適用：次帳號目錄不存在／不可用，或根本只登記一個帳號。灰態卡＋說明日後會自動出現 */}
      {isNotApplicable && (
        <div className="b4-card is-na">
          <div className="b4-card-top">
            <span className="b4-dot na" />
            <div>
              <p className="b4-card-title">{t("cc.naTitle")}</p>
              <p className="b4-card-desc">
                {candidates.length === 0
                  ? <Trans t={t} i18nKey="cc.naDescSingle" />
                  : blocked
                    ? <Trans t={t} i18nKey="cc.naDescBlocked" values={{ path: unusableDirs }} />
                    : <Trans t={t} i18nKey="cc.naDesc" values={{ path: unusableDirs }} />}
              </p>
            </div>
          </div>
        </div>
      )}

      {plan != null && targets != null && targets.length > 0 && (
        <div className="b4-card">
          <div className="b4-card-top">
            <div>
              <p className="b4-card-title">
                <Trans t={t} i18nKey="cc.owner" values={{ source }} />
              </p>
              <p className="b4-card-desc">
                {t("cc.ownerDesc", { source, target: targets.join(", ") })}
              </p>
              {/* 實體檔到底在哪（後端 resolve 後的路徑）——demo 把它放在逐列，但那裡是單行
                  ellipsis 的窄欄，多帳號分組後會全被截掉；擺在卡頭只顯示一次且完整 */}
              <p className="b4-card-desc b4-mono">{plan.source_dir}</p>
            </div>
          </div>

          {/* 多帳號時逐帳號分組——同一個 entry 在不同帳號可以是不同狀態，混在一張清單裡看不出誰是誰 */}
          {targets.map((key) => (
            <div key={key} className="b4-group">
              {targets.length > 1 && <p className="b4-sec-h">{key}</p>}
              <div className="b4-list">
                {ops.filter((o) => o.account === key).map(renderRow)}
              </div>
            </div>
          ))}

          {/* 琥珀＝我們刻意不碰，不是錯誤。沒講清楚去哪裡處理，使用者只會看到一個沒解釋的 chip */}
          {hasConflict && (
            <p className="b4-hint b4-hint-warn">{t("cc.conflictHint", { source })}</p>
          )}
          <p className="b4-hint"><Trans t={t} i18nKey="cc.advHint" /></p>
          {allReady && <p className="b4-hint">{t("cc.nothingToDo")}</p>}
        </div>
      )}

      <div className="ob-actions">
        <button onClick={onPrev} className="ob-btn-ghost">{t("common.prev")}</button>
        <div className="ob-actions-right">
          {showApply && <button onClick={onNext} className="b4-skip">{t("common.skip")}</button>}
          {showApply ? (
            <button onClick={apply} disabled={busy || loading} className="ob-btn">
              {t("cc.apply")}
            </button>
          ) : (
            <button onClick={onNext} className="ob-btn">{t("common.next")}</button>
          )}
        </div>
      </div>
    </div>
  );
}

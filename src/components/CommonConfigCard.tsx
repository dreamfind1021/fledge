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
  // 精靈才有導覽列；設定頁版嵌在 modal 裡，兩個都不給（票 29）
  onPrev?: () => void;
  onNext?: () => void;
  /** 設定頁版：逐項授權覆蓋既有內容。精靈一律不給（spec-b4 定案 8），這是兩處掛載唯一的行為差異。 */
  allowOverwrite?: boolean;
  /** 回報「還沒就緒的項目數」給呼叫端（設定頁摺疊標題上的待處理數）。 */
  onPendingChange?: (count: number) => void;
}

// 備份檔名樣式（後端 `common_config._backup`：`<原名>.fledge-backup-<時間戳>`，撞名時再加 `-N`
// 序號免得吃掉舊備份）。授權前要讓使用者看得到「不是直接刪掉」，時間戳到套用當下才知道，
// 故顯示樣式而非實名；`[-N]` 那段照實列出，不然撞名時畫面說的檔名就是假的（Codex R1 #4）。
const BACKUP_PATTERN = "*.fledge-backup-YYYYMMDD-HHMMSS[-N]";

type AuthMap = Record<string, { account: string; entry: string }>;

/** 依最新一輪 plan 篩掉已經失效的逐項授權。
 *
 * **授權的有效期綁在「這一次的衝突」上**：某項一旦不再 `needs_overwrite`，那次勾選就結束了。
 * 少了這一步，「衝突 → 被外部修成一致 → 內容又被改成不同」的來回會讓畫面以**舊授權**預先打勾，
 * 使用者於是在沒有重新看過內容的情況下授權覆蓋（Codex R1 High）。
 *
 * 沒有變動時回傳**原本的引用**：`setAuthorized` 收到同一個物件時 React 會跳過重繪
 * （不是為了避免 effect 自我觸發——它的依賴是 `detected`，換物件也不會再觸發它一次）。 */
function pruneAuthorized(current: AuthMap, ops: CommonConfigOperation[] | undefined): AuthMap {
  const keys = Object.keys(current);
  if (keys.length === 0) return current;
  const kept = keys.filter((k) =>
    (ops ?? []).some((o) => `${o.account}/${o.entry}` === k && o.needs_overwrite),
  );
  if (kept.length === keys.length) return current;
  return Object.fromEntries(kept.map((k) => [k, current[k]]));
}

// 狀態點與 chip 共用一組色調（demo 的視覺語彙：綠＝就緒、灰＝待辦、琥珀＝會動到既有東西）
type Tone = "ok" | "todo" | "warn";

interface Chip {
  key: string;
  tone: Tone;
}

/** 一輪偵測的結果快照。`targets` 為空即「不適用」；`plan` 只在有 target 時才有值。 */
interface Detected {
  targets: string[];
  plan: CommonConfigPlan | null;
  // 有候選帳號目錄「存在但不能用」（denied／not_dir）或探測本身失敗——與「還沒建立」不同，
  // 說成「不存在」是假話，兩者要分開的文案
  blocked: boolean;
}

// 「做成了」那一類 outcome。它們與「最新偵測說這一項需要授權才能動」是互相矛盾的兩件事
// （apply 與重測之間有人動了那個檔案），chip 又長在現況欄——這時要說現況（Codex R3 ⑥）。
// 失敗類（conflict／stale／failed）不受影響：「剛才沒能處理」與「現在需要授權」並不衝突。
const SUCCEEDED: ReadonlySet<CommonConfigOutcome> = new Set<CommonConfigOutcome>([
  "created", "relinked", "copied", "skipped",
]);

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
export function CommonConfigCard({
  port,
  accounts,
  onPrev,
  onNext,
  allowOverwrite = false,
  onPendingChange,
}: CommonConfigCardProps) {
  const { t, i18n } = useTranslation("onboarding");
  // 一輪偵測的完整結果，**三個欄位一起換**。拆成獨立 state 時它們不是原子的：plan 失敗只清掉
  // plan、targets 還留著上一輪的 []，畫面就同時出現錯誤訊息與一張說「不適用」的卡（Codex R3 ⑤）
  const [detected, setDetected] = useState<Detected | null>(null);
  // 逐項結果連同它產生時的資料上下文一起存：上下文一變（換 sidecar／換帳號）就整批失效。
  // 用上下文判定而不是「這次 load 是不是 apply 觸發的」——`load` 的 deps 含 `t`，光是切換
  // 語言就會重建它，那時清掉剛套用的結果毫無道理（Codex R2 ③）
  const [results, setResults] =
    useState<{ ctx: string; map: Record<string, CommonConfigOpResult> } | null>(null);
  // 設定頁版的逐項授權。以 `(account, entry)` 為單位而非裸 entry 名（ADR-0002）：多 target 時
  // 裸名會讓「授權 A 帳號覆蓋 CLAUDE.md」連帶炸掉 B 帳號的。存 pair 物件而不是把 key 拆回來，
  // 免得帳號 key 或項目名含分隔字元時解析錯。
  const [authorized, setAuthorized] = useState<AuthMap>({});
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

  /** 重新偵測。不碰 `results`——逐項結果的有效期綁在資料上下文（`ctx`）上，見上面的註解。
   *  偵測結果一律整包寫進 `detected`，中途不留半套狀態。 */
  const load = useCallback(async () => {
    if (port == null || source == null) return;
    const myId = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      let live: string[];
      let blocked: boolean;
      try {
        const statuses = await Promise.all(
          candidates.map((key) => checkDir(port, accounts[key].config_dir)),
        );
        live = candidates.filter((_, i) => statuses[i] === "dir");
        // missing＝單純還沒有第二個帳號目錄；denied／not_dir＝存在但不能用。兩者都排除
        // （apply 會 mkdir），但只有前者能說「不存在，你只用一個帳號」
        blocked = statuses.some((s) => s !== "dir" && s !== "missing");
      } catch (e) {
        if (reqId.current !== myId) return;
        // 探測不到就當不適用：對「未確認存在」的目錄送 apply 會替使用者建出目錄。
        // 原文只進 console（spec-b4 §5）
        console.error("[onboarding] 帳號設定目錄探測失敗", e);
        setError(t("errors.check_dir_failed"));
        setDetected({ targets: [], plan: null, blocked: true });
        return;
      }
      if (reqId.current !== myId) return;
      if (live.length === 0) {
        setDetected({ targets: [], plan: null, blocked });
        return;
      }
      const next = await commonConfigPlan(port, {
        source,
        targets: live,
        entries: COMMON_CONFIG_ENTRIES,
      });
      if (reqId.current !== myId) return;
      setDetected({ targets: live, plan: next, blocked });
    } catch (e) {
      if (reqId.current !== myId) return;
      // 偵測沒完成就沒有可信的快照可顯示：留著上一輪的會變成「錯誤訊息配一張說不適用的卡」
      setDetected(null);
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
  useLayoutEffect(() => {
    ctxRef.current = ctx;
    // 離開一個上下文＝上一輪偵測到的東西與套用結果都不再描述畫面上的帳號，**兩個都要丟**。
    // 只丟 results 的話，port 過渡成 `null`（sidecar 重啟的中間態）時 `load()` 會在最開頭
    // 直接 return，那張舊卡就無限期留著、按鈕還看起來能按（Codex R4 ①）。
    setDetected(null);
    // 用 functional update 比對而非無條件清除：apply 剛寫進來的結果屬於當前 ctx，
    // 而 A→B→A（帳號改掉又改回來）時舊 outcome 不該復活（Codex R3 ②）
    setResults((r) => (r != null && r.ctx !== ctx ? null : r));
    // 授權是對「這一組帳號的這些項目」給的，換了上下文就不能沿用——破壞性操作尤其不能靠猜
    setAuthorized({});
  }, [ctx]);

  useEffect(() => { load(); }, [load]);

  // 每接受一輪新的偵測結果就重篩授權（手動重新檢查、apply 後的自動重測都算）。
  // ctx 沒變也要篩：同一組帳號裡，某項的衝突可能消失又出現，那是兩次不同的衝突。
  //
  // **必須是 layout effect**：passive effect 要等 paint 之後才跑，於是「新 plan 已經畫出來、
  // 套用鍵也解除停用」與「舊授權還沒篩掉」之間有一個真實窗口，那一瞬間按下套用就會送出舊授權
  // （Codex R2 High）。授權是破壞性操作的閘門，不能靠「使用者大概沒那麼快」。
  useLayoutEffect(() => {
    setAuthorized((a) => pruneAuthorized(a, detected?.plan?.operations));
  }, [detected]);

  useEffect(() => {
    mounted.current = true;   // StrictMode 會 mount→cleanup→再 mount，這裡要重設回來
    return () => {
      mounted.current = false;
      reqId.current += 1;     // 使在途請求失效，卸載後不再 setState
    };
  }, []);

  const apply = async () => {
    const targets = detected?.targets ?? [];
    if (port == null || source == null || targets.length === 0) return;
    // 送出當下的資料上下文。回來時上下文若已改變，這批結果屬於上一個 sidecar／上一組帳號，
    // 寫進新畫面就是張冠李戴（Codex R1 High）——只有 mounted 擋不住，元件還在，變的是它面對的
    // 世界。**不推進 `reqId`**：那會作廢正在跑的合法 load（Codex R2 ①）。
    const myCtx = ctx;
    setBusy(true);
    setError(null);
    // 精靈只做非破壞性操作（spec-b4 定案 8）：needs_overwrite 的項目後端會回 conflict 不動。
    // 設定頁版才送授權，且只送**最新一輪 plan 仍然需要授權**的項目——重新偵測後那一項可能
    // 已經不衝突了（別人改過），照送等於授權一個使用者沒看到的現況
    const overwrite = allowOverwrite
      ? Object.values(authorized).filter((a) =>
          ops.some((o) => o.account === a.account && o.entry === a.entry && o.needs_overwrite),
        )
      : [];
    try {
      const list = await commonConfigApply(port, {
        source,
        targets,
        entries: COMMON_CONFIG_ENTRIES,
        overwrite,
      });
      // 卸載也要擋：`ctxRef` 不會因為 unmount 而改變，只看它的話卸載後還會再發一次
      // checkDir／plan 請求（React 忽略 setState，但網路與檔案探測是真的跑了，Codex R3 ③）
      if (!mounted.current || ctxRef.current !== myCtx) return;
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
      if (!mounted.current || ctxRef.current !== myCtx) return;
      setError(describeError(e));
    } finally {
      // busy 一律解除（連作廢的那一輪也是）——不解除按鈕會永久停用到切頁重掛（票 25 R4）
      if (mounted.current) {
        setBusy(false);
        // **授權是一次性的**：送出去就用掉了，成功失敗都算，連線錯誤也算（請求可能已經到了後端）。
        // 失敗時留著勾選，等於讓下一次套用沿用「對舊內容的授權」去蓋掉新內容——`stale` 的定義
        // 正是「寫入前發現內容又變了」。要重試就重新勾一次。
        //
        // 但**只能清自己那個上下文的授權**：舊 ctx 的請求回來時，使用者可能已經換了帳號並在新
        // 上下文重新勾了同一個 pair，照刪會變成「勾了卻沒送出」（Codex R2 Medium）。
        if (ctxRef.current === myCtx && overwrite.length > 0) {
          setAuthorized((a) => {
            const next = { ...a };
            for (const o of overwrite) delete next[`${o.account}/${o.entry}`];
            return next;
          });
        }
      }
    }
  };

  const targets = detected?.targets ?? null;
  const plan = detected?.plan ?? null;
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
  // 這一輪沒被納入的候選帳號。全部被排除＝不適用卡；只排除一部分時**仍要講**——三個帳號裡
  // 有一個目錄不存在時，畫面只列另外那個，使用者會以為所有帳號都同步好了（Codex R4 ④）
  const excluded = candidates.filter((k) => !(targets ?? []).includes(k));
  // 不適用卡要指出是哪個目錄卡住（candidates 全空＝只登記一個帳號，另一套文案）
  const unusableDirs = excluded.map((k) => accounts[k].config_dir).join(", ");
  // 設定頁版的套用鍵一律在（那裡沒有「下一步」可以讓位，而且勾了授權才有得按會讓使用者
  // 以為卡片壞了）；精靈版維持「有事可做才亮」的既有規則
  const showApply = !isNotApplicable && plan != null && (allowOverwrite ? ops.length > 0 : canApply);
  const hasNav = onPrev != null && onNext != null;

  // 待處理＝還沒就緒的項目數（設定頁摺疊起來時，標題上的數字是唯一看得到的訊號）。
  // 不適用或還沒偵測完就是 0——寧可不顯示，也不掛一個猜出來的數字。
  const pendingCount = detected == null ? 0 : ops.filter((o) => o.state !== "ok").length;
  useEffect(() => {
    onPendingChange?.(pendingCount);
  }, [pendingCount, onPendingChange]);

  // 設定頁沒有換頁動作可以觸發重新偵測，卡片自己要有入口（精靈換頁時本來就會重測）。
  // 「不適用」的卡也要有——使用者補建了帳號目錄之後，不然只能關掉設定頁再開一次。
  const recheckButton = allowOverwrite ? (
    <span className="b4-card-actions">
      <button type="button" className="b4-btn-sm" onClick={load} disabled={loading || busy}>
        {t("env.recheck")}
      </button>
    </span>
  ) : null;

  const renderRow = (op: CommonConfigOperation) => {
    // 上下文對不上的結果直接視為不存在（換 sidecar／換帳號後那批 outcome 已經沒有意義）
    const prev = results?.ctx === ctx ? results.map[`${op.account}/${op.entry}`] : undefined;
    // 「上次做成了」配上「現在又需要授權」＝ apply 之後有別的東西動過這個檔案。chip 說現況。
    const res = prev != null && op.needs_overwrite && SUCCEEDED.has(prev.outcome) ? undefined : prev;
    // 套用過的項目，chip 改顯示逐項結果（現況文字仍是重新偵測後的最新狀態）
    const chip: Chip = res
      ? { key: `results.${res.outcome}`, tone: OUTCOME_TONE[res.outcome] }
      : chipFor(op);
    const key = `${op.account}/${op.entry}`;
    // 設定頁版：需授權的項目給勾選框——「保留不動」在這裡是可以推翻的，給一個沒有動作的 chip
    // 等於把唯一的出口藏起來。**結果 chip 與勾選框並存**：上一次沒做成（stale／failed）時仍然
    // 需要重新授權才能重試，只留結果 chip 會讓那一列再也回不到可授權狀態（授權用過即失效）。
    const askAuth = allowOverwrite && op.needs_overwrite;
    return (
      <div key={key} className="b4-item">
        <span className={`b4-dot ${chip.tone}`} />
        <span className="b4-item-name">{op.entry}</span>
        <span className="b4-item-meta">{t(STATE_TEXT[op.state], { source })}</span>
        <span className="b4-item-right">
          {/* 有上一輪結果就先說結果（做成了什麼／為什麼沒做成），沒有結果才說「將執行的動作」 */}
          {(res != null || !askAuth) && <span className={`b4-chip ${chip.tone}`}>{t(chip.key)}</span>}
          {askAuth && (
            <label className="st-check">
              <input
                type="checkbox"
                checked={authorized[key] != null}
                // 送出或重新偵測途中不給改：那時的勾選要嘛馬上被「送出即用掉」清掉、
                // 要嘛被下一輪 plan 篩掉，看起來像自己跳回去
                disabled={busy || loading}
                onChange={(e) =>
                  setAuthorized((a) => {
                    const next = { ...a };
                    if (e.target.checked) next[key] = { account: op.account, entry: op.entry };
                    else delete next[key];
                    return next;
                  })
                }
              />
              <span>{t("st.replaceWith", { source })}</span>
            </label>
          )}
        </span>
      </div>
    );
  };

  return (
    <div>
      {/* 頁標題只屬於精靈那一頁；設定頁版嵌在「開發環境」區裡，區塊自己已經有標題 */}
      {hasNav && (
        <>
          <h2 className="ob-h">{t("cc.h")}</h2>
          <p className="ob-sub">{t("cc.sub")}</p>
        </>
      )}

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
                  : detected?.blocked
                    ? <Trans t={t} i18nKey="cc.naDescBlocked" values={{ path: unusableDirs }} />
                    : <Trans t={t} i18nKey="cc.naDesc" values={{ path: unusableDirs }} />}
              </p>
            </div>
            {recheckButton}
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
            {recheckButton}
          </div>

          {/* 逐帳號分組——同一個 entry 在不同帳號可以是不同狀態，混在一張清單裡看不出誰是誰。
              標題帶上該帳號的 `config_dir`：卡頭只講得出 source 在哪，不寫 target 的話畫面上
              沒有任何地方能對出「這一組是哪個目錄」（票 29 驗收時使用者就問了這件事）。
              單一 target 也照顯示——只有一組的人同樣需要知道那一組是誰。 */}
          {targets.map((key) => (
            <div key={key} className="b4-group">
              <p className="b4-sec-h b4-group-head">
                {key}
                <span className="b4-group-path">{accounts[key]?.config_dir}</span>
              </p>
              <div className="b4-list">
                {ops.filter((o) => o.account === key).map(renderRow)}
              </div>
            </div>
          ))}

          {/* 有帳號被排除在這一輪之外時要講明白，否則畫面看起來像「全部帳號都處理了」 */}
          {excluded.length > 0 && (
            <p className="b4-hint b4-hint-warn">
              {t("cc.excludedHint", { accounts: excluded.join(", ") })}
            </p>
          )}

          {/* 琥珀＝我們刻意不碰，不是錯誤。精靈版沒講清楚去哪裡處理，使用者只會看到一個沒解釋的
              chip；設定頁版就是那個「哪裡」，改成說明勾選後會發生什麼（先改名備份，不是直接刪） */}
          {hasConflict && (
            <p className="b4-hint b4-hint-warn">
              {allowOverwrite
                ? <Trans t={t} i18nKey="st.backupHint" values={{ name: BACKUP_PATTERN }} />
                : t("cc.conflictHint", { source })}
            </p>
          )}
          <p className="b4-hint"><Trans t={t} i18nKey="cc.advHint" /></p>
          {allReady && <p className="b4-hint">{t("cc.nothingToDo")}</p>}
        </div>
      )}

      {/* 設定頁版沒有導覽列，套用鍵改掛在卡片下方 */}
      {!hasNav && showApply && (
        <div className="b4-card-foot">
          <button onClick={apply} disabled={busy || loading} className="b4-btn-sm primary">
            {t("st.apply")}
          </button>
        </div>
      )}

      {hasNav && (
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
      )}
    </div>
  );
}

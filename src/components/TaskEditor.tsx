import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { writeClipboard } from "../lib/clipboard";
import { TaskConflictError, TaskContentError, updateTaskContent, type TaskRow } from "../lib/sidecar";
import { clearDraft, loadDraft, saveDraft } from "../lib/taskDraft";
import { renderMarkdownLite } from "../lib/markdownLite";

type T = (k: string, o?: Record<string, unknown>) => string;

// §5.2.2 值域：送出前正規化並寫回畫面，使用者看到的就是會存進去的。
// JS 的 \s 與 Python 的空白判定不是同一個集合：\x1c-\x1f（檔案/群組/紀錄/單位分隔符）與
// \x85（NEL）在 Python 的 str.split() 裡算空白，JS 的 \s 不算——貼上網頁/PDF/Word 的段落
// 常帶這些字元，只用 \s 分隔會漏切，正規化後的標題到了 sidecar 的 _validate_content_domain
// 仍判 invalid_content（全鏈路審查抓到）
const normTitle = (s: string) => s.split(/[\s\x1c-\x1f\x85]+/).filter(Boolean).join(" ");
// 同一個落差在內文更嚴重：parser 用 Python 的 str.splitlines() 斷行，除了 \r\n／\r／\n，
// 還認 \v\f\x1c-\x1e\x85\u2028\u2029 ——JS 的 /\r\n?/ 完全不認得這些字元，貼上的段落
// 存下去後 sidecar 端 can_round_trip(new_raw) 會直接判 False（400 invalid_content），
// 使用者看到一個看不見、猜不到、按幾次都一樣失敗的錯誤（Codex 全鏈路審查 high）。
// 折成 \n 而不是拒絕：spec §5.2.2 的意圖是 UI 端正規化、sidecar 端只做防前端漏掉的回驗，
// 現在只有 sidecar 那層在擋，且用的是拒絕不是正規化，違反了這個分工
const normBody = (s: string) => s
  .replace(/\r\n?/g, "\n")
  .replace(/[\v\f\x1c-\x1e\x85\u2028\u2029]/g, "\n")
  .replace(/^\n+|\n+$/g, "");

const DEBOUNCE_MS = 600;

// 工具列只在游標位置插入字元（spec §6.3）。檔案內容永遠等於文字區裡看得到的那串字。
// 斜體與連結兩顆按鈕已拿掉（使用者驗收）：斜體是可用性判斷（個人待辦工具用不到），
// 連結是因為壞的——插入 `[選取](url)` 之後 `safeHref("url")` 解析不出協定，預覽永遠不會
// 出現連結，是 spec §6.3 明講要避免的「按了沒反應」。**這兩個只是拿掉工具列按鈕，不是拿掉
// markdown 能力**：既有票檔（手寫或 AI 透過 skill 寫的）可能已經含有 `*斜體*` 或
// `[文字](url)`，renderMarkdownLite 與其測試完全不動，兩種語法照樣要能正確渲染。
type Tool = { key: string; a11y: string; wrap?: [string, string]; linePrefix?: string; block?: string };
const TOOLS: Tool[] = [
  { key: "H", a11y: "a11y.toolbarHeading", linePrefix: "## " },
  { key: "B", a11y: "a11y.toolbarBold", wrap: ["**", "**"] },
  { key: "<>", a11y: "a11y.toolbarCode", wrap: ["`", "`"] },
  { key: "•", a11y: "a11y.toolbarList", linePrefix: "- " },
  { key: "❝", a11y: "a11y.toolbarQuote", linePrefix: "> " },
  { key: "```", a11y: "a11y.toolbarCodeBlock", block: "```" },
];

// wrap 工具在「沒有選取」時回傳游標該落在哪（review：使用者發現空選取按下去只會插入
// `****` 這種看得到、用不出來的字面符號，打字接在整段的最後面，格式完全沒套用）。
// linePrefix／block 刻意不回傳游標資訊——範圍只改 wrap，這兩類的游標行為同樣不完美但
// 使用者沒有提出，``` 這顆另有已知限制（行中插入產生的圍籬 renderMarkdownLite 認不得）
// 記在別處，不在這裡一併處理。
function applyTool(ta: HTMLTextAreaElement, tool: Tool): { value: string; caret?: [number, number] } {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  if (tool.wrap) {
    const [open, close] = tool.wrap;
    const value = v.slice(0, s) + open + v.slice(s, e) + close + v.slice(e);
    // 沒有選取：游標放在兩個記號中間，打字立刻是套了格式的內容，不必先選字再套用。
    // 有選取：游標放在整段（含右邊記號）之後，不維持選取——接著打字才會接在後面，
    // 不會覆蓋掉剛包好的字（這是判斷，不是唯一正解，見 task-10-report.md）
    const caret: [number, number] = s === e
      ? [s + open.length, s + open.length]
      : [s + open.length + (e - s) + close.length, s + open.length + (e - s) + close.length];
    return { value, caret };
  }
  if (tool.linePrefix) {
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    return { value: v.slice(0, ls) + tool.linePrefix + v.slice(ls) };
  }
  if (tool.block) {
    return { value: v.slice(0, s) + `${tool.block}\n` + v.slice(s, e) + `\n${tool.block}` + v.slice(e) };
  }
  return { value: v };
}

export function TaskEditor({ port, project, projectName, task, onSaved, onLeave, leaveRequest, t }: {
  port: number; project: string; projectName: string; task: TaskRow;
  onSaved: (updated: TaskRow) => void; onLeave: (reload: boolean) => void; leaveRequest?: number; t: T;
}) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  // 開始編輯那一版的 fingerprint（spec §7.2）。草稿還原時會換成草稿記的那版——
  // 送出的必須是「內容所基於的那版」，不是送出當下重抓的
  const [baseFp, setBaseFp] = useState(task.fingerprint);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState<{ key: string; reason?: string } | null>(null);
  // 「已複製」是獨立旗標，不能塞進 notice：notice 同時是 409／儲存失敗訊息的容器，
  // copyMine 若用 setNotice({key:"list.copied"}) 覆寫，會把它坐落的那個提示條（連同
  // 「捨棄我的版本，重新載入」）一起換掉——§7.5 的復原流程是「先複製、再捨棄重載」，
  // 復原流程的第二步就這樣消失了。這個 repo 對孤兒草稿（copiedDraft）與救援複製
  // （rescueCopied）已經各自這樣修過一次，這裡是第三次同一種形狀（review Important finding）
  const [copied, setCopied] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<"same" | "stale" | null>(null);
  // 草稿存不進去時是哪個動作觸發的：儲存 → 沒有強制路徑（§7.3 硬性前置條件），只給複製與繼續編輯／取消；
  // 離開 → 才有「仍要離開」的例外（K6：離開沒草稿頂多丟畫面上的字，儲存沒草稿可能寫壞票檔又救不回）
  const [unsavable, setUnsavable] = useState<"save" | "leave" | null>(null);
  // 草稿提示還沒被回答（接著改／還是要還原／丟棄草稿）時，能改動內容的控制項要鎖住（spec §7.6）。
  // 沒有這道鎖，使用者能在提示還沒選之前繼續打字：畫面顯示的是磁碟版本 A，但 600ms 後
  // scheduleDraft 會用 A 覆寫同一把 localStorage 鍵，草稿 B 就這樣被打字動作悄悄蓋掉——
  // 「只有明確存檔／丟棄才清除未存草稿」的保證因此被繞過（兩位獨立審查者都抓到）。
  // Save 尤其不能漏鎖：它送出前也會 flush 同一把鍵，留著等於換一條路徑蓋掉 B。
  // 返回／取消／預覽不鎖：離開路徑必須永遠可按（spec D8）——這裡安全，字都還沒打，dirty
  // 仍是 false，leave() 不會 flush；預覽只是切換顯示，不動內容。
  const locked = saving || draftPrompt != null;
  const debounce = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pendingDraft = useRef(loadDraft(project, task.name));
  // 最新的編輯狀態，給 unmount cleanup 用——cleanup 的 closure 是首次 render 的，讀不到最新 state
  const latest = useRef({ title, body, baseFp, dirty });
  latest.current = { title, body, baseFp, dirty };

  // closeTab() 直接從 store 移除分頁，不會經過 leave()（plan R2 F3）。unmount cleanup 無條件 abort，
  // 並 best-effort flush 草稿——同步的，失敗只能吞：已經在卸載了，沒有 UI 可顯示警告。
  // 正常離開路徑（leave）已經 flush 過，這裡再存一次是 idempotent 的，無害
  // 「捨棄我的版本」清掉草稿後，cleanup 不得再把它寫回（plan R3 F1）
  const skipFlush = useRef(false);
  useEffect(() => () => {
    abort.current?.abort();
    if (debounce.current != null) { window.clearTimeout(debounce.current); debounce.current = null; }   // 舊 timer 不得在卸載後覆寫新草稿
    const l = latest.current;
    if (l.dirty && !skipFlush.current) saveDraft(project, task.name, { title: l.title, body: l.body, fingerprint: l.baseFp });
  }, [project, task.name]);

  // 進來時有草稿 → 依 fingerprint 相同／不同給不同提示（spec §7.4），不自動動任何東西
  useEffect(() => {
    const d = pendingDraft.current;
    if (d) setDraftPrompt(d.fingerprint === task.fingerprint ? "same" : "stale");
  }, [task.fingerprint]);

  const cancelDebounce = () => { if (debounce.current != null) { window.clearTimeout(debounce.current); debounce.current = null; } };
  const scheduleDraft = (ti: string, bo: string) => {
    cancelDebounce();
    debounce.current = window.setTimeout(() => { saveDraft(project, task.name, { title: ti, body: bo, fingerprint: baseFp }); debounce.current = null; }, DEBOUNCE_MS);
  };
  // `disabled` 只擋得住點擊——受控輸入框在 disabled 時仍可能收到程式化的 change/input
  // （測試環境如此，不能排除某些自動化或輔助工具也如此），畫面上的鎖不是唯一防線。
  // early return 確保就算事件真的送達，locked 期間也不會動到 state 或排 debounce（two review findings）
  const onTitle = (v: string) => { if (locked) return; setTitle(v); setDirty(true); scheduleDraft(v, body); };
  const onBody = (v: string) => { if (locked) return; setBody(v); setDirty(true); scheduleDraft(title, v); };

  // §7.6：「送出期間整個編輯器鎖住，不會有新版本」是存檔 200 直接 clearDraft 的前提——
  // 這兩顆草稿按鈕若不鎖，使用者能在 A 送出途中還原成 B，A 的成功回應隨後無條件把 B
  // 清掉。下面的 `if (saving) return` 現在是 belt-and-braces：`locked`（下方）已經讓
  // Save 在 draftPrompt 還在時就按不下去，不可能再進到 isSaving 又同時看得到這兩顆按鈕，
  // 但拿掉判斷不會讓程式更簡單、留著也不花什麼，防的是資料遺失，故不因「現在摸不到」而拔掉
  const restoreDraft = () => {
    if (saving) return;
    const d = pendingDraft.current; if (!d) return;
    setTitle(d.title); setBody(d.body); setBaseFp(d.fingerprint); setDirty(true); setDraftPrompt(null);
  };
  const discardDraft = () => {
    if (saving) return;
    cancelDebounce(); clearDraft(project, task.name); pendingDraft.current = null; setDraftPrompt(null);
  };

  // 離開（spec §7.3）：先同步 flush 草稿——打字後 600ms 內按返回，最後那段還在 debounce 等待，
  // 直接走就丟了（plan R1 F2）。flush 失敗不靜默離開，給複製與「仍要離開」兩條路。
  // 沒改過就不 flush（dirty 為 false），避免把原始內容當草稿存進去。
  // flush 成功後 abort 在途請求，讓晚到的回應根本不到達；然後卸載
  // reload=true 只有「捨棄我的版本」會傳：父層要把清單進 loading、重讀完才能再操作（plan R2 F4）
  const forceLeave = (reload = false) => { abort.current?.abort(); onLeave(reload); };
  const leave = () => {
    cancelDebounce();
    if (dirty && !saveDraft(project, task.name, { title, body, fingerprint: baseFp })) {
      setCopied(false); setUnsavable("leave"); return;   // 新的提示上場，舊的「已複製」回饋作廢
    }
    forceLeave();
  };

  // 父層的導覽（點別張票、換專案、回所有專案）在編輯中一律先問這裡（spec §5.7）：
  // 走同一條 leave()——草稿寫成功才 onLeave，寫不進去就留在原畫面給「複製／仍要離開」。
  // 用 ref 拿最新的 leave：effect 只認 leaveRequest 的變化，closure 裡的 leave 會過期。
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  // 只處理「掛載之後」的增量：父層的計數只增不減，若掛載時就把非零值當請求，
  // 上一次編輯中導覽留下的值會讓下一個編輯器一掛上就立刻離開（Codex plan R1 high）
  const seenLeave = useRef(leaveRequest ?? 0);
  useEffect(() => {
    if (leaveRequest == null || leaveRequest === seenLeave.current) return;
    seenLeave.current = leaveRequest;
    leaveRef.current();
  }, [leaveRequest]);

  // §7.3 的固定順序：正規化 → 取消 pending → flush → 進 isSaving → PUT。
  // flush 失敗「不進 isSaving、不鎖、不發 PUT」是硬性前置條件，沒有強制路徑——
  // §7.3 允許的操作只列了「複製、繼續編輯、取消」，離開路徑才有「仍要離開」的例外（review high finding，
  // K6：寫入不是原子的，草稿留不住又寫壞票檔會同時發生、關掉編輯器後無法復原）
  const save = useCallback(() => {
    const ti = normTitle(title), bo = normBody(body);
    setTitle(ti); setBody(bo);
    setCopied(false);                                    // 新的儲存嘗試開始，舊的「已複製」回饋作廢
    if (!ti) { setNotice({ key: "list.titleRequired" }); return; }
    cancelDebounce();
    if (!saveDraft(project, task.name, { title: ti, body: bo, fingerprint: baseFp })) {
      setUnsavable("save"); return;                      // 不鎖、不發 PUT，沒有強制路徑
    }
    setUnsavable(null); setNotice(null); setSaving(true);
    const ac = new AbortController(); abort.current = ac;
    updateTaskContent(port, project, task.name, ti, bo, baseFp, ac.signal)
      .then((updated) => {
        if (ac.signal.aborted) return;                   // 晚到：不清草稿、不動狀態
        clearDraft(project, task.name);
        // 同步寫 ref，不能只靠 setDirty(false)：onSaved 常常讓父層在同一輪把編輯器卸載，
        // 卸載沒有下一次 render，cleanup 讀到的 latest.current 會是還沒同步前的 dirty:true，
        // 於是把剛存檔成功的內容當「未存」用舊 fingerprint 寫回一份幽靈草稿（review R1）
        latest.current = { ...latest.current, dirty: false };
        setDirty(false); setSaving(false); onSaved(updated);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setSaving(false);
        // 判別碼是封閉列舉（spec §8）：not_editable（票在你打開之後於外部被改壞，round-trip
        // 不過）／invalid_content（值域仍不符——理論上已被上面的正規化擋在送出前，但 sidecar
        // 是最後一道防線）各自有專屬文案；not_editable 與 write_failed 過去在畫面上長得
        // 一模一樣——一個是別人動了檔案，一個是磁碟在故障，使用者要做的事完全不同
        // （review Important finding）。
        // **CLAUDE.md §4.6.13 管的是任何內部字串，不是只有 400 那條**：write_failed／
        // invalid_target／null（5xx 或非 JSON body）／malformed response／網路錯誤，
        // 一律不得把 e.message 或 resp.status 塞進 t() 的插值——那條路徑上曾經只換了
        // 狀態碼、字面值照樣糊到使用者臉上，同一種違規換了個馬甲（whole-branch review
        // 二輪 finding）。沿用 useCardSession.ts:89-92 已經定案的作法：console.error
        // 留住診斷資訊給 devtools，畫面只給翻譯過的固定字串
        if (e instanceof TaskConflictError) { setNotice({ key: "list.conflictEditor" }); return; }
        if (e instanceof TaskContentError && e.code === "not_editable") {
          setNotice({ key: "list.saveFailedNotEditable" }); return;
        }
        if (e instanceof TaskContentError && e.code === "invalid_content") {
          setNotice({ key: "list.saveFailedInvalidContent" }); return;
        }
        console.error("updateTaskContent 失敗", e);
        if (e instanceof TaskContentError && e.code === "write_failed") {
          setNotice({ key: "list.saveFailedWriteFailed" }); return;   // 磁碟／檔案系統問題，不是使用者的錯
        }
        setNotice({ key: "list.saveFailedGeneric" });   // invalid_target／null／malformed response／其餘一律落這裡
      });
  }, [title, body, baseFp, port, project, task.name, onSaved]);

  const copyMine = () => writeClipboard(`# ${title}\n\n${body}`).then((ok) => { if (ok) setCopied(true); });
  // 「捨棄我的版本」：清草稿後直接走，**不經 leave()**——leave 會先 flush 草稿，跟「捨棄」矛盾
  // cancelDebounce 對稱於 discardDraft（:93）：少了它，若上一層哪天不再同步卸載，
  // 排隊中的 debounce 會在 600ms 後把剛丟棄的內容又寫回去（plan R3 F1 同一種坑）
  const discardAndReload = () => { cancelDebounce(); skipFlush.current = true; clearDraft(project, task.name); forceLeave(true); };

  const taRef = useRef<HTMLTextAreaElement>(null);
  // 受控 textarea：套用工具後游標要等 React 把新的 value 交回 DOM 才能定位，不能在
  // applyTool 當下直接設——那時候 DOM 還是舊值，設了也會被下一次 render 蓋掉。用 ref
  // 記「這次要落在哪」，layout effect 每次 render 後檢查一次，不需要為此多開一個 state
  const pendingCaret = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const c = pendingCaret.current;
    if (!c || !taRef.current) return;
    // 點工具列按鈕會把焦點從文字區移到按鈕上；沒有焦點的欄位不顯示游標，就算
    // selectionStart/End 設對了，使用者也看不到插入點在哪（使用者回報：「符號有出來，
    // 但游標消失了」）。focus() 要在 setSelectionRange 之前——這也代表鍵盤使用者
    // Tab 到工具列按鈕、按 Enter 之後，焦點會回到文字區：這是刻意的，工具列按鈕
    // 存在的目的就是讓你按完接著打字，不是留在按鈕上
    taRef.current.focus();
    taRef.current.setSelectionRange(c[0], c[1]);
    pendingCaret.current = null;
  });
  const tool = (tl: Tool) => {
    const ta = taRef.current; if (!ta) return;
    const { value, caret } = applyTool(ta, tl);
    pendingCaret.current = caret ?? null;
    onBody(value);
  };

  return (
    <div className="tasks-pane">
      <div className="full-head">
        <button className="full-back" onClick={leave}><ChevronLeft size={14} />{projectName}</button>
        <span className="full-num">{task.number ?? ""}</span>
      </div>
      {draftPrompt && (
        <div className={`tk-banner is-draft${draftPrompt === "stale" ? " is-stale" : ""}`}>
          <span className="btext">{t(draftPrompt === "same" ? "list.draftFound" : "list.draftStale")}</span>
          <span className="bacts">
            <button className="bbtn" disabled={saving} onClick={restoreDraft}>{t(draftPrompt === "same" ? "list.draftResume" : "list.draftRestoreAnyway")}</button>
            <button className="bbtn" disabled={saving} onClick={discardDraft}>{t("list.draftDiscard")}</button>
          </span>
        </div>
      )}
      {unsavable && (
        <div className="tk-banner is-conflict">
          {/* save 分支沒有「仍要儲存」可以回答「要繼續嗎」——那顆按鈕已經拿掉了，
              兩個分支各自的文案分開放（review Important finding：見 locale 檔） */}
          <span className="btext">{t(unsavable === "save" ? "list.draftUnsavableSave" : "list.draftUnsavable")}</span>
          {copied && <span className="btext">{t("list.copied")}</span>}
          <span className="bacts">
            <button className="bbtn" onClick={copyMine}>{t("list.copyMine")}</button>
            {unsavable === "leave" && <button className="bbtn" onClick={() => forceLeave()}>{t("list.leaveAnyway")}</button>}
          </span>
        </div>
      )}
      {notice && (
        <div className="tk-banner is-conflict">
          <span className="btext">{t(notice.key, notice.reason ? { reason: notice.reason } : undefined)}</span>
          {copied && <span className="btext">{t("list.copied")}</span>}
          {/* §7.3 的失敗表格：非 409 的每一種失敗都要有〔複製我的內容〕，titleRequired 除外——
              那是送出前的用戶端擋檢，內容還活在可編輯的欄位裡，不是「PUT 失敗、內容卡在記憶體裡
              拿不出來」的情境，不屬於這張表（review Important finding：這裡原本只有 409 有按鈕）*/}
          {notice.key !== "list.titleRequired" && (
            <span className="bacts">
              <button className="bbtn" onClick={copyMine}>{t("list.copyMine")}</button>
              {notice.key === "list.conflictEditor" && (
                <button className="bbtn" onClick={discardAndReload}>{t("list.discardAndReload")}</button>
              )}
            </span>
          )}
        </div>
      )}
      <div className="full-editor">
        <input className="ed-title" aria-label={t("list.editorTitle")} value={title} disabled={locked}
          onChange={(e) => onTitle(e.target.value)} />
        <div className="ed-bar" role="toolbar">
          {TOOLS.map((tl) => (
            <button key={tl.key} className="ed-btn" aria-label={t(tl.a11y)} title={t(tl.a11y)} disabled={locked || preview}
              onClick={() => tool(tl)}>{tl.key}</button>
          ))}
        </div>
        {preview
          ? <div className="ed-preview tk-md">{renderMarkdownLite(body)}</div>
          : <textarea ref={taRef} className="ed-area" aria-label={t("list.editorBody")} value={body} disabled={locked}
              onChange={(e) => onBody(e.target.value)} />}
        <div className="ed-foot">
          <span className={`ed-hint${dirty ? " is-dirty" : ""}`}>{saving ? t("list.saving") : dirty ? t("list.unsaved") : ""}</span>
          <span className="spacer" />
          {/* 按鈕文字要講「按下去會做什麼」，不是「現在是什麼模式」（使用者回報：
              預覽中這顆字還是寫「預覽」，點下去卻是回編輯，文字與動作相反） */}
          <button className="btn is-quiet" disabled={saving} onClick={() => setPreview((p) => !p)}>
            {t(preview ? "list.backToEdit" : "list.preview")}
          </button>
          <button className="btn is-quiet" disabled={saving} onClick={leave}>{t("list.cancel")}</button>
          <button className="btn is-primary" disabled={locked} onClick={() => save()}>{t("list.save")}</button>
        </div>
      </div>
    </div>
  );
}

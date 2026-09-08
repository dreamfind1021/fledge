import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { writeClipboard } from "../lib/clipboard";
import { TaskConflictError, updateTaskContent, type TaskRow } from "../lib/sidecar";
import { clearDraft, loadDraft, saveDraft } from "../lib/taskDraft";
import { renderMarkdownLite } from "../lib/markdownLite";

type T = (k: string, o?: Record<string, unknown>) => string;

// §5.2.2 值域：送出前正規化並寫回畫面，使用者看到的就是會存進去的
const normTitle = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const normBody = (s: string) => s.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");

const DEBOUNCE_MS = 600;

// 工具列只在游標位置插入字元（spec §6.3）。檔案內容永遠等於文字區裡看得到的那串字。
type Tool = { key: string; a11y: string; wrap?: [string, string]; linePrefix?: string; block?: string };
const TOOLS: Tool[] = [
  { key: "H", a11y: "a11y.toolbarHeading", linePrefix: "## " },
  { key: "B", a11y: "a11y.toolbarBold", wrap: ["**", "**"] },
  { key: "I", a11y: "a11y.toolbarItalic", wrap: ["*", "*"] },
  { key: "<>", a11y: "a11y.toolbarCode", wrap: ["`", "`"] },
  { key: "•", a11y: "a11y.toolbarList", linePrefix: "- " },
  { key: "❝", a11y: "a11y.toolbarQuote", linePrefix: "> " },
  { key: "```", a11y: "a11y.toolbarCodeBlock", block: "```" },
  { key: "🔗", a11y: "a11y.toolbarLink", wrap: ["[", "](url)"] },
];

function applyTool(ta: HTMLTextAreaElement, tool: Tool): string {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  if (tool.wrap) return v.slice(0, s) + tool.wrap[0] + v.slice(s, e) + tool.wrap[1] + v.slice(e);
  if (tool.linePrefix) {
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    return v.slice(0, ls) + tool.linePrefix + v.slice(ls);
  }
  if (tool.block) return v.slice(0, s) + `${tool.block}\n` + v.slice(s, e) + `\n${tool.block}` + v.slice(e);
  return v;
}

export function TaskEditor({ port, project, projectName, task, onSaved, onLeave, t }: {
  port: number; project: string; projectName: string; task: TaskRow;
  onSaved: (updated: TaskRow) => void; onLeave: (reload: boolean) => void; t: T;
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
      setUnsavable("leave"); return;
    }
    forceLeave();
  };

  // §7.3 的固定順序：正規化 → 取消 pending → flush → 進 isSaving → PUT。
  // flush 失敗「不進 isSaving、不鎖、不發 PUT」是硬性前置條件，沒有強制路徑——
  // §7.3 允許的操作只列了「複製、繼續編輯、取消」，離開路徑才有「仍要離開」的例外（review high finding，
  // K6：寫入不是原子的，草稿留不住又寫壞票檔會同時發生、關掉編輯器後無法復原）
  const save = useCallback(() => {
    const ti = normTitle(title), bo = normBody(body);
    setTitle(ti); setBody(bo);
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
        if (e instanceof TaskConflictError) setNotice({ key: "list.conflictEditor" });
        else setNotice({ key: "list.saveFailed", reason: e instanceof Error ? e.message : String(e) });
      });
  }, [title, body, baseFp, port, project, task.name, onSaved]);

  const copyMine = () => writeClipboard(`# ${title}\n\n${body}`).then((ok) => { if (ok) setNotice({ key: "list.copied" }); });
  // 「捨棄我的版本」：清草稿後直接走，**不經 leave()**——leave 會先 flush 草稿，跟「捨棄」矛盾
  // cancelDebounce 對稱於 discardDraft（:93）：少了它，若上一層哪天不再同步卸載，
  // 排隊中的 debounce 會在 600ms 後把剛丟棄的內容又寫回去（plan R3 F1 同一種坑）
  const discardAndReload = () => { cancelDebounce(); skipFlush.current = true; clearDraft(project, task.name); forceLeave(true); };

  const taRef = useRef<HTMLTextAreaElement>(null);
  const tool = (tl: Tool) => { const ta = taRef.current; if (!ta) return; onBody(applyTool(ta, tl)); };

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
          <span className="btext">{t("list.draftUnsavable")}</span>
          <span className="bacts">
            <button className="bbtn" onClick={copyMine}>{t("list.copyMine")}</button>
            {unsavable === "leave" && <button className="bbtn" onClick={() => forceLeave()}>{t("list.leaveAnyway")}</button>}
          </span>
        </div>
      )}
      {notice && (
        <div className={`tk-banner ${notice.key === "list.copied" ? "is-draft" : "is-conflict"}`}>
          <span className="btext">{t(notice.key, notice.reason ? { reason: notice.reason } : undefined)}</span>
          {notice.key === "list.conflictEditor" && (
            <span className="bacts">
              <button className="bbtn" onClick={copyMine}>{t("list.copyMine")}</button>
              <button className="bbtn" onClick={discardAndReload}>{t("list.discardAndReload")}</button>
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
          <button className="btn is-quiet" disabled={saving} onClick={() => setPreview((p) => !p)}>{t("list.preview")}</button>
          <button className="btn is-quiet" disabled={saving} onClick={leave}>{t("list.cancel")}</button>
          <button className="btn is-primary" disabled={locked} onClick={() => save()}>{t("list.save")}</button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../lib/clipboard";
import { TaskConflictError, updateTasksNote, type TasksNote } from "../lib/sidecar";

type T = (k: string, o?: Record<string, unknown>) => string;

// 離場筆記的介面內編輯器（票 19 增補 §10.3）。**不重用 TaskEditor**——它是票的形狀（標題欄、
// 工具列、預覽、localStorage 草稿），筆記只有一份 textarea。也**不存草稿**（D14）：切走時有未儲存
// 的修改就問一句「仍要離開／留下」，按「仍要離開」就丟掉；票有草稿、筆記沒有，是刻意的不對稱。
export function NoteEditor({ port, project, note, onSaved, onLeave, leaveRequest, t }: {
  port: number; project: string; note: TasksNote;   // note.status === "ok" 才會被掛（TaskDetail 守）
  onSaved: (note: TasksNote) => void;
  onLeave: (reload: boolean, viaRequest: boolean) => void;
  leaveRequest: number; t: T;
}) {
  const [content, setContent] = useState(note.content ?? "");
  const [saving, setSaving] = useState(false);
  // 三種橫幅互斥、同一個 state：unsaved（離開前確認）／conflict（409）／error（其他失敗）
  const [banner, setBanner] = useState<null | "unsaved" | "conflict" | "error">(null);
  // 「已複製」是獨立旗標，不塞進 banner：塞進去會把 conflict 橫幅（連同「重新載入」）換掉——
  // 409 的復原是「先複製、再重新載入」，第二步就這樣消失（TaskEditor 已經踩過同一個坑）
  const [copied, setCopied] = useState(false);
  // 沒有草稿要 flush，「髒」直接從內容算，不另開 state
  const dirty = content !== (note.content ?? "");

  // 這次離開是誰發起的（onLeave 第二個參數）——與 TaskEditor **完全相同**的機制（spec §5.7、Codex R5）：
  // 父層的 leaveRequest → "request"，父層才套用被攔下的導覽；自己的取消 → "self"，父層只結束編輯。
  // 來源只在「發起」時寫入，「仍要離開」沿用上一次的（它不經 leave()），只有新的自發動作才改回 "self"。
  // 少了這個區分，nav 觸發的 leave 停在橫幅之後，父層殘留的 pendingNav 會被之後使用者自己按的取消消耗掉
  const leaveSource = useRef<"request" | "self">("self");
  const forceLeave = (reload = false) => onLeave(reload, leaveSource.current === "request");
  // 不髒 → 直接走；髒 → 停下來問，什麼都不寫（D14）
  const leave = () => { if (!dirty) { forceLeave(false); return; } setBanner("unsaved"); };
  const selfLeave = () => { leaveSource.current = "self"; leave(); };

  // 父層的導覽在編輯中一律先問這裡（spec §5.7）。用 ref 拿最新的 leave：effect 只認 leaveRequest 的變化，
  // closure 裡的 leave 會過期（dirty 是舊值）
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  // 只處理「掛載之後」的增量：父層的計數只增不減，若掛載時就把非零值當請求，
  // 上一次編輯中導覽留下的值會讓下一個編輯器一掛上就立刻離開（Codex plan R1 high）
  const seenLeave = useRef(leaveRequest);
  useEffect(() => {
    if (leaveRequest === seenLeave.current) return;
    seenLeave.current = leaveRequest;
    leaveSource.current = "request";
    leaveRef.current();
  }, [leaveRequest]);

  const save = () => {
    setCopied(false); setBanner(null); setSaving(true);   // 新的儲存嘗試開始，舊的橫幅與「已複製」作廢
    // 送出的是「內容所基於的那版」的 fingerprint（note 是掛載時的那份，key 綁專案、換專案整個重掛）
    updateTasksNote(port, project, content, note.fingerprint!)
      .then((n) => { setSaving(false); onSaved(n); })
      .catch((e: unknown) => {
        setSaving(false);
        if (e instanceof TaskConflictError) { setBanner("conflict"); return; }
        // 判別碼不進畫面（CLAUDE.md §4.6.13）：console 留診斷，畫面只給固定字串
        console.error("updateTasksNote 失敗", e);
        setBanner("error");
      });
  };
  // 409 後的「重新載入」是自發動作：父層結束編輯、清掉筆記重抓，pane 不變
  const reload = () => { leaveSource.current = "self"; forceLeave(true); };
  const copyMine = () => writeClipboard(content).then((ok) => { if (ok) setCopied(true); });
  // `disabled` 只擋得住點擊——受控輸入框在 disabled 時仍可能收到程式化的 change（測試環境如此），
  // 儲存中改到 content 會讓畫面與送出的內容分岔，early return 是第二道（與 TaskEditor 同理由）
  const onChange = (v: string) => { if (saving) return; setContent(v); };

  return (
    <>
      {banner === "unsaved" && (
        <div className="tk-banner is-draft">
          <span className="btext">{t("note.unsaved")}</span>
          <span className="bacts">
            <button className="bbtn" onClick={() => forceLeave(false)}>{t("list.leaveAnyway")}</button>
            <button className="bbtn" onClick={() => setBanner(null)}>{t("note.stay")}</button>
          </span>
        </div>
      )}
      {banner === "conflict" && (
        <div className="tk-banner is-conflict">
          <span className="btext">{t("note.conflict")}</span>
          {copied && <span className="btext">{t("list.copied")}</span>}
          <span className="bacts">
            <button className="bbtn" onClick={copyMine}>{t("list.copyMine")}</button>
            <button className="bbtn" onClick={reload}>{t("note.reload")}</button>
          </span>
        </div>
      )}
      {banner === "error" && (
        <div className="tk-banner is-conflict"><span className="btext">{t("list.actionError")}</span></div>
      )}
      <div className="full-editor">
        <textarea className="ed-area" aria-label={t("note.editorBody")} value={content} disabled={saving}
          onChange={(e) => onChange(e.target.value)} />
        <div className="ed-foot">
          <span className="spacer" />
          <button className="btn is-quiet" disabled={saving} onClick={selfLeave}>{t("list.cancel")}</button>
          <button className="btn is-primary" disabled={saving || !dirty} onClick={save}>{t("list.save")}</button>
        </div>
      </div>
    </>
  );
}

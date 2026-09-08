// 票的未存草稿（spec §7.1、§7.6）。存 localStorage、票檔完全不碰。
//
// 鍵帶專案路徑：不同專案的同名票是不同的票。
// 記 fingerprint：存檔送出的必須是「開始編輯那一版」的指紋（§7.2），草稿還原時要一起還原。
//
// 每個 read／write 都包 try：localStorage 在私密視窗、額度滿、被停用時會 throw，
// 而草稿是安全網，安全網自己不能炸。

export interface TaskDraft { title: string; body: string; fingerprint: string; savedAt: number }

const PREFIX = "fledge.taskDraft.";
const key = (project: string, name: string) => `${PREFIX}${project}/${name}`;

export function loadDraft(project: string, name: string): TaskDraft | null {
  try {
    const raw = localStorage.getItem(key(project, name));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<TaskDraft>;
    if (typeof d.title !== "string" || typeof d.body !== "string" || typeof d.fingerprint !== "string") return null;
    return { title: d.title, body: d.body, fingerprint: d.fingerprint, savedAt: typeof d.savedAt === "number" ? d.savedAt : 0 };
  } catch {
    return null;
  }
}

/** 回 false ＝ 寫不進去。呼叫端要擋下儲存並明說（§7.3 步驟 3），不可以靜默略過。 */
export function saveDraft(project: string, name: string, d: Omit<TaskDraft, "savedAt">): boolean {
  try {
    localStorage.setItem(key(project, name), JSON.stringify({ ...d, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(project: string, name: string): void {
  try { localStorage.removeItem(key(project, name)); } catch { /* 清不掉就算了，下次進來會再提示 */ }
}

/** 該專案所有草稿。給孤兒草稿（票已不在清單裡）用（§7.4）。 */
export function listDrafts(project: string): Array<{ name: string; draft: TaskDraft }> {
  const out: Array<{ name: string; draft: TaskDraft }> = [];
  const p = `${PREFIX}${project}/`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const kk = localStorage.key(i);
      if (!kk || !kk.startsWith(p)) continue;
      const name = kk.slice(p.length);
      const draft = loadDraft(project, name);
      if (draft) out.push({ name, draft });
    }
  } catch { /* 同上 */ }
  return out;
}

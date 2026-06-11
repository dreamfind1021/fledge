// IME 幽靈草稿（真懸置的視覺補償，design §1.1 + 驗收回饋）：切走時組字被 OS 懸置、
// 畫面上消失——在游標處顯示半透明草稿字樣，切回後第一個互動（IME 還原／Enter 重放／Esc）
// 即移除。狀態機與 DOM 渲染分離：本類只回答「現在該不該顯示什麼」，渲染在 Terminal 接線。
// 與 ImeReplayGuard 同款「懸置候選＋blur 確認」：Esc 取消（end 空但無 blur）不會誤顯示。
export class ImeDraftTracker {
  private static readonly SUSPEND_BLUR_ASSOC_MS = 1000;

  private composing = false;
  private lastCompData = "";
  private pendingDraft: string | null = null;
  private pendingAt = -Infinity;
  private draft: string | null = null;

  /** 目前該顯示的草稿（null = 不顯示） */
  get suspendedDraft(): string | null {
    return this.draft;
  }

  /** compositionstart：IME 接手（新組字／還原進組字）→ 草稿退場、重新追蹤 */
  compositionStart(): void {
    this.composing = true;
    this.lastCompData = "";
    this.pendingDraft = null;
    this.pendingAt = -Infinity;
    this.draft = null;
  }

  /** compositionupdate：記錄最新組字串（懸置時這就是要顯示的草稿） */
  compositionUpdate(data: string): void {
    if (this.composing) this.lastCompData = data;
  }

  /** compositionend：data 空＋有組字內容 = 懸置候選（待 blur 確認）；data 非空 = 正常 commit */
  compositionEnd(data: string, now: number): void {
    this.composing = false;
    if (data === "" && this.lastCompData !== "") {
      this.pendingDraft = this.lastCompData;
      this.pendingAt = now;
    } else {
      this.pendingDraft = null;
      this.pendingAt = -Infinity;
    }
    this.lastCompData = "";
  }

  /** window blur：懸置候選在相鄰窗內 → 草稿生效顯示 */
  markBlur(now: number): void {
    if (this.pendingDraft != null && now - this.pendingAt <= ImeDraftTracker.SUSPEND_BLUR_ASSOC_MS) {
      this.draft = this.pendingDraft;
    }
    this.pendingDraft = null;
    this.pendingAt = -Infinity;
  }

  /** Enter 重放／Esc 等互動 → 草稿退場 */
  dismiss(): void {
    this.draft = null;
  }
}

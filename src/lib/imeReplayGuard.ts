// IME 切視窗重複輸入的重放攔截（機制 A 變體「suspend-replay」，Phase 0 trace 定論）：
// 組字中按 Cmd 切走 → xterm keydown-finalize 強制送出第一份 → deactivate 把組字懸置
//（compositionend data:""、textarea 清空、IME 內部留著）→ 切回後第一次按 Enter 前，
// IME 以 trusted insertText 重放原組字串，xterm 的 input(insertText) 路徑原樣再送 = 第二份。
// 攔截條件由事件身分導出；唯一常數是 compositionend↔blur 的相鄰性上限（trace 同毫秒、
// 上限取 1s），無行為時窗。使用者重打必走組字路徑（compositionstart 解除武裝），
// bare insertText 撞上 armed+同字串只可能是重放。
export class ImeReplayGuard {
  /** compositionend(data:"") 與 blur 的相鄰性上限：trace 實測同毫秒，1s 為寬鬆上界 */
  private static readonly SUSPEND_BLUR_ASSOC_MS = 1000;

  private composing = false;
  private candidate: string | null = null;
  private pendingArmAt = -Infinity;
  private armed = false;

  /** compositionstart：新組字 = 使用者真實輸入 → 解除武裝、重新追蹤 */
  compositionStart(): void {
    this.composing = true;
    this.candidate = null;
    this.pendingArmAt = -Infinity;
    this.armed = false;
  }

  /** compositionend：data 空 + 已有第一份 = 懸置候選（待 blur 確認）；data 非空 = 正常 commit */
  compositionEnd(data: string, now: number): void {
    this.composing = false;
    if (data === "" && this.candidate != null) {
      this.pendingArmAt = now;
    } else {
      this.candidate = null;
      this.pendingArmAt = -Infinity;
    }
  }

  /** window blur：懸置候選在相鄰上限內 → 武裝（deactivate 邊界確認，防非切窗場景誤武裝） */
  markBlur(now: number): void {
    if (now - this.pendingArmAt <= ImeReplayGuard.SUSPEND_BLUR_ASSOC_MS) {
      this.armed = true;
    }
    this.pendingArmAt = -Infinity;
  }

  /** 每筆 onData 餵入：組字中的「文字」payload = 第一份（過濾 DSR／控制序列——claude TUI
   *  的游標回報每 ~200ms 一筆、會落在第一份與 compositionend 之間，無過濾會覆寫 candidate）；
   *  armed 後見 \r = 行已執行（backstop 解除） */
  noteData(payload: string): void {
    if (this.composing) {
      if (ImeReplayGuard.isTextPayload(payload)) this.candidate = payload;
      return;
    }
    if (this.armed && payload.includes("\r")) {
      this.armed = false;
      this.candidate = null;
    }
  }

  /** 組字中該吞掉的 keydown：xterm 的 CompositionHelper.keydown 看到非 20/229/16/17/18
   *  （CapsLock/IME/Shift/Ctrl/Alt）的 keydown 會 _finalizeComposition(false) 提前送出半成品
   *  （重複的根源，design §1.1）。兩個觸發鍵：
   *  - Meta：組字中按 Cmd 切視窗（Cmd+Tab）。
   *  - Unidentified：組字中按 CapsLock 切中英，macOS 在 commit 前多發一個 key="Unidentified"
   *    ／keyCode=0 的附隨 keydown（CapsLock 本身 keyCode=20 被 xterm 豁免，但這個附隨事件
   *    沒有）→ xterm 提前 finalize 送一次、隨後 compositionend 再送一次 ＝ 重複（log 實證）。
   *  吞掉（stopPropagation 不 preventDefault）讓 macOS 原生 commit（compositionend）成為唯一
   *  送出路徑；非組字中不吞，Cmd 快捷鍵與 CapsLock 照常。 */
  shouldSwallowKeydown(key: string): boolean {
    return this.composing && (key === "Meta" || key === "Unidentified");
  }

  /** beforeinput 是否該攔（攔即消耗武裝 one-shot；不匹配不消耗） */
  shouldBlock(inputType: string, data: string | null, trusted: boolean): boolean {
    if (!this.armed || !trusted || inputType !== "insertText" || !data || data !== this.candidate) {
      return false;
    }
    this.armed = false;
    this.candidate = null;
    return true;
  }

  /** 文字 payload：非 ESC 序列、且至少含一個可列印字元 */
  private static isTextPayload(payload: string): boolean {
    if (payload.startsWith("\x1b")) return false;
    return Array.from(payload).some((c) => {
      const cp = c.codePointAt(0)!;
      return cp >= 0x20 && cp !== 0x7f;
    });
  }
}

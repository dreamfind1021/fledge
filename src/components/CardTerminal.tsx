import { ChevronRight } from "lucide-react";
import { Terminal } from "./Terminal";

interface CardTerminalProps {
  port: number;
  sessionId: string;
  tabId: string;
  /** 標頭文字：實際執行的命令（安裝）或卡片識別（登入）。前端不自組命令字串。 */
  title: string;
  /** 跑在裡面的命令結束時觸發（PTY EOF）。卡片據此解除按鈕停用、回讀狀態 */
  onEnded?: () => void;
}

/** 設置卡內嵌的終端機（安裝／登入共用）。`Workspace` 之外的掛載點：tabId 是合成的，
 *  store 內沒有對應 tab，`setTabStatus`／`setTabActivity` 因此都是原樣返回、不觸發訂閱者。
 *  高度由 `.b4-term-mount` 給定——xterm 的容器是 100%，掛在流佈局裡必須有明確高度。 */
export function CardTerminal({ port, sessionId, tabId, title, onEnded }: CardTerminalProps) {
  return (
    <div className="b4-term">
      <div className="b4-term-head">
        <ChevronRight size={12} strokeWidth={2} />
        <span className="b4-term-cmd">{title}</span>
      </div>
      <div className="b4-term-mount">
        <Terminal port={port} sessionId={sessionId} tabId={tabId} isActive onEnded={onEnded} />
      </div>
    </div>
  );
}

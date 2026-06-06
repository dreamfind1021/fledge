import { useEffect } from "react";
import "./ContextMenu.css";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  useEffect(() => {
    const onAway = () => onClose();
    const onKey = () => onClose(); // 任何鍵都關（menu 無鍵盤導航；按鍵代表想做別的，如 Cmd+,）
    // 下一個 tick 才掛，避免開啟當下那次 click 立刻關掉
    const t = setTimeout(() => window.addEventListener("click", onAway), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", onAway);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 邊緣 clamp：避免選單超出視窗被截斷（估算尺寸：寬 ~200、每項 ~34px）
  const estHeight = items.length * 34 + 8;
  const left = Math.max(8, Math.min(x, window.innerWidth - 200 - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - estHeight - 8));

  return (
    <div
      className="ctx-menu"
      style={{ top, left }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <div
          key={i}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className={`ctx-item${item.danger ? " is-danger" : ""}`}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}

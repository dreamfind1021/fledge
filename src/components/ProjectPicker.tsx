import { useEffect, useMemo, useState } from "react";
import { Folder, FolderSearch, Sparkles } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { accountColor } from "../lib/accountColor";
import "./ProjectPicker.css";

interface ProjectPickerProps {
  onClose: () => void;
}

export function ProjectPicker({ onClose }: ProjectPickerProps) {
  const projects = useAppStore((s) => s.projects);
  const openTab = useAppStore((s) => s.openTab);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 50);
  }, [projects, query]);

  useEffect(() => {
    setSel(0);
  }, [query]);

  // Escape 用 window listener（不只靠 input onKeyDown），焦點離開輸入框後仍能關（Codex/final review）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choose = (i: number) => {
    const p = filtered[i];
    if (p) {
      openTab(p);
      onClose();
    }
  };

  return (
    <div className="pp-overlay" onClick={onClose}>
      <div className="pal-card" onClick={(e) => e.stopPropagation()}>
        {/* 搜尋列：sparkles(ai accent) + input */}
        <div className="pal-search">
          <span className="pico">
            <Sparkles size={19} />
          </span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "Enter") choose(sel);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              }
            }}
            placeholder="輸入專案名…"
          />
        </div>

        {/* 結果清單 */}
        <div className="pal-list">
          {filtered.length === 0 ? (
            /* 無結果空狀態：置中圖示 + 提示文字 */
            <div className="pal-empty">
              <FolderSearch size={32} strokeWidth={1.5} className="pal-empty-ico" />
              <div className="pal-empty-msg">找不到符合的專案</div>
            </div>
          ) : (
            <>
              <div className="pal-sec">專案</div>
              {filtered.map((p, i) => (
                <div
                  key={p.path}
                  className={`pal-row${i === sel ? " is-sel" : ""}`}
                  onClick={() => choose(i)}
                  onMouseEnter={() => setSel(i)}
                >
                  {/* folder 圖示：選中時透過 CSS .is-sel .rico 轉 ai 色 */}
                  <span className="rico">
                    <Folder size={17} />
                  </span>

                  {/* 專案名 */}
                  <span className="rname">{p.name}</span>

                  {/* 路徑（等寬，faint）*/}
                  <span className="rpath">{p.path}</span>

                  {/* 帳號 chip：彩色方塊 + 帳號名 */}
                  <span className="rchip">
                    <span
                      className="rchip-dot"
                      style={{ background: accountColor(p.account) }}
                    />
                    {p.account}
                  </span>

                  {/* 選中 hint：僅在選取列（i === sel）條件渲染 */}
                  {i === sel && (
                    <span className="rhint">
                      <Sparkles size={14} />
                      ↵ 啟動 session
                    </span>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer：鍵盤快捷鍵提示 */}
        <div className="pal-foot">
          <span><kbd>↑↓</kbd>選擇</span>
          <span><kbd>↵</kbd>啟動 session</span>
          <span><kbd>esc</kbd>關閉</span>
        </div>
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import { Pin, Folder, FolderOpen, FolderPlus, Search, Settings } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store/useAppStore";
import type { Project } from "../lib/sidecar";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { accountColor } from "../lib/accountColor";
import { groupProjectsByAccount, tabKey } from "../lib/sidebarGroups";
import { pickDirectory } from "../lib/dialog";
import { scanPreview } from "../lib/sidecar";
import { FeatherMark } from "./Logo";
import "./Sidebar.css";

export function Sidebar({ onOpenPicker, onOpenSettings }: { onOpenPicker: () => void; onOpenSettings: () => void }) {
  const projects = useAppStore((s) => s.projects);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const openTab = useAppStore((s) => s.openTab);
  const setProjectAccount = useAppStore((s) => s.setProjectAccount);
  const removeManual = useAppStore((s) => s.removeManual);
  const addManual = useAppStore((s) => s.addManual);
  // selector 只取 config（穩定 ref）；Object.keys 等衍生值在 render body 算
  // （Zustand v5：selector 回新 array 會無限 re-render，見 zustand-v5-selector-stable-ref memory）。
  const config = useAppStore((s) => s.config);

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; path: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // 底部「開啟其他資料夾」：選完新資料夾後彈帳號選單選類型
  const [accountPicker, setAccountPicker] = useState<{ x: number; y: number; dir: string } | null>(null);
  const openFolderBtn = useRef<HTMLButtonElement>(null);

  const accountKeys = config ? Object.keys(config.accounts) : [];
  const openTabKeys = new Set(tabs.map((t) => tabKey(t.projectPath, t.account)));
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeKey = activeTab ? tabKey(activeTab.projectPath, activeTab.account) : null;
  const groups = groupProjectsByAccount(projects, openTabKeys, config?.accounts ?? {});

  const openMenu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    const others = accountKeys.filter((a) => a !== p.account);
    const items: MenuItem[] = [];
    // 額度臨時切換：這次用別帳號開，不搬組
    for (const a of others) items.push({ label: `改用「${a}」開啟（這次）`, onClick: () => openTab(p, a) });
    // 重新分類：持久搬到別的類型群組
    for (const a of others) items.push({ label: `設為預設帳號 → ${a}`, onClick: () => setProjectAccount(p.path, a) });
    items.push({ label: "在 Finder 顯示", onClick: () => { revealItemInDir(p.path).catch(() => {}); } });
    if (p.source === "manual") items.push({ label: "移除", onClick: () => removeManual(p.path), danger: true });
    setMenu({ x: e.clientX, y: e.clientY, items, path: p.path });
  };

  // 單列渲染：isOpen 來自所屬 band（band1 為 true）。trailing slot：綠點＝開啟中、Pin＝manual、否則留空對齊。
  // isDiscovered：在自動發現 band 內，folder icon 用 faint 色。
  const renderRow = (p: Project, isOpen: boolean, isDiscovered = false) => {
    const isActive = isOpen && tabKey(p.path, p.account) === activeKey;
    // path 比對即足夠：scanner 以 by_path dedup，一個 path 在 projects 只出現一列（其持久帳號群組），不會雙高亮
    const isMenuTarget = menu?.path === p.path;

    const itemClass = [
      "sidebar-item",
      isActive ? "is-active" : "",
      isMenuTarget ? "is-menu-target" : "",
      isOpen ? "is-open" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        key={p.path}
        onClick={() => openTab(p)}
        onContextMenu={(e) => openMenu(e, p)}
        className={itemClass}
      >
        {/* 左側 folder icon */}
        <span className={`sidebar-item-ico${isDiscovered ? " is-discovered" : ""}`}>
          <Folder size={16} strokeWidth={1.75} />
        </span>
        {/* 名稱（flex:1，ellipsis） */}
        <span className="sidebar-item-name">{p.name}</span>
        {/* trailing slot：live dot / Pin / 空 */}
        <span className="sidebar-item-trail">
          {isOpen ? (
            <span className="sidebar-live" />
          ) : p.source === "manual" ? (
            <Pin size={12} strokeWidth={1.75} color="var(--faint)" />
          ) : null}
        </span>
      </button>
    );
  };

  // 選資料夾 → 已存在直接開、新資料夾彈帳號選單選類型
  const onOpenFolder = async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    // pickDirectory 回的可能是 symlink 路徑，但清單裡的 path 是後端 canonicalize（resolve）後的；
    // 用 scanPreview 取得同款 canonical 再比對/傳遞，否則 symlink 選的資料夾會對不上（Codex PR review）
    const port = useAppStore.getState().port;
    let canonical = dir;
    if (port != null) {
      try {
        const res = await scanPreview(port, dir);
        if (res.path) canonical = res.path;
      } catch {
        /* 取不到 canonical 就用原值 best-effort */
      }
    }
    // 經過 await（pickDirectory + scanPreview）後讀最新 projects，不用 render 快照（Codex PR round2）；
    // 與下方 chooseTypeForNewDir 的 getState() 一致
    const existing = useAppStore.getState().projects.find((p) => p.path === canonical);
    if (existing) {
      openTab(existing); // 已在清單：用既有類型開（已開則切到該 tab），不問帳號、不改分類
      return;
    }
    const rect = openFolderBtn.current?.getBoundingClientRect();
    setAccountPicker({ x: rect ? rect.left : 12, y: rect ? rect.top : 0, dir: canonical });
  };

  // 新資料夾選定類型：addManual 持久化（下次自動出現在該類型群組）後開啟
  const chooseTypeForNewDir = async (dir: string, account: string) => {
    setAccountPicker(null);
    try {
      await addManual(dir, account); // store 內會 loadProjects
      const np = useAppStore.getState().projects.find((p) => p.path === dir);
      if (np) openTab(np); // fire-and-forget（與 onOpenFolder 一致；openTab 自行處理錯誤）
    } catch (e) {
      // 加資料夾失敗（sidecar/IO）：避免 unhandled rejection 靜默吞掉、造成「以為加了其實沒加」
      console.error("[Sidebar] 開啟新資料夾失敗", e);
    }
  };

  return (
    <div className="sidebar">
      {/* === 品牌 header === */}
      <div className="sidebar-brand">
        <FeatherMark size={24} />
        <span className="sidebar-brand-name">Fledge</span>
        <button
          className="sidebar-gear"
          onClick={onOpenSettings}
          aria-label="設定"
          title="設定"
        >
          <Settings size={16} strokeWidth={1.75} />
        </button>
      </div>

      {/* === 搜尋 pill === */}
      <button
        className="sidebar-search"
        onClick={onOpenPicker}
        aria-label="搜尋專案"
      >
        <Search size={14} strokeWidth={1.75} />
        <span className="sidebar-search-text">搜尋專案…</span>
        <kbd className="kbd">⌘T</kbd>
      </button>

      {/* === 捲動群組清單 === */}
      <div className="sidebar-scroll">
        {groups.length === 0 && (
          /* 空狀態：尚無任何群組（無專案）→ 置中提示 + 主要動作 */
          <div className="sidebar-empty">
            <FolderOpen size={36} strokeWidth={1.5} className="sidebar-empty-ico" />
            <div className="sidebar-empty-head">還沒有專案</div>
            <div className="sidebar-empty-hint">開啟一個工作根目錄開始</div>
            <button
              className="sidebar-empty-btn"
              onClick={onOpenFolder}
              disabled={accountKeys.length === 0}
            >
              開啟資料夾
            </button>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key} className="sidebar-group">
            {/* 帳號 header */}
            <div className="sidebar-acct">
              {/* 動態帳號色：accountColor() 無法 CSS 化，保留 inline style */}
              <span
                className="sidebar-acct-dot"
                style={{ background: accountColor(g.key) }}
              />
              <span className="sidebar-acct-label">{g.label}</span>
              <span className="sidebar-acct-dir">{g.configDir}</span>
              <span className="sidebar-acct-count">{g.total}</span>
            </div>
            {g.open.map((p) => renderRow(p, true))}
            {g.surfaced.map((p) => renderRow(p, false))}
            {g.discovered.length > 0 && (
              <button
                className="sidebar-band"
                onClick={() => setExpanded((s) => ({ ...s, [g.key]: !s[g.key] }))}
              >
                {expanded[g.key] ? "▾" : "▸"} 自動發現 {g.discovered.length} 個
              </button>
            )}
            {expanded[g.key] && g.discovered.map((p) => renderRow(p, false, true))}
          </div>
        ))}
      </div>

      {/* === 底部：開啟其他資料夾 === */}
      <div className="sidebar-foot">
        <button
          ref={openFolderBtn}
          className="sidebar-openbtn"
          onClick={onOpenFolder}
          disabled={accountKeys.length === 0}
          // config 未載入（啟動中）或無帳號時 disable，避免開出 items=[] 的空帳號選單（Codex plan F-2）
        >
          <FolderPlus size={15} strokeWidth={2} />
          開啟其他資料夾
        </button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {accountPicker && (
        <ContextMenu
          x={accountPicker.x}
          y={accountPicker.y}
          items={accountKeys.map((k) => ({
            label: `用「${config?.accounts[k]?.label || k}」開啟`,
            onClick: () => chooseTypeForNewDir(accountPicker.dir, k),
          }))}
          onClose={() => setAccountPicker(null)}
        />
      )}
    </div>
  );
}

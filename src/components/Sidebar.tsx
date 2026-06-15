import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { Pin, Folder, FolderOpen, FolderPlus, Search, Settings, ChevronsLeft, ChevronsRight, ChartColumn, Brain, ChevronRight, ChevronDown } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store/useAppStore";
import type { Project } from "../lib/sidecar";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { accountColor } from "../lib/accountColor";
import { groupProjectsByAccount, tabKey } from "../lib/sidebarGroups";
import { pickDirectory } from "../lib/dialog";
import { scanPreview } from "../lib/sidecar";
import { FeatherMark } from "./Logo";
import { FileTree } from "./FileTree";
import "./Sidebar.css";

function ProjectRow({
  entry, isOpen, isActive, isDiscovered, isMenuTarget, treeOpen, port,
  onOpen, onContextMenu, onToggleTree, tSide,
}: {
  entry: Project; isOpen: boolean; isActive: boolean; isDiscovered: boolean;
  isMenuTarget: boolean; treeOpen: boolean; port: number | null;
  onOpen: () => void; onContextMenu: (e: React.MouseEvent) => void;
  onToggleTree: () => void; tSide: (k: string, o?: Record<string, unknown>) => string;
}) {
  // 拖曳來源（需求 4）：整列可拖，data.type='path'
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `path:${entry.path}`,
    data: { type: "path", paths: [entry.path], label: entry.name },
  });
  const itemClass = ["sidebar-item", isActive ? "is-active" : "", isMenuTarget ? "is-menu-target" : "", isOpen ? "is-open" : ""]
    .filter(Boolean).join(" ");
  return (
    <div className="sidebar-row-wrap">
      <button ref={setNodeRef} {...attributes} {...listeners} onClick={onOpen} onContextMenu={onContextMenu} className={itemClass}>
        <span
          className="sidebar-tree-caret"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onToggleTree(); }}
          aria-label={treeOpen ? tSide("tree.collapse") : tSide("tree.expand")}
        >
          {treeOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className={`sidebar-item-ico${isDiscovered ? " is-discovered" : ""}`}><Folder size={16} strokeWidth={1.75} /></span>
        <span className="sidebar-item-name">{entry.name}</span>
        <span className="sidebar-item-trail">
          {isOpen ? <span className="sidebar-live" /> : entry.source === "manual" ? <Pin size={12} strokeWidth={1.75} color="var(--faint)" /> : null}
        </span>
      </button>
      {treeOpen && port != null && <FileTree port={port} rootPath={entry.path} />}
    </div>
  );
}

export function Sidebar({ onOpenPicker, onOpenSettings }: { onOpenPicker: () => void; onOpenSettings: () => void }) {
  const { t: tDash } = useTranslation("dashboard");
  const { t: tMem } = useTranslation("memory");
  const { t: tSide } = useTranslation("sidebar");
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
  const port = useAppStore((s) => s.port);

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; path: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [treeOpen, setTreeOpen] = useState<Set<string>>(new Set());
  // 側欄收合：localStorage 開機讀回、toggle 時寫入（純前端 UI 狀態，spec §3.1）
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("fledge.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("fledge.sidebarCollapsed", next ? "1" : "0");
      } catch {
        /* localStorage 不可用時僅不持久化，不影響功能 */
      }
      return next;
    });
  // 底部「開啟其他資料夾」：選完新資料夾後彈帳號選單選類型
  const [accountPicker, setAccountPicker] = useState<{ x: number; y: number; dir: string } | null>(null);
  const openFolderBtn = useRef<HTMLButtonElement>(null);

  const accountKeys = config ? Object.keys(config.accounts) : [];
  const openTabKeys = new Set(
    tabs.filter((t) => t.kind === "claude").map((t) => tabKey(t.projectPath, t.account)),
  );
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeKey =
    activeTab && activeTab.kind === "claude" ? tabKey(activeTab.projectPath, activeTab.account) : null;
  const groups = groupProjectsByAccount(projects, openTabKeys, config?.accounts ?? {});

  const openMenu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    const others = accountKeys.filter((a) => a !== p.account);
    const items: MenuItem[] = [];
    // 最上方：用純終端機開啟（進專案路徑、不進 claude；可開多個）
    items.push({ label: tSide("menu.openTerminal"), onClick: () => openTab(p, p.account, "terminal") });
    // 額度臨時切換：這次用別帳號開，不搬組
    for (const a of others) items.push({ label: tSide("menu.openWithAccountOnce", { account: a }), onClick: () => openTab(p, a) });
    // 重新分類：持久搬到別的類型群組
    for (const a of others) items.push({ label: tSide("menu.setDefaultAccount", { account: a }), onClick: () => setProjectAccount(p.path, a) });
    items.push({ label: tSide("menu.revealInFinder"), onClick: () => { revealItemInDir(p.path).catch(() => {}); } });
    if (p.source === "manual") items.push({ label: tSide("menu.remove"), onClick: () => removeManual(p.path), danger: true });
    setMenu({ x: e.clientX, y: e.clientY, items, path: p.path });
  };

  // 單列渲染：isOpen 來自所屬 band（band1 為 true）。trailing slot：綠點＝開啟中、Pin＝manual、否則留空對齊。
  // isDiscovered：在自動發現 band 內，folder icon 用 faint 色。
  // path 比對即足夠：scanner 以 by_path dedup，一個 path 在 projects 只出現一列（其持久帳號群組），不會雙高亮
  const renderRow = (p: Project, isOpen: boolean, isDiscovered = false) => {
    const isActive = isOpen && tabKey(p.path, p.account) === activeKey;
    const isMenuTarget = menu?.path === p.path;
    return (
      <ProjectRow
        key={p.path}
        entry={p}
        isOpen={isOpen}
        isActive={isActive}
        isDiscovered={isDiscovered}
        isMenuTarget={isMenuTarget}
        treeOpen={treeOpen.has(p.path)}
        port={port}
        onOpen={() => openTab(p)}
        onContextMenu={(e) => openMenu(e, p)}
        onToggleTree={() =>
          setTreeOpen((s) => {
            const n = new Set(s);
            n.has(p.path) ? n.delete(p.path) : n.add(p.path);
            return n;
          })
        }
        tSide={tSide}
      />
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

  // 開資料夾後的帳號選單：展開／收合兩種版面共用
  const accountPickerMenu = accountPicker && (
    <ContextMenu
      x={accountPicker.x}
      y={accountPicker.y}
      items={accountKeys.map((k) => ({
        label: tSide("menu.openWithAccount", { label: config?.accounts[k]?.label || k }),
        onClick: () => chooseTypeForNewDir(accountPicker.dir, k),
      }))}
      onClose={() => setAccountPicker(null)}
    />
  );

  // 收合：窄軌（寬度對齊品牌圖示）。三段式 flex——上(品牌/展開/設定/儀表板)、中(彈性 spacer)、下(開資料夾)。
  // 儀表板 icon 併入頂部群組，與展開／設定 icon 等距（6px），避免擺中段 flex:1 撐出過大間距（實機視覺回饋）。
  if (collapsed) {
    return (
      <div className="sidebar is-collapsed">
        <div className="sidebar-rail-top">
          <FeatherMark size={24} />
          <button
            className="sidebar-rail-btn"
            onClick={toggleCollapsed}
            aria-label={tSide("expandSidebar")}
            title={tSide("expandSidebar")}
          >
            <ChevronsRight size={18} strokeWidth={2} />
          </button>
          <button
            className="sidebar-rail-btn"
            onClick={onOpenSettings}
            aria-label={tSide("settings")}
            title={tSide("settings")}
          >
            <Settings size={18} strokeWidth={1.75} />
          </button>
          <button
            className="sidebar-rail-btn"
            title={tDash("entry")}
            onClick={() => useAppStore.getState().openDashboard()}
          >
            <ChartColumn size={18} strokeWidth={1.75} />
          </button>
          <button
            className="sidebar-rail-btn"
            aria-label={tMem("entry")}
            title={tMem("entry")}
            onClick={() => useAppStore.getState().openMemory()}
          >
            <Brain size={18} strokeWidth={1.75} />
          </button>
        </div>
        {/* 彈性 spacer：把開資料夾鈕推到底 */}
        <div className="sidebar-rail-spacer" />
        <div className="sidebar-rail-foot">
          <button
            ref={openFolderBtn}
            className="sidebar-rail-btn sidebar-rail-btn--accent"
            onClick={onOpenFolder}
            disabled={accountKeys.length === 0}
            aria-label={tSide("openFolder")}
            title={tSide("openFolder")}
          >
            <FolderPlus size={18} strokeWidth={2} />
          </button>
        </div>
        {accountPickerMenu}
      </div>
    );
  }

  return (
    <div className="sidebar">
      {/* === 品牌 header === */}
      <div className="sidebar-brand">
        <FeatherMark size={24} />
        <span className="sidebar-brand-name">Fledge</span>
        <button
          className="sidebar-gear"
          onClick={onOpenSettings}
          aria-label={tSide("settings")}
          title={tSide("settings")}
        >
          <Settings size={16} strokeWidth={1.75} />
        </button>
        <button
          className="sidebar-collapse-btn"
          onClick={toggleCollapsed}
          aria-label={tSide("collapseSidebar")}
          title={tSide("collapseSidebar")}
        >
          <ChevronsLeft size={18} strokeWidth={2} />
        </button>
      </div>

      {/* === 搜尋 + 儀表板（並排一行，省垂直空間）=== */}
      <div className="sidebar-topbar">
        <button
          className="sidebar-search"
          onClick={onOpenPicker}
          aria-label={tSide("searchAria")}
        >
          <Search size={14} strokeWidth={1.75} />
          <span className="sidebar-search-text">{tSide("search")}</span>
          <kbd className="kbd">⌘T</kbd>
        </button>
        <button
          className="sidebar-dash-btn"
          onClick={() => useAppStore.getState().openDashboard()}
          aria-label={tDash("entry")}
          title={tDash("entry")}
        >
          <ChartColumn size={16} strokeWidth={1.75} />
        </button>
        <button
          className="sidebar-dash-btn"
          onClick={() => useAppStore.getState().openMemory()}
          aria-label={tMem("entry")}
          title={tMem("entry")}
        >
          <Brain size={16} strokeWidth={1.75} />
        </button>
      </div>

      {/* === 捲動群組清單 === */}
      <div className="sidebar-scroll">
        {groups.length === 0 && (
          /* 空狀態：尚無任何群組（無專案）→ 置中提示 + 主要動作 */
          <div className="sidebar-empty">
            <FolderOpen size={36} strokeWidth={1.5} className="sidebar-empty-ico" />
            <div className="sidebar-empty-head">{tSide("empty.title")}</div>
            <div className="sidebar-empty-hint">{tSide("empty.hint")}</div>
            <button
              className="sidebar-empty-btn"
              onClick={onOpenFolder}
              disabled={accountKeys.length === 0}
            >
              {tSide("empty.action")}
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
                {`${expanded[g.key] ? "▾" : "▸"} ${tSide("discovered", { count: g.discovered.length })}`}
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
          {tSide("openFolder")}
        </button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {accountPickerMenu}
    </div>
  );
}

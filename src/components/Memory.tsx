import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { fetchMemoryOverview, fetchMemoryItem, type MemoryOverview, type MemoryItem, type MemoryProject } from "../lib/sidecar";
import { buildGroups, defaultExpanded, selectionValid, type Facet, type Selection } from "../lib/memoryView";
import { MemoryIndex } from "./MemoryIndex";
import { MemoryDetail } from "./MemoryDetail";
import "./Memory.css";

const EMPTY_FACET: Facet = { source: [], type: [] };

export function Memory({ port, isActive }: { port: number | null; isActive: boolean }) {
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState<Facet>(EMPTY_FACET);
  const [selection, setSelection] = useState<Selection>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [body, setBody] = useState<string | null>(null);
  const [bodyErr, setBodyErr] = useState(false);
  const bodyCache = useRef<Map<string, string>>(new Map());
  const initedExpand = useRef(false);

  const load = useCallback(() => {
    if (port == null) return;
    fetchMemoryOverview(port, q).then((o) => {
      setData(o);
      const groups = buildGroups(o);
      // 首次載入設預設展開（之後尊重使用者手動切換）
      if (!initedExpand.current) { setExpanded(defaultExpanded(groups)); initedExpand.current = true; }
      // q 是視圖過濾、不使 selection 失效（design §5）：只在 q 空（overview 反映真實全集）時，才據 selectionValid 清除「真的沒了」的選取；
      // q 非空時保留 selection（清搜尋後右欄會自動復原 pin）。facet 是前端過濾、不影響此處的 groups，故不會誤清。
      setSelection((sel) => (q ? sel : (selectionValid(sel, groups) ? sel : null)));
    }).catch(() => {});
  }, [port, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => clearInterval(id);
  }, [isActive, load]);

  const groups = useMemo(() => (data ? buildGroups(data) : []), [data]);

  // 由 selection + data 解出右欄要顯示的 item / project
  const selItem: MemoryItem | null = useMemo(() => {
    if (selection?.kind !== "item") return null;
    // 先用 groupKey 對到的列；找不到（fan-out／confirm 後換 group）退而求 path 在任一 group 的同筆。
    // 註：q 搜尋排除該 path 時 data 內不含它 → selItem=null → 右欄暫顯空狀態；清搜尋後復原（selection 已被上面 q-guard 保留）。
    const inGroup = groups.find((x) => x.key === selection.groupKey)?.items.find((it) => it.path === selection.path);
    if (inGroup) return inGroup;
    for (const g of groups) { const hit = g.items.find((it) => it.path === selection.path); if (hit) return hit; }
    return null;
  }, [selection, groups]);
  const selProject: MemoryProject | null = useMemo(() => {
    if (selection?.kind !== "project" || !data) return null;
    return data.projects.find((p) => p.project === selection.projectKey) ?? null;
  }, [selection, data]);

  // 選中 item → 取全文（快取 key = path@mtime；mtime 變即 cache miss）
  useEffect(() => {
    if (!selItem || port == null) { setBody(null); setBodyErr(false); return; }
    const key = `${selItem.path}@${selItem.mtime}`;
    const cached = bodyCache.current.get(key);
    if (cached !== undefined) { setBody(cached); setBodyErr(false); return; }
    setBody(null); setBodyErr(false);
    let cancelled = false;
    fetchMemoryItem(port, selItem.path).then((d) => {
      bodyCache.current.set(key, d.body);
      if (!cancelled) setBody(d.body);
    }).catch(() => { if (!cancelled) setBodyErr(true); });   // 失敗顯錯誤態，不留空白
    return () => { cancelled = true; };
  }, [selItem, port]);

  const onToggle = useCallback((k: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; }), []);

  if (!data) return <div className="mem-root"><div className="mem-loading">…</div></div>;
  return (
    <div className="mem-root">
      <MemoryIndex data={data} groups={groups} q={q} setQ={setQ} facet={facet} setFacet={setFacet}
        expanded={expanded} onToggle={onToggle} selection={selection}
        onSelectItem={(path, groupKey) => setSelection({ kind: "item", path, groupKey })}
        onSelectProject={(projectKey) => setSelection({ kind: "project", projectKey })} />
      <div className="mem-detail">
        <MemoryDetail port={port} selItem={selItem} selBody={body} selBodyErr={bodyErr} selProject={selProject} onAfterWrite={load} />
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchDirTree, type DirEntry } from "../lib/sidecar";
import { FileTreeNode } from "./FileTreeNode";
import "./FileTree.css";

type NodeState = { entries: DirEntry[]; status: string };

export function FileTree({ port, rootPath }: { port: number; rootPath: string }) {
  const { t } = useTranslation("sidebar");
  const [cache, setCache] = useState<Map<string, NodeState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = async (path: string, force = false) => {
    if (!force && cache.has(path)) return;
    try {
      const res = await fetchDirTree(port, path);
      setCache((m) => new Map(m).set(path, { entries: res.entries, status: res.status }));
    } catch {
      setCache((m) => new Map(m).set(path, { entries: [], status: "openErr" }));
    }
  };

  const retry = (path: string) => { void load(path, true); };

  const toggle = (path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else { next.add(path); void load(path); }
      return next;
    });
  };

  useEffect(() => { void load(rootPath); }, [rootPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const hint = (status: string) =>
    status === "not_dir" ? t("tree.notDir") : status === "denied" ? t("tree.denied")
      : status === "missing" ? t("tree.missing") : t("tree.openErr");

  const renderLevel = (path: string, depth: number): React.ReactNode => {
    const node = cache.get(path);
    if (!node) return null;
    if (node.status !== "ok") {
      return (
        <div className="filetree-hint" style={{ paddingLeft: 8 + depth * 14 }}>
          {hint(node.status)}{" "}
          <button className="filetree-retry" onClick={() => retry(path)}>{t("tree.retry")}</button>
        </div>
      );
    }
    return node.entries.map((e) => (
      <FileTreeNode key={e.path} entry={e} depth={depth} expanded={expanded.has(e.path)} onToggle={() => toggle(e.path)}>
        {e.is_dir && expanded.has(e.path) ? renderLevel(e.path, depth + 1) : null}
      </FileTreeNode>
    ));
  };

  return <div className="filetree">{renderLevel(rootPath, 0)}</div>;
}

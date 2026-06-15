import { ChevronRight, ChevronDown, Folder, File as FileIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { DirEntry } from "../lib/sidecar";

export function FileTreeNode({
  entry,
  depth,
  expanded,
  onToggle,
  children,
}: {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `path:${entry.path}`,
    data: { type: "path", paths: [entry.path], label: entry.name },
  });
  return (
    <>
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        className="filetree-node"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => { if (entry.is_dir) onToggle(); }}
        onDoubleClick={() => { if (!entry.is_dir) openPath(entry.path).catch(() => {}); }}
      >
        {entry.is_dir ? (
          <span className="filetree-caret" aria-label={expanded ? t("tree.collapse") : t("tree.expand")}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : (
          <span className="filetree-caret-ph" />
        )}
        <span className="filetree-ico">
          {entry.is_dir ? <Folder size={14} /> : <FileIcon size={14} />}
        </span>
        <span className="filetree-name">{entry.name}</span>
      </div>
      {children}
    </>
  );
}

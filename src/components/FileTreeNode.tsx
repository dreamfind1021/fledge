import { ChevronRight, ChevronDown, Folder, File as FileIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { openFile, type DirEntry } from "../lib/sidecar";

export function FileTreeNode({
  entry,
  depth,
  expanded,
  onToggle,
  port,
  children,
}: {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  // 開檔要經過 sidecar 驗 containment（票 01），所以這一層需要 port
  port: number;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `tree:${entry.path}`,
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
        onDoubleClick={() => {
          // 雙擊檔案用系統預設程式開啟；失敗 log 不靜默吞（CLAUDE.md §3.2）
          if (!entry.is_dir) openFile(port, entry.path).catch((e) => console.error("[FileTree] 開啟失敗:", e));
        }}
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

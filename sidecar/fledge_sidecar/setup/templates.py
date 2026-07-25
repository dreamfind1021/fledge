"""範本部署：把內建的唯讀種子內容以 manifest 驅動、永不覆蓋的方式複製到使用者選定目錄。

安全不變式（上游 spec §7）：
- 只複製 manifest 列出的項目；產生端與載入端**各自**套同一組拒絕規則
  （拒 symlink／絕對路徑／`..`／非 file-dir 型別）——manifest 隨 artifact 出貨，
  載入端不能只信產生端。
- 目的地 containment root 是使用者選定的目錄本身，判定走 inode 身分（APFS 大小寫別名）。
- 永不覆蓋、永不 move：已存在就跳過。因此沒有任何需要授權的破壞性動作。
"""
from __future__ import annotations

import json
import os
import stat as stat_module
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

SourceClass = Literal["public", "private"]
EntryType = Literal["file", "dir"]

MANIFEST_FILENAME = "manifest.json"


@dataclass(frozen=True)
class TemplateSpec:
    id: str                 # 穩定識別碼；前端只傳這個（allowlist key）
    label: str              # 顯示名
    description: str
    source_class: SourceClass   # public=可進 repo 隨釋出版出貨；private=只從 repo 外 staging 帶入


# 範本 allowlist。source_class 是 build 分離的唯一真實來源——artifact manifest 由本表
# 產生分類，缺標不預設成 public（見 template_manifest.verify_artifact）。
#
# label／description 一律英文：sidecar 不回 user-facing 中文 prose（CLAUDE.md §4.6.13）。
# B-4 的範本卡片應以 id 對前端 i18n catalog，本表字串只是無 catalog 時的 fallback。
TEMPLATE_SPECS: list[TemplateSpec] = [
    TemplateSpec(
        "project-starter", "Project starter",
        "CLAUDE.md and docs/ skeleton for a new project; generic content, meant to be edited.",
        "public",
    ),
    TemplateSpec(
        "dev-methodology", "Development methodology",
        "Personal development methodology documents; bundled in self-use builds only.",
        "private",
    ),
    TemplateSpec(
        "kms-seed", "Knowledge base seed",
        "Knowledge management (KMS) directory skeleton; bundled in self-use builds only.",
        "private",
    ),
]

_SPEC_BY_ID: dict[str, TemplateSpec] = {s.id: s for s in TEMPLATE_SPECS}


def get_template_spec(template_id: str) -> TemplateSpec:
    spec = _SPEC_BY_ID.get(template_id)
    if spec is None:
        raise ValueError("unknown_template")
    return spec


@dataclass(frozen=True)
class ManifestEntry:
    path: str        # 相對範本根的 POSIX 路徑，無前導斜線、無 `..`
    type: EntryType


def templates_root() -> str:
    """範本根目錄。優先吃 env 覆蓋（測試用，沿用 FLEDGE_CONFIG_PATH 等既有慣例）；
    凍結（PyInstaller onedir）時走執行期資料目錄；否則回落到 repo 內的 public seed。"""
    override = os.environ.get("FLEDGE_TEMPLATES_DIR")
    if override:
        return override
    if getattr(sys, "frozen", False):
        return str(Path(getattr(sys, "_MEIPASS")) / "templates")
    # dev：repo 內 sidecar/resources/templates-public/（本檔在 fledge_sidecar/setup/ 之下）
    return str(Path(__file__).resolve().parents[2] / "resources" / "templates-public")


def _reject_bad_relpath(rel: str) -> None:
    """路徑必須是相對、無 `..`、無前導斜線。任一不合即整份範本不可用。"""
    if not rel or rel.startswith("/") or os.path.isabs(rel):
        raise ValueError("template_unavailable")
    parts = Path(rel).parts
    if any(p in ("..", "") for p in parts):
        raise ValueError("template_unavailable")


def build_manifest_entries(root: str) -> list[ManifestEntry]:
    """走訪種子目錄產出 manifest（build 時用；drift 測試也用同一支）。
    以 lstat 判型別——symlink 不跟隨、直接判整份不可用。"""
    entries: list[ManifestEntry] = []
    for dirpath, dirnames, filenames in os.walk(root):   # 預設 followlinks=False
        dirnames.sort()
        for name in sorted(dirnames + filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            if rel == MANIFEST_FILENAME:
                continue                      # manifest 自己不列入
            _reject_bad_relpath(rel)
            # 單次 lstat 判型別：不跟隨（symlink 要被判出來），也不留多次 stat 的空窗
            st = os.lstat(full)
            if stat_module.S_ISLNK(st.st_mode):
                raise ValueError("template_unavailable")
            if stat_module.S_ISDIR(st.st_mode):
                entries.append(ManifestEntry(rel, "dir"))
            elif stat_module.S_ISREG(st.st_mode):
                entries.append(ManifestEntry(rel, "file"))
            else:
                raise ValueError("template_unavailable")   # fifo/socket/device
    entries.sort(key=lambda e: e.path)
    return entries


def _sort_key(rel: str) -> tuple:
    """深度優先、父在子前的穩定排序鍵。順序不能靠 manifest 輸入——child-before-parent
    會讓「conflict 停 subtree」形同虛設（子項在父項被判 conflict 之前就處理掉了）。"""
    return tuple(Path(rel).parts)


def load_manifest(template_id: str) -> list[ManifestEntry]:
    """讀出貨的 manifest.json，套拒絕規則**並與實體種子樹對帳**。
    任何不合格 → template_unavailable（整份不可用，不做部分載入）。

    為什麼要對帳而不是只驗語法：manifest 與內容一起出貨，兩者可能不一致。
    最嚴重的是「把 symlink 宣告成 file」——`read_bytes` 會跟過去，把宿主機上的
    任意檔案內容複製進部署結果。宣告不是證據，`lstat` 才是。"""
    get_template_spec(template_id)            # 先驗 allowlist，未知 → unknown_template
    root = os.path.join(templates_root(), template_id)
    path = os.path.join(root, MANIFEST_FILENAME)
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("template_unavailable") from exc
    items = raw.get("entries") if isinstance(raw, dict) else None
    if not isinstance(items, list) or not items:
        raise ValueError("template_unavailable")   # 空 manifest 會被 _aggregate 判成 complete

    entries: list[ManifestEntry] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("template_unavailable")
        rel = item.get("path")
        kind = item.get("type")
        if not isinstance(rel, str) or kind not in ("file", "dir"):
            raise ValueError("template_unavailable")
        _reject_bad_relpath(rel)
        rel = Path(rel).as_posix()                 # 正規化寫法，讓去重與祖先比對可靠
        if rel in seen:
            raise ValueError("template_unavailable")   # 重複宣告
        seen.add(rel)
        # 與實體對帳：宣告的東西必須存在、型別相符、且本身不是 symlink
        full = os.path.join(root, rel)
        try:
            st = os.lstat(full)
        except OSError as exc:
            raise ValueError("template_unavailable") from exc
        if stat_module.S_ISLNK(st.st_mode):
            raise ValueError("template_unavailable")
        if kind == "dir" and not stat_module.S_ISDIR(st.st_mode):
            raise ValueError("template_unavailable")
        if kind == "file" and not stat_module.S_ISREG(st.st_mode):
            raise ValueError("template_unavailable")
        entries.append(ManifestEntry(rel, kind))

    # 每個子項的目錄祖先都必須自己也被宣告，否則部署時父目錄不會被建出來
    declared_dirs = {e.path for e in entries if e.type == "dir"}
    for entry in entries:
        parent = os.path.dirname(entry.path)
        while parent:
            if parent not in declared_dirs:
                raise ValueError("template_unavailable")
            parent = os.path.dirname(parent)

    entries.sort(key=lambda e: _sort_key(e.path))
    return entries

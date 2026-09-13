"""範本部署：把內建的唯讀種子內容以 manifest 驅動、永不覆蓋的方式複製到使用者選定目錄。

安全不變式（上游 spec §7）：
- 只複製 manifest 列出的項目；產生端與載入端**各自**套同一組拒絕規則
  （拒 symlink／絕對路徑／`..`／非 file-dir 型別）——manifest 隨 artifact 出貨，
  載入端不能只信產生端。
- 目的地 containment root 是使用者選定的目錄本身，判定走 inode 身分（APFS 大小寫別名）。
- 永不覆蓋、永不 move：已存在就跳過。因此沒有任何需要授權的破壞性動作。
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import stat as stat_module
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fledge_sidecar.paths import (
    dir_identity,
    expand_and_validate,
    is_same_or_within,
    resolve_best_effort,
)
from fledge_sidecar.setup import safe_fs

logger = logging.getLogger(__name__)

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
        "kms-seed", "Second brain",
        "Research and ideation vault: CLAUDE.md rules, topics/ and library/ templates, "
        "derived index files, and Claude Code hooks for session wrap-up.",
        "public",
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


FileState = Literal["missing", "present", "conflict"]
TemplateState = Literal["not_installed", "partial", "complete", "conflict"]


@dataclass(frozen=True)
class FileOp:
    path: str          # 相對目的地
    type: EntryType
    state: FileState


@dataclass(frozen=True)
class TemplatePlan:
    template: str
    destination: str   # resolved
    state: TemplateState
    operations: list[FileOp]


def resolve_destination(raw: str) -> str:
    """目的地正規化 + 底線防呆。模組自為安全權威，不接受 caller 宣稱已 canonical。"""
    try:
        resolved = resolve_best_effort(expand_and_validate(raw))
    except ValueError as exc:
        raise ValueError("invalid_destination") from exc
    # 目的地是 home 本身或 home 的祖先（含 /）時 containment root 大到形同不設防
    if is_same_or_within(str(Path.home().resolve()), resolved):
        raise ValueError("unsafe_destination")
    return resolved


def probe_entry(destination: str, entry: ManifestEntry) -> FileState:
    """以 lstat/lexists（**不 follow**）判目的地該項的實際型別。純探測，無副作用。"""
    target = os.path.join(destination, entry.path)
    # 父目錄必須仍落在目的地內：中間某層是 symlink 指到外面時，寫下去就出了 root。
    # 這道檢查不倚賴 plan 的 blocked-subtree——lexists/isfile 都會跟過 symlink 判成 present。
    parent = os.path.dirname(target)
    if not is_same_or_within(os.path.realpath(parent), destination):
        return "conflict"
    if not os.path.lexists(target):
        return "missing"
    if os.path.islink(target):
        return "conflict"          # 既有 symlink 一律不接受，寫下去就是沿它寫出去
    if entry.type == "dir":
        return "present" if os.path.isdir(target) else "conflict"
    return "present" if os.path.isfile(target) else "conflict"


def _aggregate(states: list[FileState]) -> TemplateState:
    if any(s == "conflict" for s in states):
        return "conflict"
    if all(s == "present" for s in states):
        return "complete"
    if all(s == "missing" for s in states):
        return "not_installed"
    return "partial"


def _has_blocked_ancestor(rel: str, blocked: set[str]) -> bool:
    """rel 的任一目錄祖先是否已被判 conflict。逐元件上溯而非字串 prefix：
    載入端已正規化成父在子前，但用元件比對才不依賴那個前提，也不會被
    `docs2/x` 誤命中 `docs`。"""
    parent = os.path.dirname(rel)
    while parent:
        if parent in blocked:
            return True
        parent = os.path.dirname(parent)
    return False


def plan(template_id: str, destination_raw: str) -> TemplatePlan:
    """比對 manifest 與目的地現況，產出逐檔操作。除探測外無副作用。"""
    entries = load_manifest(template_id)          # 已對帳、去重、父在子前排序
    destination = resolve_destination(destination_raw)
    operations: list[FileOp] = []
    blocked: set[str] = set()                     # conflict 的目錄，其下一律 conflict
    for entry in entries:
        if _has_blocked_ancestor(entry.path, blocked):
            operations.append(FileOp(entry.path, entry.type, "conflict"))
            continue
        state = probe_entry(destination, entry)
        if state == "conflict" and entry.type == "dir":
            blocked.add(entry.path)
        operations.append(FileOp(entry.path, entry.type, state))
    return TemplatePlan(
        template=template_id,
        destination=destination,
        state=_aggregate([o.state for o in operations]),
        operations=operations,
    )


FileOutcome = Literal["created", "skipped", "conflict", "stale", "failed"]


@dataclass(frozen=True)
class FileResult:
    path: str
    outcome: FileOutcome
    error: str | None = None


@dataclass(frozen=True)
class DeployResult:
    template: str
    destination: str
    results: list[FileResult]


def _open_child_dir(name: str, parent_fd: int) -> int:
    """從 parent_fd 開一個子目錄。O_NOFOLLOW：若該名稱是 symlink 直接 ELOOP，
    不會沿它走出去。回傳的 fd 由呼叫端負責關閉。"""
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)


def _probe_at(parent_fd: int, name: str, entry_type: EntryType) -> FileState:
    """以目錄描述子相對探測單一名稱（不經路徑解析）。deploy 專用；`plan` 的
    路徑版 `probe_entry` 只是預覽，真正決定寫不寫的是這一支。"""
    try:
        st = os.lstat(name, dir_fd=parent_fd)
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "conflict"
    if stat_module.S_ISLNK(st.st_mode):
        return "conflict"          # 既有 symlink 一律不接受
    if entry_type == "dir":
        return "present" if stat_module.S_ISDIR(st.st_mode) else "conflict"
    return "present" if stat_module.S_ISREG(st.st_mode) else "conflict"


def deploy(template_id: str, destination_raw: str) -> DeployResult:
    """依 manifest 部署，逐項盡力——單項失敗不阻斷其餘項目。

    plan 由本函式**重算**（不接受呼叫端傳入的 plan：預覽後檔案系統可能已變）。

    **目的地之下**的寫入一律走釘住的目錄描述子：取得 root fd 後，每一層子目錄都以
    `O_DIRECTORY|O_NOFOLLOW` 從父 fd 開出來，檔案以 `dir_fd` 相對建立。root 以下的
    名稱解析只發生在我們持有描述子的那一刻，之後綁的是 inode 不是路徑。

    **已知殘餘窗口（root 取得本身）**：`os.open(destination)` 仍會由 kernel 重新解析
    `destination` 的**祖先路徑**——`O_NOFOLLOW` 只保護最後一個元件。若在 `resolve_destination`
    之後、這裡之前，某個祖先被 rename 成指向別處的 symlink，我們會釘到錯的 root。
    目的地原本就存在時，下方的身分比對擋得住；目的地是新建的則無從比對。
    判定為可接受：祖先在毫秒級窗口內被抽換不是「意外」（本模組威脅模型只防意外，
    見 Global Constraints），且因為永不覆蓋，最壞結果是「檔案建在錯的目錄」而非資料遺失。
    要完全消除需從可信起點逐元件 `openat` 走完整條路徑，代價與風險不成比例。"""
    computed = plan(template_id, destination_raw)
    destination = computed.destination
    entries = {e.path: e for e in load_manifest(template_id)}
    seed_root = os.path.join(templates_root(), template_id)
    logger.info("範本部署開始：template=%s destination=%s ops=%d",
                template_id, destination, len(computed.operations))

    # plan 之後、開 root 之前取樣的目的地身分（不存在則為 None）——用來偵測祖先被抽換
    approved_identity = dir_identity(destination)

    results: list[FileResult] = []
    # 目的地只建最後一層：父目錄不存在多半是路徑打錯，遞建會在錯的地方留一串垃圾目錄
    try:
        Path(destination).mkdir(parents=False, exist_ok=True)
        root_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as exc:
        logger.error("範本部署無法建立或開啟目的地：destination=%s", destination, exc_info=True)
        return DeployResult(template_id, destination,
                            [FileResult(o.path, "failed", safe_fs.error_code(exc))
                             for o in computed.operations])

    # 開到的 root 必須仍是 plan 當時核准的那個目錄。祖先被換掉的話會開到另一棵樹，
    # 這裡就對不上——擋掉「目的地原本存在」的那一半殘餘窗口。
    if approved_identity is not None:
        st = os.fstat(root_fd)
        if (st.st_dev, st.st_ino) != approved_identity:
            os.close(root_fd)
            logger.error("範本部署中止：目的地身分在 plan 之後改變 destination=%s", destination)
            return DeployResult(template_id, destination,
                                [FileResult(o.path, "failed", "destination_moved")
                                 for o in computed.operations])

    open_dirs: dict[str, int] = {"": root_fd}     # 相對目錄路徑 → 已開啟的 fd
    blocked: set[str] = set()
    try:
        for op in computed.operations:
            entry = entries[op.path]
            parent_rel = os.path.dirname(op.path)
            if _has_blocked_ancestor(op.path, blocked) or parent_rel not in open_dirs:
                # 祖先 conflict／沒建成 → 其下一律不試（父 fd 根本不存在）
                results.append(FileResult(op.path, "conflict"))
                continue
            parent_fd = open_dirs[parent_rel]
            name = os.path.basename(op.path)

            # 寫入前重探（fd 相對）：plan 到現在之間目的地可能已變
            state = _probe_at(parent_fd, name, entry.type)
            if state == "conflict":
                if entry.type == "dir":
                    blocked.add(op.path)
                results.append(FileResult(op.path, "conflict"))
                continue
            if state == "present":
                results.append(FileResult(op.path, "skipped"))   # 永不覆蓋
                if entry.type == "dir":
                    # 已存在的目錄仍要開 fd 才能處理其下項目；開不出來就擋掉整個 subtree
                    try:
                        open_dirs[op.path] = _open_child_dir(name, parent_fd)
                    except OSError:
                        blocked.add(op.path)
                continue
            if state != op.state:
                results.append(FileResult(op.path, "stale"))     # 與重算結果不符，不動
                if entry.type == "dir":
                    blocked.add(op.path)
                continue

            try:
                if entry.type == "dir":
                    os.mkdir(name, dir_fd=parent_fd)
                    open_dirs[op.path] = _open_child_dir(name, parent_fd)
                else:
                    safe_fs.copy_file_no_clobber(
                        os.path.join(seed_root, entry.path), name, dir_fd=parent_fd)
                results.append(FileResult(op.path, "created"))
            except OSError as exc:
                logger.error("範本部署檔案操作失敗：template=%s path=%s",
                             template_id, op.path, exc_info=True)
                if entry.type == "dir":
                    blocked.add(op.path)                          # 目錄沒建成，其下不用試
                results.append(FileResult(op.path, "failed", safe_fs.error_code(exc)))
    finally:
        for fd in open_dirs.values():
            with contextlib.suppress(OSError):
                os.close(fd)

    for r in results:
        if r.outcome in {"conflict", "stale", "failed"}:
            logger.warning("範本部署 %s：template=%s path=%s error=%s",
                           r.outcome, template_id, r.path, r.error)
    logger.info("範本部署完成：template=%s %s",
                template_id, dict(Counter(r.outcome for r in results)))
    return DeployResult(template_id, destination, results)

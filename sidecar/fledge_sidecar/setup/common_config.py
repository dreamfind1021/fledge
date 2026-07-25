"""雙帳號共通設置：把 source account 的設定項以 symlink／copy 同步到 target account。

角色術語（見 CONTEXT.md）：source account＝實體檔持有者；target account＝建連結者。
`canonical` 一詞在本模組只指路徑正規化，不指帳號角色。

安全權威留在模組內：不接受 caller 宣稱「已 canonical」的路徑，
所有 account dir 一律自己 expand→absolute→resolve 後才使用。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fledge_sidecar.paths import expand_and_validate, is_within_root, resolve_best_effort

ShareKind = Literal["symlink", "copy"]


@dataclass(frozen=True)
class EntrySpec:
    name: str               # 相對 account dir 的項目名（allowlist key，不含路徑分隔符）
    share: ShareKind        # symlink=建連結；copy=各自實體檔
    default_selected: bool  # UI 預設是否勾選


# 共通設置 allowlist。C（移機還原）的 repair 會用同一份表重指向新機 source_dir，
# 故 projects 雖預設不選仍收錄——否則現況已存在的 projects 連結在新機修不回來。
ENTRY_SPECS: list[EntrySpec] = [
    EntrySpec("commands", "symlink", True),
    EntrySpec("plugins", "symlink", True),
    EntrySpec("skills", "symlink", True),
    EntrySpec("settings.json", "symlink", True),
    EntrySpec("CLAUDE.md", "copy", True),      # 沿用現狀：兩邊各自實體檔
    EntrySpec("projects", "symlink", False),   # session 歷史跨帳號共用，進階項
]

_SPEC_BY_NAME: dict[str, EntrySpec] = {s.name: s for s in ENTRY_SPECS}


@dataclass(frozen=True)
class AccountGraph:
    source_key: str
    source_dir: str            # resolved
    targets: dict[str, str]    # account key -> resolved dir


def _resolved_config_dir(accounts: dict[str, dict[str, str]], key: str) -> str:
    entry = accounts.get(key)
    if entry is None:
        raise ValueError("unknown_account")
    raw = (entry.get("config_dir") or "").strip()
    try:
        resolved = resolve_best_effort(expand_and_validate(raw))
    except ValueError as exc:
        raise ValueError("invalid_config_dir") from exc
    # 底線防呆（ADR-0001）：resolved 是 home 本身或 home 的祖先（含 /）時，
    # containment root 大到形同不設防——必然是設錯，直接擋。
    if is_within_root(str(Path.home().resolve()), resolved):
        raise ValueError("unsafe_config_dir")
    return resolved


def build_account_graph(
    accounts: dict[str, dict[str, str]],
    source_key: str,
    target_keys: list[str],
) -> AccountGraph:
    """建立 plan/apply 的安全前提：所有 account dir 自己正規化 + 防呆驗證。

    失敗一律 raise ValueError(<判別碼>)，由 route 轉 400。"""
    if not target_keys:
        raise ValueError("empty_targets")
    if source_key in target_keys:
        raise ValueError("source_in_targets")
    source_dir = _resolved_config_dir(accounts, source_key)
    targets: dict[str, str] = {}
    seen: set[str] = set()
    for key in target_keys:
        resolved = _resolved_config_dir(accounts, key)
        # key 不同不代表目錄不同（symlink 別名、尾斜線）。target==source 時備份動作會
        # 改名 source 自己的目錄，再連成 broken link——必須在建 graph 就擋死。
        if resolved == source_dir:
            raise ValueError("target_equals_source")
        # 祖先／子孫重疊一樣有破壞性：source 在 target 之下時 target_path 會正好是
        # source 自己（備份把 source dir 改名）；target 在 source 之下時會在 source
        # 內建連結指回其父目錄（污染 source、可成環）。
        if is_within_root(resolved, source_dir) or is_within_root(source_dir, resolved):
            raise ValueError("overlapping_account_dirs")
        if resolved in seen:
            raise ValueError("duplicate_target")
        # target 彼此巢狀是同一族破壞，只是發生在 target 側：外層 target 的 entry 路徑
        # 可能正好是內層 target 的整個 config_dir，備份會把內層帳號目錄改名。
        # 精確相同已由 duplicate_target 先擋，故此處只會命中真正的祖先／子孫關係。
        if any(is_within_root(resolved, other) or is_within_root(other, resolved) for other in seen):
            raise ValueError("overlapping_account_dirs")
        seen.add(resolved)
        targets[key] = resolved
    return AccountGraph(source_key=source_key, source_dir=source_dir, targets=targets)


EntryState = Literal[
    "ok", "wrong_link", "broken_link", "real_file", "real_dir", "empty_dir",
    "content_differs", "unexpected_type", "missing", "source_missing", "source_unsupported",
]
EntryAction = Literal[
    "skip", "create_link", "relink", "copy", "backup_and_link", "backup_and_copy",
]

# 狀態 → (動作, 是否破壞既有內容)。needs_overwrite=True 者 apply 時必須在 overwrite 清單。
# wrong_link/broken_link 重指向不損失資料（原目標檔案還在），故不需授權。
# **不含 missing**——它是唯一「同一 state 在不同 share 需要不同 action」的狀態，見
# _action_for。其他跨 share 都可能出現的狀態（ok / source_missing / source_unsupported）
# 兩種 share 下動作相同，其餘則天然只在單一 share 出現（wrong_link 只可能是 symlink
# 項、content_differs 只可能是 copy 項）。
_ACTION_BY_STATE: dict[EntryState, tuple[EntryAction, bool]] = {
    "source_missing": ("skip", False),
    "source_unsupported": ("skip", False),
    "ok": ("skip", False),
    "empty_dir": ("create_link", False),   # 空目錄 rmdir 後直接連，不必備份
    "wrong_link": ("relink", False),
    "broken_link": ("relink", False),
    "real_file": ("backup_and_link", True),
    "real_dir": ("backup_and_link", True),
    "content_differs": ("backup_and_copy", True),
    "unexpected_type": ("backup_and_copy", True),
}


def _action_for(state: EntryState, share: ShareKind) -> tuple[EntryAction, bool]:
    """狀態＋share → (動作, 是否需授權)。target 不存在時，copy 項要複製而不是建連結
    ——只看 state 會把 CLAUDE.md 錯建成 symlink。"""
    if state == "missing":
        return ("copy", False) if share == "copy" else ("create_link", False)
    return _ACTION_BY_STATE[state]


@dataclass(frozen=True)
class Operation:
    account: str        # target account key
    entry: str
    target_path: str
    state: EntryState
    action: EntryAction
    needs_overwrite: bool


@dataclass(frozen=True)
class Plan:
    source_dir: str
    targets: dict[str, str]
    operations: list[Operation]


def _same_link_target(link_path: str, source_entry: str, source_dir: str) -> bool:
    """既有 symlink 是否已指向 source entry。先字面比對（我們自己建的樣子），
    不等再比 realpath——使用者用相對路徑等等價寫法建的連結不該被判成錯而無謂重建。"""
    if os.readlink(link_path) == source_entry:
        return True
    real_link = os.path.realpath(link_path)
    if real_link != os.path.realpath(source_entry):
        return False
    # realpath 相等還不夠：source entry 自己是 symlink 指到帳號目錄外時，「繞過 source
    # 帳號目錄直接連向同一實體目標」的連結也會 realpath 相等。plan 明訂連字面路徑、不追
    # 鏈以維持「連結目標限另一登記帳號」，故這種連結判 wrong_link 交給 relink 改正。
    return is_within_root(real_link, os.path.realpath(source_dir))


def _source_state(source_entry: str, share: ShareKind) -> EntryState | None:
    """source 側的前置檢查。回非 None 表示這個 entry 根本無法處理——必須在
    「備份 target」之前就判出來，否則會把使用者的 live 檔搬走卻放不回任何東西。"""
    if not os.path.lexists(source_entry):
        return "source_missing"      # 只同步現有內容，不替使用者發明目錄
    if share == "copy" and not os.path.isfile(source_entry):
        return "source_unsupported"  # 目錄或 broken symlink：read_bytes 必然拋錯
    if share == "symlink" and not os.path.exists(source_entry):
        return "source_unsupported"  # broken source：連過去只會在 target 製造 broken link
    return None


def probe_entry(source_dir: str, target_dir: str, spec: EntrySpec) -> EntryState:
    """以 lstat/lexists（**不 follow**）判 target 的實際型別。純探測，無副作用。"""
    source_entry = os.path.join(source_dir, spec.name)
    blocked = _source_state(source_entry, spec.share)
    if blocked is not None:
        return blocked
    target_entry = os.path.join(target_dir, spec.name)
    if not os.path.lexists(target_entry):
        return "missing"
    if os.path.islink(target_entry):
        if spec.share == "copy":
            return "unexpected_type"  # copy 項是 symlink＝非預期型別，備份後改實體檔
        if not os.path.exists(target_entry):
            return "broken_link"
        return "ok" if _same_link_target(target_entry, source_entry, source_dir) else "wrong_link"
    if spec.share == "copy":
        if not os.path.isfile(target_entry):
            return "unexpected_type"  # 同名目錄
        try:
            same = Path(target_entry).read_bytes() == Path(source_entry).read_bytes()
        except OSError:
            return "content_differs"  # 讀不到就當不同，交給 overwrite gate 把關
        return "ok" if same else "content_differs"
    if os.path.isdir(target_entry):
        return "empty_dir" if not os.listdir(target_entry) else "real_dir"
    return "real_file"


def plan(graph: AccountGraph, selected_entries: list[str]) -> Plan:
    """對每個 (target, entry) 探測狀態並決定動作。除 lstat 探測外無副作用。"""
    specs: list[EntrySpec] = []
    for name in selected_entries:
        spec = _SPEC_BY_NAME.get(name)
        if spec is None:
            raise ValueError("unknown_entry")   # 前端只能傳 allowlist 內的名字
        specs.append(spec)

    operations: list[Operation] = []
    for account_key, target_dir in graph.targets.items():
        for spec in specs:
            target_path = os.path.join(target_dir, spec.name)
            # entry name 來自 allowlist（無分隔符），仍驗一次 containment 讓不變式顯式成立
            if not is_within_root(target_path, target_dir):
                raise ValueError("unknown_entry")
            state = probe_entry(graph.source_dir, target_dir, spec)
            action, needs_overwrite = _action_for(state, spec.share)
            operations.append(Operation(
                account=account_key,
                entry=spec.name,
                target_path=target_path,
                state=state,
                action=action,
                needs_overwrite=needs_overwrite,
            ))
    return Plan(source_dir=graph.source_dir, targets=dict(graph.targets), operations=operations)

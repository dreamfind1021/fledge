"""雙帳號共通設置：把 source account 的設定項以 symlink／copy 同步到 target account。

角色術語（見 CONTEXT.md）：source account＝實體檔持有者；target account＝建連結者。
`canonical` 一詞在本模組只指路徑正規化，不指帳號角色。

安全權威留在模組內：不接受 caller 宣稱「已 canonical」的路徑，
所有 account dir 一律自己 expand→absolute→resolve 後才使用。
"""
from __future__ import annotations

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

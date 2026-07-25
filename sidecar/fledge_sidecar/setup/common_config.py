"""雙帳號共通設置：把 source account 的設定項以 symlink／copy 同步到 target account。

角色術語（見 CONTEXT.md）：source account＝實體檔持有者；target account＝建連結者。
`canonical` 一詞在本模組只指路徑正規化，不指帳號角色。

安全權威留在模組內：不接受 caller 宣稱「已 canonical」的路徑，
所有 account dir 一律自己 expand→absolute→resolve 後才使用。
"""
from __future__ import annotations

import contextlib
import os
import time
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


def _dir_identity(path: str) -> tuple[int, int] | None:
    """目錄的真實身分 (st_dev, st_ino)；不存在或讀不到回 None。

    字串比對不足以判斷「是不是同一個目錄」：macOS 的 APFS 預設不分大小寫，
    `~/.claude` 與 `~/.CLAUDE` 是同一個目錄，但 `Path.resolve()` 不做大小寫正規化，
    兩者 resolve 完仍是不同字串。"""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_dev, st.st_ino)


def _same_dir(a: str, b: str) -> bool:
    """兩個路徑是否指向同一個目錄。字串相等涵蓋尚不存在的目錄，inode 身分涵蓋
    大小寫別名等字串看不出來的同一目錄。"""
    if a == b:
        return True
    identity = _dir_identity(a)
    return identity is not None and identity == _dir_identity(b)


def _is_same_or_within(inner: str, outer: str) -> bool:
    """inner 是否等於 outer 或落在其下。先字串比對（涵蓋尚不存在的目錄），
    不中再以 inode 身分逐層上溯——大小寫別名的巢狀關係字串同樣看不出來。"""
    if is_within_root(inner, outer):
        return True
    outer_id = _dir_identity(outer)
    if outer_id is None:
        return False
    current = inner
    while True:
        if _dir_identity(current) == outer_id:
            return True
        parent = os.path.dirname(current)
        if parent == current:      # 上溯到根仍未命中
            return False
        current = parent


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
    if _is_same_or_within(str(Path.home().resolve()), resolved):
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
        # key 不同不代表目錄不同（symlink 別名、尾斜線、APFS 大小寫別名）。target==source
        # 時備份動作會改名 source 自己的目錄，再連成指向自己的 broken link——必須在建
        # graph 就擋死。比對走 _same_dir：純字串會被 ~/.claude vs ~/.CLAUDE 繞過。
        if _same_dir(resolved, source_dir):
            raise ValueError("target_equals_source")
        # 祖先／子孫重疊一樣有破壞性：source 在 target 之下時 target_path 會正好是
        # source 自己（備份把 source dir 改名）；target 在 source 之下時會在 source
        # 內建連結指回其父目錄（污染 source、可成環）。
        if _is_same_or_within(resolved, source_dir) or _is_same_or_within(source_dir, resolved):
            raise ValueError("overlapping_account_dirs")
        if any(_same_dir(resolved, other) for other in seen):
            raise ValueError("duplicate_target")
        # target 彼此巢狀是同一族破壞，只是發生在 target 側：外層 target 的 entry 路徑
        # 可能正好是內層 target 的整個 config_dir，備份會把內層帳號目錄改名。
        # 精確相同已由 duplicate_target 先擋，故此處只會命中真正的祖先／子孫關係。
        if any(_is_same_or_within(resolved, other) or _is_same_or_within(other, resolved)
               for other in seen):
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


Outcome = Literal["created", "relinked", "copied", "skipped", "conflict", "stale", "failed"]


@dataclass(frozen=True)
class OpResult:
    account: str
    entry: str
    outcome: Outcome
    backup_path: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class ApplyResult:
    results: list[OpResult]


def _copy_file(source_entry: str, target_path: str) -> None:
    """複製實體檔。用 O_EXCL 開檔：不跟隨 symlink、也不覆蓋既有檔——
    呼叫端保證 target_path 此刻不存在（missing 或剛備份完）。"""
    data = Path(source_entry).read_bytes()
    mode = os.stat(source_entry).st_mode & 0o777      # 沿用 source 權限，不擅自放寬
    fd = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    created_ino = os.fstat(fd).st_ino
    try:
        # os.write 允許短寫（ENOSPC／EINTR 等）；忽略回傳值會靜默截斷卻仍回報 copied。
        # backup_and_copy 是「先備份受害檔再複製」，截斷等於使用者的資料只剩在備份裡。
        written = 0
        while written < len(data):
            n = os.write(fd, data[written:])
            if n <= 0:
                raise OSError("write_made_no_progress")   # 不前進；不擋就是無限迴圈
            written += n
    except BaseException:
        # 失敗時清掉這次自己建的半截檔——CLAUDE.md 是 claude 會實際讀的 live 設定，
        # 留一份截斷的在那裡比沒有更糟（原檔在備份裡，重跑會看到 missing）。
        # 比對 inode 才刪：空窗中若已被換成別的東西，不能誤刪別人的檔案。
        with contextlib.suppress(OSError):
            if os.lstat(target_path).st_ino == created_ino:
                os.unlink(target_path)
        raise
    finally:
        os.close(fd)


def _backup(path: str) -> str:
    """就地改名成 <name>.fledge-backup-<時間戳>（同目錄 rename：原子、不跨卷、仍在
    containment root 內）。撞名時加序號——rename 對檔案是靜默覆蓋，直接用會吃掉舊備份。"""
    base = f"{path}.fledge-backup-{time.strftime('%Y%m%d-%H%M%S')}"
    candidate = base
    n = 1
    while os.path.lexists(candidate):
        candidate = f"{base}-{n}"
        n += 1
    os.rename(path, candidate)
    return candidate


def _apply_one(op: Operation, source_dir: str, overwrite: set[tuple[str, str]]) -> OpResult:
    spec = _SPEC_BY_NAME[op.entry]
    target_dir = os.path.dirname(op.target_path)
    if op.action == "skip":
        return OpResult(op.account, op.entry, "skipped")

    # parent containment 重驗（spec §6.5）：target dir 是 build_account_graph resolve 過的，
    # realpath 應等於自己；被換成指向別處的 symlink 時就不等——那樣所有 mutation
    # 都會落到 account dir 外，必須停手。
    if os.path.realpath(target_dir) != target_dir:
        return OpResult(op.account, op.entry, "failed", error="target_dir_moved")

    # apply-time revalidation（spec §6.5）：dry-run→確認→apply 之間 FS 可變，
    # 每個 mutation 前重探一次，與 plan 不符就停手，不依過時 plan 覆寫。
    state = probe_entry(source_dir, target_dir, spec)
    if state != op.state:
        return OpResult(op.account, op.entry, "stale")

    # 動作與授權需求一律由剛驗過的真實狀態重算，不採信傳入 Plan 的欄位——否則宣稱
    # needs_overwrite=False 的破壞性 op 會繞過授權閘。route 也會重算 plan（ADR-0002），
    # 這是模組自己的第二道。重算後 action 可能是 skip（op 說要動、實況已無事可做）。
    action, needs_overwrite = _action_for(state, spec.share)
    if action == "skip":
        return OpResult(op.account, op.entry, "skipped")

    # 授權以 (account, entry) 為單位：裸 entry 名會讓 A 帳號的授權連帶授權 B 帳號
    if needs_overwrite and (op.account, op.entry) not in overwrite:
        return OpResult(op.account, op.entry, "conflict")

    source_entry = os.path.join(source_dir, spec.name)
    backup: str | None = None      # 備份成功但後續失敗時，仍要把備份位置回報給呼叫端
    try:
        if action == "create_link":
            if state == "empty_dir":
                os.rmdir(op.target_path)          # 只在空時成功，安全
            os.symlink(source_entry, op.target_path)
            return OpResult(op.account, op.entry, "created")
        if action == "relink":
            # 重探測到 unlink 之間仍可能被換成實體檔，直接 unlink 會誤刪未授權資料
            # （relink 的 needs_overwrite=False）。改成先隔離改名再驗型別：不是預期的
            # symlink 就還回去；位置已被重新占用時保留兩份資料，不覆蓋任何一份。
            backup = _backup(op.target_path)
            if not os.path.islink(backup):
                # 不是預期的 symlink → 還原。但空窗中 target 位置可能已冒出別的東西，
                # os.rename 會靜默覆蓋它（Python 無跨平台的 no-clobber rename），
                # 故先確認位置仍空；不空就保留隔離檔並回報位置，兩份資料都不犧牲。
                if os.path.lexists(op.target_path):
                    return OpResult(op.account, op.entry, "stale", backup_path=backup)
                os.rename(backup, op.target_path)
                return OpResult(op.account, op.entry, "stale")
            os.symlink(source_entry, op.target_path)
            os.unlink(backup)                     # 確認是 symlink 才清掉隔離檔，不留垃圾
            return OpResult(op.account, op.entry, "relinked")
        if action == "copy":
            _copy_file(source_entry, op.target_path)
            return OpResult(op.account, op.entry, "copied")
        # 以下兩個是唯一「先毀後建」的動作（已過授權閘）。備份一律在 mutate 之前，
        # 且 backup 指派到 try 外層變數——中途失敗時使用者的資料只剩備份那一份，
        # 位置沒回報等於找不回來。備份用 rename 不跟隨 symlink，不會寫穿到外部檔案。
        if action == "backup_and_link":
            backup = _backup(op.target_path)
            os.symlink(source_entry, op.target_path)
            return OpResult(op.account, op.entry, "created", backup_path=backup)
        if action == "backup_and_copy":
            backup = _backup(op.target_path)
            _copy_file(source_entry, op.target_path)
            return OpResult(op.account, op.entry, "copied", backup_path=backup)
    except OSError as exc:
        return OpResult(op.account, op.entry, "failed", backup_path=backup, error=str(exc))
    return OpResult(op.account, op.entry, "failed", error="unsupported_action")


def apply(plan: Plan, overwrite: list[tuple[str, str]]) -> ApplyResult:
    """依 plan 執行，逐項盡力——單項失敗不阻斷其餘 entry（使用者修完重跑，已完成項回 skipped）。

    `overwrite` 是被授權破壞既有內容的 `(account, entry)` pair 清單；未列的破壞性動作
    回 conflict 不動。用 pair 而非裸 entry 名，否則授權 A 帳號會連帶授權 B 帳號。"""
    allowed = {(a, e) for a, e in overwrite}
    results: list[OpResult] = []
    prepared: dict[str, str | None] = {}    # account key -> 建 target dir 的錯誤訊息（None=成功）

    for op in plan.operations:
        # op 必須確實屬於這張 graph：_apply_one 的 target_dir 是從 op.target_path 推出來的，
        # 不驗的話一個 target_path 指到別處的 op 就會讓 rename／symlink 落在未登記目錄。
        # 端點層會重算 plan（ADR-0002），但模組自為安全權威——C 的 repair 也直接呼叫本函式。
        expected_dir = plan.targets.get(op.account)
        if (expected_dir is None
                or op.entry not in _SPEC_BY_NAME
                or op.target_path != os.path.join(expected_dir, op.entry)):
            results.append(OpResult(op.account, op.entry, "failed", error="operation_not_in_graph"))
            continue
        if op.account not in prepared:
            target_dir = plan.targets[op.account]
            try:
                # 只建最後一層（parents=False）：父目錄不存在多半是路徑打錯，
                # 遞建會在錯的地方留一串垃圾目錄。
                Path(target_dir).mkdir(parents=False, exist_ok=True)
                # mkdir(exist_ok=True) 對「已被換成 symlink 的 target dir」不會報錯，
                # 故建完立刻驗一次 realpath（_apply_one 每個 op 前還會再驗）。
                if os.path.realpath(target_dir) != target_dir:
                    raise OSError("target_dir_moved")
                prepared[op.account] = None
            except OSError as exc:
                prepared[op.account] = str(exc)
        err = prepared[op.account]
        if err is not None:
            results.append(OpResult(op.account, op.entry, "failed", error=err))
            continue
        results.append(_apply_one(op, plan.source_dir, allowed))
    return ApplyResult(results=results)

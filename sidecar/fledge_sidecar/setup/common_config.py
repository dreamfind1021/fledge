"""雙帳號共通設置：把 source account 的設定項以 symlink／copy 同步到 target account。

角色術語（見 CONTEXT.md）：source account＝實體檔持有者；target account＝建連結者。
`canonical` 一詞在本模組只指路徑正規化，不指帳號角色。

安全權威留在模組內：不接受 caller 宣稱「已 canonical」的路徑，
所有 account dir 一律自己 expand→absolute→resolve 後才使用。
"""
from __future__ import annotations

import logging
import os
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fledge_sidecar.paths import (
    dir_identity,
    expand_and_validate,
    is_same_or_within,
    is_within_root,
    resolve_best_effort,
    same_dir,
)
from fledge_sidecar.setup import safe_fs

logger = logging.getLogger(__name__)

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
    # 建 graph 當下 source dir 的 (st_dev, st_ino)。apply 每次 mutation 前比對，把「驗過
    # 之後被抽換」的窗口從「使用者在 UI 上看預覽、按套用」那段時間縮到比對與 mutation 之間
    # 的幾行程式碼（票 10；**縮小不是消除**，見 _require_usable_source 的殘餘說明）。
    # source 尚不存在時是 None——那種 plan 的每個 entry 都會判成 source_missing→skip，
    # 走不到 mutation。
    source_identity: tuple[int, int] | None


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
    if is_same_or_within(str(Path.home().resolve()), resolved):
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
        # graph 就擋死。比對走 paths.same_dir：純字串會被 ~/.claude vs ~/.CLAUDE 繞過。
        if same_dir(resolved, source_dir):
            raise ValueError("target_equals_source")
        # 祖先／子孫重疊一樣有破壞性：source 在 target 之下時 target_path 會正好是
        # source 自己（備份把 source dir 改名）；target 在 source 之下時會在 source
        # 內建連結指回其父目錄（污染 source、可成環）。
        if is_same_or_within(resolved, source_dir) or is_same_or_within(source_dir, resolved):
            raise ValueError("overlapping_account_dirs")
        if any(same_dir(resolved, other) for other in seen):
            raise ValueError("duplicate_target")
        # target 彼此巢狀是同一族破壞，只是發生在 target 側：外層 target 的 entry 路徑
        # 可能正好是內層 target 的整個 config_dir，備份會把內層帳號目錄改名。
        # 精確相同已由 duplicate_target 先擋，故此處只會命中真正的祖先／子孫關係。
        if any(is_same_or_within(resolved, other) or is_same_or_within(other, resolved)
               for other in seen):
            raise ValueError("overlapping_account_dirs")
        seen.add(resolved)
        targets[key] = resolved
    return AccountGraph(source_key=source_key, source_dir=source_dir, targets=targets,
                        source_identity=dir_identity(source_dir))


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
    # 見 AccountGraph.source_identity。**刻意不給預設值**：忘了帶就是型別錯誤，
    # 而不是靜默退化成「跳過重驗」——防呆不得 fail-open。
    source_identity: tuple[int, int] | None


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
    return Plan(source_dir=graph.source_dir, targets=dict(graph.targets), operations=operations,
                source_identity=graph.source_identity)


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


def _backup(path: str) -> str:
    """就地改名成 <name>.fledge-backup-<時間戳>（同目錄 rename：原子、不跨卷、仍在
    containment root 內）。撞名時加序號——rename 對檔案是靜默覆蓋，直接用會吃掉舊備份。

    **已知殘餘風險**：序號迴圈只擋得住本 process 的連續備份。`lexists` 到 `rename`
    之間仍有 check-then-act 窗口——若另一支程式（第二個 sidecar、使用者的工具）
    在該窗口內剛好建出同名檔，`os.rename` 會靜默覆蓋它。要真正消滅需要 macOS 專屬的
    `renameatx_np(RENAME_EXCL)`（ctypes），評估後判定不值得引入平台相依碼：命中需要
    對方在毫秒級窗口內產生「同路徑＋同秒時間戳＋同序號」的檔案，遠超出本模組
    「防意外、不防已取得執行權的行為者」的威脅模型。"""
    base = f"{path}.fledge-backup-{time.strftime('%Y%m%d-%H%M%S')}"
    candidate = base
    n = 1
    while os.path.lexists(candidate):
        candidate = f"{base}-{n}"
        n += 1
    os.rename(path, candidate)
    return candidate


def _apply_one(op: Operation, source_dir: str, overwrite: set[tuple[str, str]],
               source_identity: tuple[int, int] | None) -> OpResult:
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

    # source 側的 apply-time revalidation（票 10），對稱於上面的 target 側：前置閘
    # （build_account_graph／_require_usable_source）驗過的是「當時那個目錄」，之後被改名
    # 再於同一路徑放進另一個目錄的話，我們仍會建出字面指向 source_dir/entry 的連結、回報
    # relinked，帳號實際卻導向未經 build_account_graph 驗證的內容。比 realpath 嚴：身分走
    # (st_dev, st_ino)，抽換成另一個真目錄時 realpath 仍等於自己、identity 不會。
    if dir_identity(source_dir) != source_identity:
        return OpResult(op.account, op.entry, "failed", error="source_dir_moved")

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
            safe_fs.copy_file_no_clobber(source_entry, op.target_path)
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
            safe_fs.copy_file_no_clobber(source_entry, op.target_path)
            return OpResult(op.account, op.entry, "copied", backup_path=backup)
    except OSError as exc:
        # 完整例外（含路徑與 traceback）只進 log；回給呼叫端的是穩定判別碼
        logger.error("共通設置檔案操作失敗：account=%s entry=%s action=%s backup=%s",
                     op.account, op.entry, action, backup, exc_info=True)
        return OpResult(op.account, op.entry, "failed",
                        backup_path=backup, error=safe_fs.error_code(exc))
    return OpResult(op.account, op.entry, "failed", error="unsupported_action")


def apply(plan: Plan, overwrite: list[tuple[str, str]]) -> ApplyResult:
    """依 plan 執行，逐項盡力——單項失敗不阻斷其餘 entry（使用者修完重跑，已完成項回 skipped）。

    `overwrite` 是被授權破壞既有內容的 `(account, entry)` pair 清單；未列的破壞性動作
    回 conflict 不動。用 pair 而非裸 entry 名，否則授權 A 帳號會連帶授權 B 帳號。"""
    allowed = {(a, e) for a, e in overwrite}
    results: list[OpResult] = []
    prepared: dict[str, str | None] = {}    # account key -> 建 target dir 的錯誤訊息（None=成功）
    # 破壞性操作要留伺服端稽核紀錄：使用者事後找不到 .fledge-backup-* 時 log 是唯一線索。
    # 只記路徑與判別碼，不記檔案內容。
    logger.info("共通設置 apply 開始：source=%s targets=%s ops=%d overwrite=%d",
                plan.source_dir, sorted(plan.targets), len(plan.operations), len(allowed))

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
        results.append(_apply_one(op, plan.source_dir, allowed, plan.source_identity))

    for r in results:
        # 沒做成的每一項都留一行：conflict/stale 是「刻意沒動」，failed 另有 ERROR 帶 traceback
        if r.outcome in {"conflict", "stale", "failed"}:
            logger.warning("共通設置 %s：account=%s entry=%s error=%s backup=%s",
                           r.outcome, r.account, r.entry, r.error, r.backup_path)
        elif r.backup_path:
            logger.info("共通設置 %s：account=%s entry=%s 既有內容已備份至 %s",
                        r.outcome, r.account, r.entry, r.backup_path)
    logger.info("共通設置 apply 完成：%s", dict(Counter(r.outcome for r in results)))
    return ApplyResult(results=results)


# repair 只處理 broken_link——目標不存在的連結，移機／還原的典型症狀。
# **wrong_link 刻意不在範圍內**：它只代表「沒指向目前的 source entry」，分不出「備份帶回的
# 舊機連結」與「使用者刻意指到別處、目前仍然有效的設置」；而 relink 的 needs_overwrite=False，
# 收進來就等於免授權改寫後者（spec §6.5 原文亦只寫 broken-link）。那類連結交給共通設置卡的
# apply——使用者在那裡看得到逐項狀態才按套用，等於人工授權。日後若還原流程能提供舊 source
# root 當 provenance（精確比對 os.readlink 而非只看「不等於現在的 source」），才有依據把它
# 收進自動修復。其餘狀態同樣不動：missing 沒有連結可修；real_file／content_differs 要
# overwrite 授權，那是 apply 的職責。
_REPAIRABLE_STATE: EntryState = "broken_link"


def _require_usable_source(source_dir: str) -> None:
    """repair 的前提：source 帳號目錄此刻真的在、真的是目錄、真的讀得出內容。

    不成立就整批停手（ValueError(<判別碼>)，比照 build_account_graph 的慣例）。逐項回
    「source_missing 已跳過」只是把同一個原因講六遍，使用者看不出該去修什麼。停手也是安全
    面的必要：拿不存在的 source 去重建連結，只會把斷鏈換成另一條斷鏈。

    本閘只跑一次，但**驗過的身分有綁進後續每次 mutation**（票 10）：`_apply_one` 動手前比對
    `Plan.source_identity`，本函式回傳之後才被改名、再於同一路徑放進別的目錄的 source，會判
    `source_dir_moved` 停手——否則重建出來的連結（字面仍是 `source_dir/entry`）就會解析到那份
    未經 `build_account_graph` 驗證的內容。

    **殘餘（與 target 側同一等級，Codex 對抗式審查 R1 覆核過）**：identity 比對到實際 mutation
    之間仍是 check-then-act，五個 mutation 分支都在比對之後才以**路徑**動手。所以本機制是把窗口
    從「使用者看預覽、按下套用」那段時間縮到幾行程式碼，**不是消除它**——別在別處寫成「已關閉
    TOCTOU」。

    要連那幾行的窗口都消滅：`copy` 分支可行（改以已驗證的 dir fd `openat` 讀 source），但
    symlink 分支不行——`os.symlink` 存的是字面路徑、解析時根本不經 fd。本模組六個 entry 有
    五個是 symlink 項，封住一個分支換來兩套並存的機制，判定不划算（票 10 使用者裁示）。"""
    if not os.path.lexists(source_dir):
        raise ValueError("source_dir_missing")
    if not os.path.isdir(source_dir):
        raise ValueError("source_dir_unusable")     # 實體檔、斷鏈、symlink 迴圈
    # source_dir 是 build_account_graph resolve 過的，realpath 應等於自己；被換成指向
    # 別處的 symlink 時 isdir 仍為真，但已不是 plan 驗過的那個目錄——那樣重建出來的連結
    # 會指進一個沒經過正規化與防呆的目錄。
    if os.path.realpath(source_dir) != source_dir:
        raise ValueError("source_dir_unusable")
    try:
        os.listdir(source_dir)      # 實際讀一次，不用 os.access 預測權限
    except OSError as exc:
        # 整個 repair 就此中止＝功能失敗，比照 _apply_one 的 OSError 用 ERROR 帶 traceback
        logger.error("共通設置 repair 前提不成立：source=%s 讀不到", source_dir, exc_info=True)
        raise ValueError("source_dir_unusable") from exc


def repair(plan: Plan) -> ApplyResult:
    """C（移機還原）專用：拿同一份 entry allowlist 重新指向**這台機器**的 source dir。

    備份包存的是連結本身而不是它指向的內容，所以還原後 target 帳號的連結全指著舊機器的
    絕對路徑（`/Users/<舊使用者>/.claude/...`）。修法不是把舊指向抄過來，而是重建成本機的
    source entry——`plan` 的 target_path 與 state 都是在這台機器上探測出來的，本函式只做
    「哪些該修」的取捨：**只有 `broken_link` 會被重建**，理由見 `_REPAIRABLE_STATE`。

    **只碰 allowlist 上的名字**：不在清單內的斷鏈可能是使用者自建，我們沒有立場替他決定該
    指去哪；那些 entry 根本不會進 plan，故連判斷都不需要。實際的檔案操作委派 `apply`
    （overwrite 給空清單），以繼承它的 apply-time 重探測、parent containment 重驗與
    op-in-graph 檢查——repair 不另開一條破壞性路徑。

    傳入的 Plan 必須來自 `plan()`＋`build_account_graph()`：安全前提（正規化、containment）
    建立在那兩支，本函式不重新推導。

    source 帳號目錄不存在或不可用時 raise ValueError(<判別碼>)，不回半套結果。
    """
    _require_usable_source(plan.source_dir)
    # 一趟走完：待修的挑出來，其餘先佔位成 skipped（每個 entry 都要有一行回報）
    results: list[OpResult] = []
    repairable: list[Operation] = []
    slots: list[int] = []          # 待修項在 results 裡的位置
    for op in plan.operations:
        if op.state == _REPAIRABLE_STATE:
            slots.append(len(results))
            repairable.append(op)
        results.append(OpResult(op.account, op.entry, "skipped"))

    logger.info("共通設置 repair 開始：source=%s targets=%s 待修=%d/%d",
                plan.source_dir, sorted(plan.targets), len(repairable), len(plan.operations))
    if repairable:
        subset = Plan(source_dir=plan.source_dir, targets=dict(plan.targets),
                      operations=repairable, source_identity=plan.source_identity)
        outcomes = apply(subset, overwrite=[]).results
        # apply 對每個 op 恰好回一筆結果且保序，故按位置放回。不用 (account, entry) 當 key
        # 對回去——selected_entries 含重複名字時會有同 key 的多筆 op，字典會吃掉其中一筆；
        # strict=True 讓那個 1:1 假設是被檢查的，而不是被相信的。
        for index, outcome in zip(slots, outcomes, strict=True):
            results[index] = outcome
    return ApplyResult(results=results)

"""移機：把展開目錄（staging）的資產寫進新機的現役目錄。

**本模組是唯一有能力寫現役目錄的還原路徑。** `backup/restore.py` 維持零寫入能力
（那是票 09 的結構性不變式），本模組是它的下一步而非同義詞——術語見 CONTEXT.md 的
migration／restore 分界。

安全權威留在模組內：不接受 caller 宣稱已驗證的落點，所有 config_dir 一律自己
expand→absolute→resolve 後才使用（比照 common_config）。備份包的內容**一律是不可信
輸入**——manifest 只能描述來源，不能授權目的地（spec §4.2.2）。
"""
from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import logging
import os
import re
import stat as stat_module
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

Outcome = Literal["installed", "skipped", "excluded", "failed"]

# 明確不處理的頂層項目。`.claude.json` 同一個檔案裡混著真資產（projects 的權限清單、
# mcpServers）、機器身分（oauthAccount、machineID）與純快取（cachedGrowthBookFeatures
# 442 項）——整份搬會蓋掉新機剛登入好的狀態，整份不搬只是要重新累積，後者代價小得多。
EXCLUDED_NAMES: frozenset[str] = frozenset({".claude.json"})

MANIFEST_NAME = "manifest.json"

# account key 會被拼進 Path(root, "accounts", key) 與 fd-relative open：絕對 key 讓 Path
# 丟棄 root、`..` 走出 staging、絕對路徑更會讓 os.open 直接忽略 dir_fd。manifest 是不可信
# 輸入、config 的 accounts 也可能被手動編輯——**在本模組的信任邊界重驗**，不依賴新增帳號
# API 的擋法（routes/config.py 的 _KEY_RE 同一規則）。
_SAFE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True)
class ItemResult:
    account: str        # target account key，extra 項用 "" 表示不屬於任何帳號
    rel_path: str       # 相對該落點的路徑
    outcome: Outcome
    error: str | None = None      # 穩定判別碼；完整例外只進 log


@dataclass(frozen=True)
class InstallPlan:
    source_root: str                        # 展開目錄（resolved）
    source_identity: tuple[int, int] | None  # 建 plan 當下的身分，install 前重驗
    targets: dict[str, str]                 # account key -> resolved config_dir
    # target 側的 plan 時身分（票 03 R1，比照 source_identity）：install 開出 fd 後
    # fstat 比對。None＝plan 時不存在（全新機器的主流情境）、由 install 新建，沒有
    # 基準可比——那條窗口是殘餘，記錄於票 03。
    target_identities: dict[str, tuple[int, int] | None]
    extra_targets: dict[str, str]           # extra 項名 -> resolved 落點
    will_install: int
    will_skip: list[str]
    # 目的地祖先被非目錄（一般檔或 symlink）占用的葉檔：install 只會在目錄層 fail、
    # 這些葉檔根本到不了，算進 will_install 就是預覽說謊（Codex 票 03 R2）。
    blocked: list[str]
    excluded: list[str]


def _resolved_config_dir(raw: str) -> str:
    """落點正規化 + 底線防呆。失敗一律 ValueError(<判別碼>)，由 route 轉 400。"""
    try:
        resolved = resolve_best_effort(expand_and_validate((raw or "").strip()))
    except ValueError as exc:
        raise ValueError("invalid_config_dir") from exc
    # ADR-0001：resolved 是 home 本身或其祖先（含 /）時 containment root 大到形同不設防
    if is_same_or_within(str(Path.home().resolve()), resolved):
        raise ValueError("unsafe_config_dir")
    return resolved


def read_manifest(source_root: str) -> dict:
    """讀展開目錄的 manifest。讀不到或不是物件 → source_not_a_bundle。

    **來源的解讀權留在模組內**：不讓 caller 傳進 manifest 內容，否則「不可信輸入」的
    邊界就跑到模組外面了。"""
    try:
        data = json.loads(Path(source_root, MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("source_not_a_bundle") from exc
    if not isinstance(data, dict):
        raise ValueError("source_not_a_bundle")
    # accounts 是後續所有迭代與拼路徑的基礎——不是 mapping（null／list／string）的話，
    # 會在 plan 內變成未捕捉的 TypeError 穿出去成裸 500，違反 error-code 合約。
    if not isinstance(data.get("accounts"), dict):
        raise ValueError("source_not_a_bundle")
    return data


def _walk_account(account_dir: Path) -> tuple[list[str], list[str]]:
    """回 (可安裝的相對路徑, 被排除的名字)。純掃描，不寫任何東西。

    **不跟隨 symlink**：`os.walk` 的 followlinks 預設就是 False，但這裡顯式寫出來——
    備份包裡一個指向 `/` 的目錄連結就能讓遞迴走出展開目錄。

    **只數 lstat 為一般檔的項目**：`os.walk` 會把 file symlink（含斷鏈）與特殊檔都放進
    filenames，而 install 的 scandir 路徑對 symlink 是第二階段（票 04）、對特殊檔是
    excluded——plan 照單全收的話，預覽數字會穩定大於實際結果（Codex 票 03 R1 的
    walk／scandir 語意分歧）。"""
    installable: list[str] = []
    excluded: list[str] = []
    for dirpath, dirnames, filenames in os.walk(account_dir, followlinks=False):
        rel_dir = os.path.relpath(dirpath, account_dir)
        for name in list(dirnames) + filenames:
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            top = rel.split(os.sep, 1)[0]
            if top in EXCLUDED_NAMES:
                if rel == top:
                    excluded.append(rel)
                continue
            if name in filenames:
                st = os.lstat(os.path.join(dirpath, name))
                if stat_module.S_ISREG(st.st_mode):
                    installable.append(rel)
    return installable, excluded


def plan(source_root: str, accounts: dict[str, dict[str, str]]) -> InstallPlan:
    """掃描展開目錄與各落點，回「會裝什麼、會跳過什麼、不處理什麼」。純唯讀。"""
    root = resolve_best_effort(source_root)
    manifest = read_manifest(root)          # 順便驗它確實是我們展開的目錄
    # 實體 accounts/ 目錄也是 bundle 形狀的一部分：缺了它 plan 會回一份空預覽、install
    # 卻在 _open_dir_pinned("accounts") 拋 OSError 穿出去——預覽與執行要同一判準。
    # lstat 判型（不跟隨）：accounts 是 symlink 時 install 的 O_NOFOLLOW 也會拒開。
    try:
        accounts_st = os.lstat(os.path.join(root, "accounts"))
    except OSError as exc:
        raise ValueError("source_not_a_bundle") from exc
    if not stat_module.S_ISDIR(accounts_st.st_mode):
        raise ValueError("source_not_a_bundle")

    targets: dict[str, str] = {}
    for key in manifest.get("accounts", {}):
        entry = accounts.get(key)
        if entry is None:
            continue                        # 使用者沒為這個帳號指定落點 → 不裝
        if not _SAFE_KEY_RE.fullmatch(key):
            raise ValueError("invalid_account_key")   # 進得了 targets 的 key 才會拼路徑
        targets[key] = _resolved_config_dir(entry.get("config_dir", ""))

    will_install = 0
    will_skip: list[str] = []
    blocked: list[str] = []
    excluded: list[str] = []
    for key, target in targets.items():
        account_dir = Path(root, "accounts", key)
        if not account_dir.is_dir():
            continue
        installable, ex = _walk_account(account_dir)
        excluded.extend(ex)
        # 目的地祖先鏈逐層 lstat（與 install 的 O_NOFOLLOW 同語意：symlink 也算占用）。
        # 快取按相對前綴——同一子樹的葉檔不必重複探測。
        blocked_dirs: set[str] = set()
        ok_dirs: set[str] = set()
        for rel in installable:
            parent = os.path.dirname(rel)
            bad = False
            cur = ""
            for part in parent.split(os.sep) if parent else []:
                cur = os.path.join(cur, part) if cur else part
                if cur in blocked_dirs:
                    bad = True
                    break
                if cur in ok_dirs:
                    continue
                try:
                    st = os.lstat(os.path.join(target, cur))
                except FileNotFoundError:
                    ok_dirs.add(cur)        # 不存在 → install 會自己建
                    continue
                except OSError:
                    blocked_dirs.add(cur)   # 探測不了就 fail-closed 當占用，不虛報
                    bad = True
                    break
                if stat_module.S_ISDIR(st.st_mode):
                    ok_dirs.add(cur)
                else:
                    blocked_dirs.add(cur)
                    bad = True
                    break
            if bad:
                blocked.append(rel)
            elif os.path.lexists(os.path.join(target, rel)):
                will_skip.append(rel)
            else:
                will_install += 1

    return InstallPlan(
        source_root=root,
        source_identity=dir_identity(root),
        targets=targets,
        target_identities={key: dir_identity(t) for key, t in targets.items()},
        extra_targets={},                   # 票 05（extra 資產）填
        will_install=will_install,
        will_skip=will_skip,
        blocked=blocked,
        excluded=excluded,
    )


_JOURNAL_PREFIX = "restore-journal-"


def transaction_id(plan: InstallPlan) -> str:
    """同一個實體 staging + 同一組落點 = 同一個 transaction，重跑才接得上前一輪。

    **不能只綁 source_root 路徑**（Codex 票 04 R1）：同一路徑失敗後換一份 bundle 重展、
    或改落點重跑，都會讀到前次殘留的 journal node——journal 記的是「本次發布的 node」，
    跨 bundle／落點沿用等於把舊 provenance 拿來授權新落點的既有內容，推翻整個判準。
    所以綁 `source_identity`（實體 inode，重展即變）＋落點 mapping：三者任一變就是新
    transaction，舊 journal 不被讀。用雜湊：路徑含使用者名與中文，直接當檔名會跳脫問題。"""
    material = "\x00".join([
        plan.source_root,
        repr(plan.source_identity),
        repr(sorted(plan.targets.items())),
    ])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def journal_path(transaction_id: str) -> Path:
    """放 ~/.fledge/：不放 staging（唯讀不變式），不放現役目錄（使用者的，不該被
    我們的簿記污染）。它同時是「這次移機還沒收尾」的訊號（ADR-0006）。"""
    return Path.home() / ".fledge" / f"{_JOURNAL_PREFIX}{transaction_id}.jsonl"


def installed_nodes(transaction_id: str) -> set[str]:
    """本 transaction 已確實發布的 node（`<account>/<rel_path>`）。

    **不存在 → 回空集合**（還沒建、或完整成功已清，都是正常）；**存在但讀不出**（權限、
    IO 錯）→ 讓 OSError 往上拋。兩者不可混為一談（Codex 票 04 R1 F3）：把 IO 錯誤當成
    「沒發布過」會讓 symlink 階段靜默略過、清除 gate 又誤判完整成功刪掉續作依據。
    壞行（JSON parse 失敗）仍逐行跳過——那是損壞容錯，與整檔讀不出是兩回事。"""
    path = journal_path(transaction_id)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return set()
    nodes: set[str] = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue                        # 壞行跳過：簿記損壞不該讓移機整個失敗
        node = entry.get("node") if isinstance(entry, dict) else None
        if isinstance(node, str):
            nodes.add(node)
    return nodes


def _open_journal_fd(journal: Path) -> int:
    """fd-relative 開 journal，全程 `O_NOFOLLOW`：`~/.fledge` 或 journal 本身被換成 symlink
    時拒絕跟隨——否則 `_record` 會把 JSONL append 到 symlink 指向的任意使用者檔案（Codex
    票 04 R2 F1）。開好 `fstat` 確認是一般檔。從 home fd 逐層下去，O_NOFOLLOW 只擋最後
    元件、父目錄那層要靠 fd-relative 才 pin 得住。"""
    home_fd = os.open(str(Path.home()), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir(".fledge", 0o700, dir_fd=home_fd)
        except FileExistsError:
            pass
        fledge_fd = _open_dir_pinned(".fledge", dir_fd=home_fd)
    finally:
        os.close(home_fd)
    try:
        fd = os.open(journal.name, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
                     0o600, dir_fd=fledge_fd)
    finally:
        os.close(fledge_fd)
    st = os.fstat(fd)
    if not stat_module.S_ISREG(st.st_mode):
        os.close(fd)
        raise OSError(errno.EINVAL, "journal is not a regular file")
    return fd


def _record(fd: int, account: str, rel_path: str) -> None:
    """append 一筆並 fsync。

    **順序是「發布成功 → 記錄」，不是 intent-first 的 WAL**：先記「打算裝 X」但實際被
    EEXIST 跳過的話，重跑會把使用者原本就有的 X 誤認成我們裝的——那正是這份簿記要擋的
    東西。代價是 link 與 fsync 之間有極小窗口，崩在那裡的 node 重跑時不被認作本次發布、
    依賴它的 symlink 補不回來。**刻意選的保守方向**：寧可少建一條連結，也不冒認。"""
    line = json.dumps({"node": f"{account}/{rel_path}"}, ensure_ascii=False) + "\n"
    os.write(fd, line.encode("utf-8"))
    os.fsync(fd)


@dataclass
class _PendingLink:
    account: str
    rel_path: str
    literal_target: str


def _open_dir_pinned(name: str, *, dir_fd: int | None = None) -> int:
    """從父 fd 開出子目錄，不跟隨 symlink。開失敗一律讓 OSError 往上拋。

    `O_NOFOLLOW` 讓「這一層是 symlink」直接失敗（macOS 回 ENOTDIR），所以整條路徑上
    沒有任何一層是我們沒看見就跟過去的。"""
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def _require_source_identity(plan: InstallPlan) -> int:
    """開出 staging root fd 並確認它就是 plan 驗過的那個目錄。回 fd，呼叫端負責關。

    **先 open 再 fstat**（順序不能顛倒）：先以 pathname 重驗再 open 的話，中間仍有窗口
    讓 root 被改名再換上另一個同型別目錄——`O_NOFOLLOW` 只拒絕最後元件是 symlink，
    不證明開到的是原 inode。要證明身分，只能對已經開啟的 fd 做 fstat。"""
    fd = _open_dir_pinned(plan.source_root)
    st = os.fstat(fd)
    if (st.st_dev, st.st_ino) != plan.source_identity:
        os.close(fd)
        raise ValueError("source_root_moved")
    return fd


def _read_file_pinned(name: str, dir_fd: int) -> bytes:
    """以 dir_fd 開檔後 fstat 確認型別才讀——不用 pathname 重新解析。

    判型與讀取之間若還經過一次名稱解析，那一刻被換成 symlink 就會讀到 staging 外的檔案。

    `O_NONBLOCK`：scandir 判型之後、open 之前被換成 FIFO 的話，O_RDONLY 會阻塞到有
    writer 為止——加了它 open 立即返回，fstat 照樣把非一般檔擋下（對一般檔是 no-op）。"""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    try:
        st = os.fstat(fd)
        if not stat_module.S_ISREG(st.st_mode):
            raise OSError(errno.EINVAL, "not a regular file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def _install_tree(src_fd: int, dst_fd: int, account: str, rel_prefix: str,
                  results: list[ItemResult], journal_fd: int,
                  pending: list[_PendingLink]) -> None:
    """遞迴安裝一層。symlink 收集起來延到第二階段（票 04：過 provenance 授權才建）。"""
    for entry in os.scandir(src_fd):
        rel = os.path.join(rel_prefix, entry.name) if rel_prefix else entry.name
        if entry.name in EXCLUDED_NAMES and not rel_prefix:
            results.append(ItemResult(account, rel, "excluded", "not_migrated_by_design"))
            continue
        if entry.is_symlink():
            # 延到第一階段全部發布完才建，且判準是 provenance（見 _publish_links）。
            pending.append(_PendingLink(account, rel, os.readlink(entry.name, dir_fd=src_fd)))
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                child_src = _open_dir_pinned(entry.name, dir_fd=src_fd)
                try:
                    # 目標目錄不存在才建；已存在不算衝突（目錄本身沒有內容會被覆蓋）。
                    # **只有本次新建的目錄才記進 journal**：symlink 常指向目錄（共通設置
                    # 的 commands／plugins），授權判準要認得出「這個目錄是我們裝的」；
                    # 已存在的目錄是使用者的，記了就等於讓 symlink 能指向現役內容（R4）。
                    try:
                        os.mkdir(entry.name, 0o700, dir_fd=dst_fd)
                        _record(journal_fd, account, rel)
                    except FileExistsError:
                        pass
                    child_dst = _open_dir_pinned(entry.name, dir_fd=dst_fd)
                    try:
                        _install_tree(child_src, child_dst, account, rel, results,
                                      journal_fd, pending)
                        # durability：link／unlink 的目錄項在斷電後不保證持久，光 fsync
                        # 檔案不夠。粒度取「每個目錄一次」而非每檔兩次——一次還原可能
                        # 上千個小檔，後者成本過高（spec §4.2.5）。
                        with contextlib.suppress(OSError):
                            os.fsync(child_dst)
                    finally:
                        os.close(child_dst)
                finally:
                    os.close(child_src)
                continue
            if not entry.is_file(follow_symlinks=False):
                # 特殊檔（FIFO／socket／device）連 open 都不碰——FIFO 一開就阻塞。
                # plan 的 _walk_account 同樣不數它們，兩邊語意才對得上。
                results.append(ItemResult(account, rel, "excluded", "not_a_regular_file"))
                continue
            data = _read_file_pinned(entry.name, src_fd)
            safe_fs.write_bytes_atomic(data, entry.name, dir_fd=dst_fd,
                                       mode=entry.stat(follow_symlinks=False).st_mode & 0o777)
            _record(journal_fd, account, rel)   # 發布成功才記（不是 intent-first）
            results.append(ItemResult(account, rel, "installed"))
        except FileExistsError:
            results.append(ItemResult(account, rel, "skipped"))
        except OSError as exc:
            logger.error("移機寫入失敗：account=%s rel=%s", account, rel, exc_info=True)
            results.append(ItemResult(account, rel, "failed", safe_fs.error_code(exc)))


def _rewrite_home_prefix(path: str, old_home: str, new_home: str) -> str | None:
    """舊 home 底下的路徑換成新 home 的同一相對位置；不在舊 home 底下回 None。

    回 None 代表「無法決定新位置」——ADR-0001 允許 config_dir 是任意路徑，所以沒有
    正確答案可推。**不猜**。"""
    if path == old_home:
        return new_home
    prefix = old_home.rstrip("/") + "/"
    if not path.startswith(prefix):
        return None
    return os.path.join(new_home, path[len(prefix):])


def _authorized_link_target(literal: str, plan: InstallPlan, manifest: dict,
                            installed: set[str]) -> str | None:
    """symlink 的字面目標 → 改寫後的目標路徑；不獲授權回 None。

    授權判準是「對應本次 transaction 確實發布的 node」，**不是 root containment**：
    後者會放行指向 root 內任意既有檔案、root 本身乃至循環的連結，等於把「連回已還原
    的資產」放大成「連到整棵 active config tree 任意位置」（spec §4.2.3）。"""
    # 相對路徑（往上逃逸）與含 `..`／非正規化的絕對路徑一律不處理——不靠「改寫後對不上
    # node」的巧合擋，直接在源頭 fail closed。
    if not os.path.isabs(literal) or os.path.normpath(literal) != literal:
        return None
    old_home = manifest.get("home", "")
    new_home = str(Path.home().resolve())
    rewritten = _rewrite_home_prefix(literal, old_home, new_home) if old_home else None
    if rewritten is None:
        return None
    for key, target in plan.targets.items():
        if rewritten == target or not is_same_or_within(rewritten, target):
            continue                        # 指向 root 本身也不算（那不是某個 node）
        rel = os.path.relpath(rewritten, target)
        if f"{key}/{rel}" in installed:
            return rewritten
    return None


def _symlink_at(root_fd: int, rel_path: str, target: str) -> None:
    """從 root_fd 逐層 `O_NOFOLLOW` 開到父目錄，再 `os.symlink(dir_fd=父)`。

    **全程不重解析完整 pathname**（Codex 票 04 R1 F2）：第二階段若用
    `plan.targets[account]/rel_path` 這種絕對路徑，target root 或中間目錄在階段間被
    rename＋換成 symlink，`os.symlink` 會跟著中間元件寫到 target 外。root_fd 是第一階段
    驗過身分的 fd（釘 inode，rename 影響不到），逐層 O_NOFOLLOW 讓任一層被換成 symlink
    直接 ENOTDIR 失敗。"""
    parts = rel_path.split(os.sep)
    opened: list[int] = []
    parent_fd = root_fd
    try:
        for part in parts[:-1]:
            parent_fd = _open_dir_pinned(part, dir_fd=parent_fd)
            opened.append(parent_fd)
        os.symlink(target, parts[-1], dir_fd=parent_fd)
    finally:
        for fd in opened:
            os.close(fd)


def _publish_links(pending: list[_PendingLink], plan: InstallPlan,
                   account_dst_fds: dict[str, int], manifest: dict,
                   installed: set[str], results: list[ItemResult]) -> None:
    """第二階段：第一階段全部發布完、journal 記妥之後才建 symlink。"""
    for link in pending:
        root_fd = account_dst_fds.get(link.account)
        if root_fd is None:
            # 該帳號第一階段失敗（target_moved／OSError），沒有可信 root fd → 不建。
            results.append(ItemResult(link.account, link.rel_path, "failed",
                                      "account_not_installed"))
            continue
        target = _authorized_link_target(link.literal_target, plan, manifest, installed)
        if target is None:
            results.append(ItemResult(link.account, link.rel_path, "excluded",
                                      "symlink_target_unauthorized"))
            continue
        try:
            _symlink_at(root_fd, link.rel_path, target)
            results.append(ItemResult(link.account, link.rel_path, "installed"))
        except FileExistsError:
            results.append(ItemResult(link.account, link.rel_path, "skipped"))
        except OSError as exc:
            logger.error("移機建連結失敗：%s", link.rel_path, exc_info=True)
            results.append(ItemResult(link.account, link.rel_path, "failed",
                                      safe_fs.error_code(exc)))


def install(plan: InstallPlan) -> list[ItemResult]:
    """依 plan 把資產寫進各落點。逐項盡力——單項失敗不阻斷其餘。

    來源身分不符即整批停手（不是跳過單項）：那代表我們掃描過的東西已經不是現在要讀的
    東西，繼續下去等於拿沒驗過的內容寫使用者的現役目錄。

    target 側同款 identity 重驗（票 03 R1，比照票 10 的 source 側）：plan 記下當時存在
    的 target 身分，install 開出 fd 後 fstat 比對，不符回 `target_moved`、該帳號停手
    （各帳號的落點彼此獨立，不株連整批）。**這是縮小窗口不是關閉**：比對到 mutation
    之間仍是 check-then-act；plan 時不存在、由 install 新建的 target 沒有基準可比。"""
    src_root_fd = _require_source_identity(plan)
    results: list[ItemResult] = []
    pending: list[_PendingLink] = []        # symlink 收集起來，第一階段全完成才發布
    # 每個帳號第一階段驗過身分的 dst_fd 延到第二階段用——symlink 一律從這個 fd 逐層
    # 開下去建，不重解析 pathname（Codex 票 04 R1 F2：pathname 重解析會被階段間換掉的
    # 中間目錄／target root 導向外部）。fd 釘住的是 inode，rename 影響不到它。
    account_dst_fds: dict[str, int] = {}
    logger.info("移機開始：source=%s targets=%s", plan.source_root, sorted(plan.targets))
    # journal 開在 source 驗證之後、任何寫入之前：它是 symlink 授權與中斷續作的基礎，
    # 開不起來就不該動使用者的目錄——fail closed 回穩定判別碼，不讓 OSError 裸穿。
    journal = journal_path(transaction_id(plan))
    try:
        journal_fd = _open_journal_fd(journal)
    except OSError as exc:
        os.close(src_root_fd)
        raise ValueError("journal_unavailable") from exc
    try:
        try:
            accounts_fd = _open_dir_pinned("accounts", dir_fd=src_root_fd)
        except OSError as exc:
            # plan 之後 accounts/ 被拿掉或換型——bundle 形狀已不成立，映成穩定判別碼
            # 而不是讓 OSError 穿出去變裸 500。
            raise ValueError("source_not_a_bundle") from exc
        try:
            for key, target in plan.targets.items():
                try:
                    account_fd = _open_dir_pinned(key, dir_fd=accounts_fd)
                except OSError:
                    continue                # 備份包裡沒有這個帳號的內容
                try:
                    dst_fd = None
                    try:
                        Path(target).mkdir(parents=True, exist_ok=True)
                        dst_fd = _open_dir_pinned(target)
                        expected = plan.target_identities.get(key)
                        st = os.fstat(dst_fd)
                        if expected is not None and (st.st_dev, st.st_ino) != expected:
                            # 落點已不是 plan 驗過的那個目錄——寫下去就是寫進替身。
                            results.append(ItemResult(key, "", "failed", "target_moved"))
                            continue
                        _install_tree(account_fd, dst_fd, key, "", results,
                                      journal_fd, pending)
                        # 根層檔案的目錄項持久性掛在這裡——_install_tree 只 fsync 遞迴
                        # 開出的子目錄，root 這層漏掉的話 CLAUDE.md 這種根層檔案斷電後
                        # 連目錄項都可能消失（Codex 票 03 R1）。suppress 與子層一致：
                        # 目錄 fsync 不受支援時把斷電移出保證範圍，不是整批失敗（spec
                        # §4.2.5 保證表第三列）。
                        with contextlib.suppress(OSError):
                            os.fsync(dst_fd)
                        account_dst_fds[key] = dst_fd   # 轉交第二階段，本迴圈不關
                        dst_fd = None
                    except OSError as exc:
                        # 帳號級隔離（Codex 票 03 R2）：落點被檔案占用、權限被收走等
                        # 只讓「這個帳號」失敗——例外穿出去的話 route 只接 ValueError，
                        # 會變裸 500，且排序在後的帳號全部裝不到，違反逐項盡力語意。
                        logger.error("移機帳號級失敗：account=%s target=%s",
                                     key, target, exc_info=True)
                        results.append(ItemResult(key, "", "failed", safe_fs.error_code(exc)))
                    finally:
                        if dst_fd is not None:      # 失敗或 target_moved 才在這裡關
                            os.close(dst_fd)
                finally:
                    os.close(account_fd)
            # 第二階段：所有帳號的一般檔／目錄都發布完、journal 也記妥了，才建 symlink。
            # 授權集合從 journal 重讀（不是本輪記憶體）——中斷續作時前一輪發布的 node
            # 也算數（ADR-0006／spec §4.2.3.1）。
            if pending:
                try:
                    manifest = read_manifest(plan.source_root)
                    installed = installed_nodes(transaction_id(plan))
                except (OSError, ValueError):
                    # provenance 讀不出（journal 可寫不可讀、manifest 階段間被動）→ 降級：
                    # pending 全判 failed（不是 excluded），清除 gate 因此保留 journal。
                    # 靜默略過 symlink 又刪 journal 會誤報成功且永久失去續作依據（F3）。
                    logger.error("移機 symlink 階段 provenance 讀取降級", exc_info=True)
                    for link in pending:
                        results.append(ItemResult(link.account, link.rel_path,
                                                  "failed", "provenance_unavailable"))
                else:
                    _publish_links(pending, plan, account_dst_fds, manifest,
                                   installed, results)
        finally:
            os.close(accounts_fd)
    finally:
        for fd in account_dst_fds.values():
            os.close(fd)
        os.close(journal_fd)
        os.close(src_root_fd)
    logger.info("移機完成：%s", dict(Counter(r.outcome for r in results)))
    # 完整成功才清 journal：它是「這次移機還沒收尾」的訊號（ADR-0006），留著會讓還原卡
    # 永遠顯示「上次移機未完成」。有 failed 則保留——供修好後重跑，中斷續作靠它認得
    # 前一輪已發布的 node（excluded 是刻意拒絕、不算未完成，不阻止清除）。
    if not any(r.outcome == "failed" for r in results):
        with contextlib.suppress(OSError):
            journal.unlink()
    return results

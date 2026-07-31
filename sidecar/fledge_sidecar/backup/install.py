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
import json
import logging
import os
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

    targets: dict[str, str] = {}
    for key in manifest.get("accounts", {}):
        entry = accounts.get(key)
        if entry is None:
            continue                        # 使用者沒為這個帳號指定落點 → 不裝
        targets[key] = _resolved_config_dir(entry.get("config_dir", ""))

    will_install = 0
    will_skip: list[str] = []
    excluded: list[str] = []
    for key, target in targets.items():
        account_dir = Path(root, "accounts", key)
        if not account_dir.is_dir():
            continue
        installable, ex = _walk_account(account_dir)
        excluded.extend(ex)
        for rel in installable:
            if os.path.lexists(os.path.join(target, rel)):
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
        excluded=excluded,
    )


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
                  results: list[ItemResult]) -> None:
    """遞迴安裝一層。symlink 在本階段一律略過（票 04 的第二階段處理）。"""
    for entry in os.scandir(src_fd):
        rel = os.path.join(rel_prefix, entry.name) if rel_prefix else entry.name
        if entry.name in EXCLUDED_NAMES and not rel_prefix:
            results.append(ItemResult(account, rel, "excluded", "not_migrated_by_design"))
            continue
        if entry.is_symlink():
            continue                        # 第二階段處理，見票 04
        try:
            if entry.is_dir(follow_symlinks=False):
                child_src = _open_dir_pinned(entry.name, dir_fd=src_fd)
                try:
                    # 目標目錄不存在才建；已存在不算衝突（目錄本身沒有內容會被覆蓋）
                    try:
                        os.mkdir(entry.name, 0o700, dir_fd=dst_fd)
                    except FileExistsError:
                        pass
                    child_dst = _open_dir_pinned(entry.name, dir_fd=dst_fd)
                    try:
                        _install_tree(child_src, child_dst, account, rel, results)
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
            results.append(ItemResult(account, rel, "installed"))
        except FileExistsError:
            results.append(ItemResult(account, rel, "skipped"))
        except OSError as exc:
            logger.error("移機寫入失敗：account=%s rel=%s", account, rel, exc_info=True)
            results.append(ItemResult(account, rel, "failed", safe_fs.error_code(exc)))


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
    logger.info("移機開始：source=%s targets=%s", plan.source_root, sorted(plan.targets))
    try:
        accounts_fd = _open_dir_pinned("accounts", dir_fd=src_root_fd)
        try:
            for key, target in plan.targets.items():
                try:
                    account_fd = _open_dir_pinned(key, dir_fd=accounts_fd)
                except OSError:
                    continue                # 備份包裡沒有這個帳號的內容
                try:
                    Path(target).mkdir(parents=True, exist_ok=True)
                    dst_fd = _open_dir_pinned(target)
                    try:
                        expected = plan.target_identities.get(key)
                        st = os.fstat(dst_fd)
                        if expected is not None and (st.st_dev, st.st_ino) != expected:
                            # 落點已不是 plan 驗過的那個目錄——寫下去就是寫進替身。
                            results.append(ItemResult(key, "", "failed", "target_moved"))
                            continue
                        _install_tree(account_fd, dst_fd, key, "", results)
                        # 根層檔案的目錄項持久性掛在這裡——_install_tree 只 fsync 遞迴
                        # 開出的子目錄，root 這層漏掉的話 CLAUDE.md 這種根層檔案斷電後
                        # 連目錄項都可能消失（Codex 票 03 R1）。suppress 與子層一致：
                        # 目錄 fsync 不受支援時把斷電移出保證範圍，不是整批失敗（spec
                        # §4.2.5 保證表第三列）。
                        with contextlib.suppress(OSError):
                            os.fsync(dst_fd)
                    finally:
                        os.close(dst_fd)
                finally:
                    os.close(account_fd)
        finally:
            os.close(accounts_fd)
    finally:
        os.close(src_root_fd)
    logger.info("移機完成：%s", dict(Counter(r.outcome for r in results)))
    return results

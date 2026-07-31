"""檔案系統寫入原語：不覆蓋、不跟隨 symlink 的複製，以及 errno → 判別碼映射。

目前唯一呼叫端是 `common_config`（雙帳號共通設置）；抽出來是因為 B-3 的
`setup/templates.py`（範本部署，同分支後續 task）需要同一組「目的地此刻不存在才寫，
且絕不沿最終元件的 symlink 寫出去」的語意——第二個使用點出現才抽，不是預先抽象。
`dir_fd` 參數同理：`common_config` 不需要（目標只在 account dir 下一層），是為了
`templates` 要建巢狀樹而先備妥介面。
"""
from __future__ import annotations

import contextlib
import errno
import os
from pathlib import Path


def copy_file_no_clobber(source_path: str, target_path: str, *, dir_fd: int | None = None) -> None:
    """複製實體檔。不覆蓋既有檔、也不沿最終元件的 symlink 寫出去——
    呼叫端保證 target_path 此刻不存在（探測為 missing 或剛備份完）。

    不跟隨與不覆蓋都是 `O_CREAT|O_EXCL` 提供的（POSIX：最終元件是 symlink 時一律
    EEXIST，不看它指向哪）。`O_NOFOLLOW` 在這個組合下是冗餘的，保留純粹是讓意圖
    在讀 code 時就看得出來，不要誤以為少了它就會跟隨。

    `dir_fd` 非 None 時，`target_path` 是相對該目錄描述子的**單一名稱**：路徑不再
    經過名稱解析，中間目錄在檢查之後被換成 symlink 也影響不到這次寫入。
    `common_config` 以 None 呼叫（目標只在 account dir 下一層）；`templates` 因為
    要建巢狀樹，一律帶 dir_fd。"""
    data = Path(source_path).read_bytes()
    mode = os.stat(source_path).st_mode & 0o777      # 沿用來源權限，不擅自放寬
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(target_path, flags, mode, dir_fd=dir_fd)
    st = os.fstat(fd)
    created = (st.st_dev, st.st_ino)                 # 比 dev+ino：不同檔案系統的 inode 會撞號
    try:
        # os.write 允許短寫（ENOSPC／EINTR 等）；忽略回傳值會靜默截斷卻仍回報成功。
        written = 0
        while written < len(data):
            n = os.write(fd, data[written:])
            if n <= 0:
                raise OSError(errno.EIO, "write made no progress")  # 不擋就是無限迴圈
            written += n
    except BaseException:
        # 失敗時清掉這次自己建的半截檔——留一份截斷的設定檔在 live 位置比沒有更糟。
        # 比對 (dev, ino) 才刪：空窗中若已被換成別的東西，不能誤刪別人的檔案。
        with contextlib.suppress(OSError):
            victim = os.lstat(target_path, dir_fd=dir_fd)
            if (victim.st_dev, victim.st_ino) == created:
                os.unlink(target_path, dir_fd=dir_fd)
        raise
    finally:
        os.close(fd)


# 暫存名的形狀：前導 `.` 加 PID 與隨機段。兩者缺一不可——前導 `.` 讓它不像成品，
# PID＋隨機段讓同時跑的兩個 install 不會撞同一個暫存名（比照 backup-claude.sh 的 .partial）。
_TEMP_PREFIX = ".fledge-install-"


def write_bytes_atomic(data: bytes, name: str, *, dir_fd: int, mode: int = 0o600) -> None:
    """把 data 寫成 dir_fd 底下的 name：內容完整落盤之後，最終檔名才會出現。

    `O_EXCL` 只保證「不覆蓋」，不保證「原子」：先以最終名建立再逐段寫入的話，SIGKILL、
    process crash 或斷電都不會執行清理，留下的是「名字對但內容截斷」的檔案——而下一次
    重跑會因為 EEXIST 判它已存在而跳過，**永久損壞且重跑不修**。

    所以走 temp → fsync → link → unlink temp：`link` 遇既有目標回 EEXIST，是真正的原子
    no-clobber。

    **保證等級（宣稱與實際逐字對齊，Codex R1／R2）**：
    - 發布結果：SIGKILL／process crash 下，最終名一出現即內容完整、絕不覆蓋既有目標，
      重跑收斂（EEXIST → skipped）。斷電下只保證「最終名若存活，指到的內容已 fsync」；
      `link`／`unlink` 產生的**目錄項**持久性不在本函式——由呼叫端在每個目錄處理完畢後
      `fsync(dir_fd)` 承擔（per-directory 粒度是 spec §4.2.5 的成本決策：一次還原上千
      小檔，每檔兩次目錄 fsync 太貴）。
    - 暫存檔殘留：中斷（SIGKILL **或**斷電）恰落在 link 成功與 unlink temp 之間時，
      暫存檔殘留且重跑不清（新進程的 PID＋隨機名對不上）——「失敗清暫存」只覆蓋本進程
      活著走到例外路徑的情形。殘骸清理屬呼叫端簿記（按 `_TEMP_PREFIX` 前綴＋PID 存活
      檢查掃，不能無條件掃：並行的另一個 install 的暫存檔還活著），記錄於票 02。

    目標已存在 → FileExistsError（呼叫端據此判 skipped）。
    """
    temp_name = f"{_TEMP_PREFIX}{os.getpid()}-{os.urandom(4).hex()}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(temp_name, flags, mode, dir_fd=dir_fd)
    try:
        try:
            written = 0
            while written < len(data):
                n = os.write(fd, data[written:])
                if n <= 0:
                    raise OSError(errno.EIO, "write made no progress")
                written += n
            os.fsync(fd)      # 先確保內容落盤，再讓它以最終名可見
        finally:
            os.close(fd)
    except BaseException:
        # 寫入階段失敗也要清暫存檔——移機一次寫上千個檔案，磁碟滿時不清就是一地垃圾。
        # 暫存名含本進程 PID＋隨機段，不會誤刪別人的檔案，直接 unlink 即可。
        with contextlib.suppress(OSError):
            os.unlink(temp_name, dir_fd=dir_fd)
        raise
    try:
        # 真正的原子 no-clobber。**不退回「檢查不存在再 rename」**：那是 check-then-act，
        # 並行的兩個 install 可以雙雙通過檢查然後互相覆蓋使用者的現役檔案。
        os.link(temp_name, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp_name, dir_fd=dir_fd)
        raise
    with contextlib.suppress(OSError):
        os.unlink(temp_name, dir_fd=dir_fd)


# errno → 穩定判別碼。`str(OSError)` 夾帶 errno 文字與絕對路徑，是診斷細節而非前端
# 合約（CLAUDE.md §4.6.13：sidecar 回 code、前端負責 i18n）。完整例外走 log。
_ERROR_CODE_BY_ERRNO: dict[int, str] = {
    errno.EACCES: "permission_denied",
    errno.EPERM: "permission_denied",
    errno.EROFS: "read_only_filesystem",
    errno.ENOENT: "path_missing",
    errno.EEXIST: "target_exists",
    errno.ENOTEMPTY: "target_not_empty",
    errno.ENOSPC: "no_space",
    errno.EXDEV: "cross_device",
    errno.ELOOP: "too_many_symlinks",
    # macOS 對「O_DIRECTORY|O_NOFOLLOW 開到 symlink」回的是 ENOTDIR 而非 ELOOP（已實測）。
    # 這正是目錄在建立與開啟之間被抽換的情形，缺這一條會退化成無資訊的 io_failed。
    errno.ENOTDIR: "not_a_directory",
    # exFAT／部分 SMB、NFS 不支援 hard link，write_bytes_atomic 的 link 發布在那裡
    # 就 fail closed（spec §4.2.5 點名要回報原因）。macOS 上兩個常數是不同值，都要列。
    errno.ENOTSUP: "operation_not_supported",
    errno.EOPNOTSUPP: "operation_not_supported",
}


def error_code(exc: OSError) -> str:
    return _ERROR_CODE_BY_ERRNO.get(exc.errno or 0, "io_failed")

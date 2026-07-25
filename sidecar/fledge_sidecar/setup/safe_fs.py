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
}


def error_code(exc: OSError) -> str:
    return _ERROR_CODE_BY_ERRNO.get(exc.errno or 0, "io_failed")

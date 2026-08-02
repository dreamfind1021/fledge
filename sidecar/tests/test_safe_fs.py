import errno
import os
import subprocess
import sys
from pathlib import Path

import pytest

from fledge_sidecar.setup import safe_fs


def _dead_pid() -> int:
    """一個剛剛結束、確定已經不在的進程編號。"""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def test_copy_file_completes_short_writes(tmp_path: Path, monkeypatch):
    # os.write 可能只寫入部分位元組（ENOSPC／EINTR）。忽略回傳值會靜默截斷卻仍回報成功。
    source = tmp_path / "CLAUDE.md"
    payload = "x" * 5000
    source.write_text(payload, encoding="utf-8")
    target = tmp_path / "copied.md"
    real_write = os.write
    monkeypatch.setattr(safe_fs.os, "write", lambda fd, data: real_write(fd, data[:4]))
    safe_fs.copy_file_no_clobber(str(source), str(target))
    assert target.read_text(encoding="utf-8") == payload


def test_copy_file_refuses_to_follow_or_clobber(tmp_path: Path):
    # O_EXCL：目標位置已被占用一律 EEXIST——不覆蓋既有實體檔，
    # 也不沿最終元件的 symlink 寫穿到別處。
    source = tmp_path / "src.md"
    source.write_text("rules", encoding="utf-8")
    existing = tmp_path / "existing.md"
    existing.write_text("MINE", encoding="utf-8")
    with pytest.raises(FileExistsError):
        safe_fs.copy_file_no_clobber(str(source), str(existing))
    assert existing.read_text(encoding="utf-8") == "MINE"
    outside = tmp_path / "outside.md"
    outside.write_text("OUTSIDE", encoding="utf-8")
    link = tmp_path / "link.md"
    link.symlink_to(outside)
    with pytest.raises(FileExistsError):
        safe_fs.copy_file_no_clobber(str(source), str(link))
    assert outside.read_text(encoding="utf-8") == "OUTSIDE"   # 沒寫穿


def test_copy_file_treats_zero_length_write_as_failure(tmp_path: Path, monkeypatch):
    # os.write 回 0 代表沒有前進；不當成錯誤就是無限迴圈
    source = tmp_path / "CLAUDE.md"
    source.write_text("x" * 100, encoding="utf-8")
    target = tmp_path / "copied.md"
    monkeypatch.setattr(safe_fs.os, "write", lambda fd, data: 0)
    with pytest.raises(OSError):
        safe_fs.copy_file_no_clobber(str(source), str(target))


def test_copy_file_removes_its_partial_file_when_the_write_fails(tmp_path: Path, monkeypatch):
    # 寫到一半失敗時，別把截斷的檔案留在 live 位置
    source = tmp_path / "CLAUDE.md"
    source.write_text("y" * 5000, encoding="utf-8")
    target = tmp_path / "copied.md"
    real_write = os.write
    calls = []

    def _fail_after_first_chunk(fd, data):
        if calls:
            raise OSError("disk full")
        calls.append(1)
        return real_write(fd, data[:10])

    monkeypatch.setattr(safe_fs.os, "write", _fail_after_first_chunk)
    with pytest.raises(OSError):
        safe_fs.copy_file_no_clobber(str(source), str(target))
    assert not target.exists(), "半截檔必須清掉，不能留在 live 位置"


def test_copy_file_writes_relative_to_a_directory_descriptor(tmp_path: Path):
    # dir_fd 模式：target_path 是相對該描述子的單一名稱，路徑不再經過名稱解析
    source = tmp_path / "src.md"
    source.write_text("rules", encoding="utf-8")
    dest_dir = tmp_path / "dest"
    dest_dir.mkdir()
    fd = os.open(dest_dir, os.O_RDONLY | os.O_DIRECTORY)
    try:
        safe_fs.copy_file_no_clobber(str(source), "copied.md", dir_fd=fd)
    finally:
        os.close(fd)
    assert (dest_dir / "copied.md").read_text(encoding="utf-8") == "rules"


def test_error_code_maps_errno_and_falls_back():
    import errno as errno_mod

    assert safe_fs.error_code(PermissionError(errno_mod.EACCES, "x")) == "permission_denied"
    assert safe_fs.error_code(OSError(errno_mod.ENOSPC, "x")) == "no_space"
    # ENOTDIR 是「目錄在建立與開啟之間被抽換」在 macOS 上的 errno（實測非 ELOOP）。
    # 缺這條會讓最值得診斷的競態退化成無資訊的 io_failed。
    assert safe_fs.error_code(OSError(errno_mod.ENOTDIR, "x")) == "not_a_directory"
    # exFAT／部分 SMB、NFS 不支援 hard link，link 發布在那裡回的就是這兩個 errno
    # （macOS 上 ENOTSUP=45 與 EOPNOTSUPP=102 是不同值，缺一都會退成無資訊的 io_failed）。
    assert safe_fs.error_code(OSError(errno_mod.ENOTSUP, "x")) == "operation_not_supported"
    assert safe_fs.error_code(OSError(errno_mod.EOPNOTSUPP, "x")) == "operation_not_supported"
    assert safe_fs.error_code(OSError("no errno at all")) == "io_failed"


def test_write_bytes_atomic_publishes_only_complete_content(tmp_path: Path):
    """原子發布：最終名一出現就代表內容完整。中途失敗不得留下佔用最終名的半截檔。"""
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        safe_fs.write_bytes_atomic(b"hello", "out.txt", dir_fd=d)
    finally:
        os.close(d)
    assert (tmp_path / "out.txt").read_bytes() == b"hello"
    # 暫存檔不得殘留
    assert [p.name for p in tmp_path.iterdir()] == ["out.txt"]


def test_write_bytes_atomic_refuses_existing_target(tmp_path: Path):
    """不覆蓋：目標已存在時拋 FileExistsError，且既有內容一位元組不變。"""
    (tmp_path / "out.txt").write_bytes(b"MINE")
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        with pytest.raises(FileExistsError):
            safe_fs.write_bytes_atomic(b"theirs", "out.txt", dir_fd=d)
    finally:
        os.close(d)
    assert (tmp_path / "out.txt").read_bytes() == b"MINE"


def test_write_bytes_atomic_cleans_temp_when_publish_fails(tmp_path: Path, monkeypatch):
    """發布失敗時要清掉自己的暫存檔，否則每次失敗都在使用者目錄留一份垃圾。"""
    def _boom(*a, **k):
        raise OSError(errno.EPERM, "nope")

    monkeypatch.setattr(safe_fs.os, "link", _boom)
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        with pytest.raises(OSError):
            safe_fs.write_bytes_atomic(b"hello", "out.txt", dir_fd=d)
    finally:
        os.close(d)
    assert list(tmp_path.iterdir()) == []


def test_write_bytes_atomic_fsyncs_content_before_publish(tmp_path: Path, monkeypatch):
    """fsync 先於 link 是這個原語的存在理由：顛倒（或漏掉 fsync）時，斷電可能讓最終名
    指著沒落盤的內容——而其他測試都跑在 page cache 上，刪掉 fsync 那行照樣全綠
    （Codex R1 抓到的測試缺口：安全關鍵的一行沒有紅線）。

    只記呼叫名稱不夠：誤改成 `fsync(dir_fd)` 一樣得到 ["fsync","link"]（Codex R2）——
    所以用 inode 釘死「fsync 的對象就是 link 要發布的那個檔」。"""
    events: list[tuple[str, tuple[int, int]]] = []
    real_fsync, real_link = os.fsync, os.link

    def _spy_fsync(fd):
        st = os.fstat(fd)
        events.append(("fsync", (st.st_dev, st.st_ino)))
        return real_fsync(fd)

    def _spy_link(src, dst, **kw):
        st = os.stat(src, dir_fd=kw["src_dir_fd"], follow_symlinks=False)
        events.append(("link", (st.st_dev, st.st_ino)))
        return real_link(src, dst, **kw)

    monkeypatch.setattr(safe_fs.os, "fsync", _spy_fsync)
    monkeypatch.setattr(safe_fs.os, "link", _spy_link)
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        safe_fs.write_bytes_atomic(b"hello", "out.txt", dir_fd=d)
    finally:
        os.close(d)
    assert [name for name, _ in events] == ["fsync", "link"]
    # 順序對但同步錯檔案（如 dir_fd）一樣是假保證——兩個 inode 必須是同一個
    assert events[0][1] == events[1][1]


def test_write_bytes_atomic_cleans_temp_when_write_fails(tmp_path: Path, monkeypatch):
    """寫入階段（而非發布階段）失敗也要清暫存檔——移機寫上千個檔案時磁碟滿了，
    不清的話每個失敗項都在使用者現役目錄留一份 .fledge-install-* 垃圾。"""
    monkeypatch.setattr(safe_fs.os, "write", lambda fd, data: 0)   # 寫不進去 → EIO
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        with pytest.raises(OSError):
            safe_fs.write_bytes_atomic(b"hello", "out.txt", dir_fd=d)
    finally:
        os.close(d)
    assert list(tmp_path.iterdir()) == []


# ---------- 暫存殘骸回收（票 08：SIGKILL／斷電留下的暫存檔重跑不清） ----------


def test_reap_removes_temp_whose_creator_is_gone(tmp_path: Path):
    """硬中斷留下的暫存檔要被回收——重跑的 PID 對不上，不主動掃就永遠留著。"""
    orphan = tmp_path / f"{safe_fs.TEMP_PREFIX}{_dead_pid()}-a1b2c3d4"
    orphan.write_bytes(b"half")
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        assert safe_fs.reap_stale_temps(d) == 1
    finally:
        os.close(d)
    assert not orphan.exists()


def test_reap_spares_temp_of_a_live_process(tmp_path: Path):
    """並行的另一個移機正在寫的暫存檔絕不能清——那會破壞對方進行中的原子發布。

    不能無條件掃前綴，這就是原因。"""
    live = tmp_path / f"{safe_fs.TEMP_PREFIX}{os.getpid()}-a1b2c3d4"
    live.write_bytes(b"in flight")
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        assert safe_fs.reap_stale_temps(d) == 0
    finally:
        os.close(d)
    assert live.exists()


def test_reap_never_touches_anything_but_its_own_temps(tmp_path: Path):
    """使用者的檔案（含剛好也是隱藏檔的）一律不碰。"""
    for name in ("CLAUDE.md", ".hidden", ".fledge-lnk-1-a1b2c3d4", "settings.json"):
        (tmp_path / name).write_bytes(b"MINE")
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        assert safe_fs.reap_stale_temps(d) == 0
    finally:
        os.close(d)
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        ".fledge-lnk-1-a1b2c3d4", ".hidden", "CLAUDE.md", "settings.json"]


def test_reap_spares_names_whose_pid_cannot_be_parsed(tmp_path: Path):
    """看起來像但解不出進程編號的 → 判斷不出來就留著（寧可漏清也不誤刪）。"""
    for suffix in ("notanumber-a1b2", "", "-a1b2"):
        (tmp_path / f"{safe_fs.TEMP_PREFIX}{suffix}").write_bytes(b"?")
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        assert safe_fs.reap_stale_temps(d) == 0
    finally:
        os.close(d)
    assert len(list(tmp_path.iterdir())) == 3


def test_reap_only_touches_regular_files(tmp_path: Path):
    """暫存檔一律是一般檔——名字像但其實是目錄或 symlink 的，都不是我們產生的。

    **symlink 才是這條線真正守住的東西**：`unlink` 對目錄本來就會失敗（拿掉型別檢查
    也刪不掉，用目錄測就是假綠），但對 symlink 會成功——刪掉的會是使用者自己的連結。"""
    victim = tmp_path / "user-data.md"
    victim.write_bytes(b"MINE")
    pid = _dead_pid()
    (tmp_path / f"{safe_fs.TEMP_PREFIX}{pid}-dead0001").mkdir()
    (tmp_path / f"{safe_fs.TEMP_PREFIX}{pid}-dead0002").symlink_to(victim)

    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        assert safe_fs.reap_stale_temps(d) == 0
    finally:
        os.close(d)
    assert (tmp_path / f"{safe_fs.TEMP_PREFIX}{pid}-dead0001").is_dir()
    assert (tmp_path / f"{safe_fs.TEMP_PREFIX}{pid}-dead0002").is_symlink()
    assert victim.read_bytes() == b"MINE"


def test_reap_rechecks_identity_before_unlink(tmp_path: Path, monkeypatch):
    """scandir 判型到 unlink 之間名字被抽換 → 身分不符就不刪（Codex 票 08 R1 F1）。

    POSIX 沒有「按 fd 刪除」的原語（macOS 無 `funlinkat`，Python 只有 pathname 版
    `unlink`），所以無法原子地「驗身分再刪」——**這是縮小窗口不是關閉**，同票 09 對
    symlink 暫名的裁定。這條釘住的是「至少不能拿 scandir 當時的型別結果去授權稍後的
    刪除」。"""
    pid = _dead_pid()
    name = f"{safe_fs.TEMP_PREFIX}{pid}-a1b2c3d4"
    (tmp_path / name).write_bytes(b"stale")
    victim = tmp_path / "user-data.md"
    victim.write_bytes(b"MINE")

    real_lstat = safe_fs.os.lstat
    swapped: list[bool] = []

    def _swap_then_lstat(path, **kwargs):
        # 抽換發生在重驗之前：reaper 拿到的會是「另一個物件」的身分
        if path == name and not swapped:
            swapped.append(True)
            (tmp_path / name).unlink()
            victim.rename(tmp_path / name)
        return real_lstat(path, **kwargs)

    monkeypatch.setattr(safe_fs.os, "lstat", _swap_then_lstat)
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        assert safe_fs.reap_stale_temps(d) == 0
    finally:
        os.close(d)
    assert swapped, "抽換沒有發生過，這條測試沒測到東西"
    assert (tmp_path / name).read_bytes() == b"MINE", "抽換進來的使用者檔案不得被刪"


def test_reap_spares_temp_when_liveness_cannot_be_determined(tmp_path: Path, monkeypatch):
    """`kill(0)` 回 EPERM（進程存在但不屬於我們）→ 問不出來一律留著。

    `ProcessLookupError`（ESRCH）才是「確定不在」的唯一訊號。"""
    def _eperm(pid, sig):
        raise PermissionError(errno.EPERM, "not yours")

    monkeypatch.setattr(safe_fs.os, "kill", _eperm)
    orphan = tmp_path / f"{safe_fs.TEMP_PREFIX}{_dead_pid()}-a1b2c3d4"
    orphan.write_bytes(b"half")
    d = os.open(str(tmp_path), os.O_DIRECTORY)
    try:
        assert safe_fs.reap_stale_temps(d) == 0
    finally:
        os.close(d)
    assert orphan.exists()

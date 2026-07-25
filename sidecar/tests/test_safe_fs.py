import os
from pathlib import Path

import pytest

from fledge_sidecar.setup import safe_fs


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
    assert safe_fs.error_code(OSError("no errno at all")) == "io_failed"

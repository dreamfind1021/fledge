"""還原模組（`backup/restore.py`）的契約。

全程 tmp_path 與假 HOME——**不碰真實的 Claude 目錄，也不對真實備份目錄做任何寫入**。
"""
import os
from pathlib import Path

import pytest

from fledge_sidecar.backup import restore
from fledge_sidecar.backup.script import restore_script_available, restore_script_path

BUNDLE_NAME = "claude-backup-20260101-1200.tar.gz"


def _backup_dir(tmp_path: Path) -> Path:
    d = tmp_path / "bundles"
    d.mkdir()
    (d / BUNDLE_NAME).write_bytes(b"x")
    return d


# ── 備份包名是 allowlist（前端只送名字，不送路徑）────────────────────────────


def test_bundle_path_resolves_a_listed_bundle(tmp_path: Path):
    d = _backup_dir(tmp_path)
    assert restore.bundle_path(str(d), BUNDLE_NAME) == str(d / BUNDLE_NAME)


def test_bundle_path_rejects_anything_not_in_the_listing(tmp_path: Path):
    """**這是 allowlist 不變式**：可接受的名字只有 `list_bundles` 真的列出來的那些。

    前端送的是名字而不是路徑（沿用 kind=install 的 install_id 取向），所以路徑穿越、
    絕對路徑、以及「檔案確實存在但不是備份包形狀」都必須在這裡被擋掉——不能讓一個
    任意路徑變成 argv 裡的 tar 輸入。"""
    d = _backup_dir(tmp_path)
    outsider = tmp_path / "passwd"
    outsider.write_bytes(b"x")
    (d / "notes.txt").write_bytes(b"x")                       # 存在但不是備份包
    (d / "claude-backup-20261340-9999.tar.gz").write_bytes(b"x")  # 形狀對但時間戳無效
    for bad in (
        "../passwd",
        "../../etc/passwd",
        str(outsider),
        "/etc/passwd",
        "notes.txt",
        "claude-backup-20261340-9999.tar.gz",
        "",
        BUNDLE_NAME + "x",
    ):
        with pytest.raises(ValueError, match="unknown_bundle"):
            restore.bundle_path(str(d), bad)


def test_bundle_path_rejects_when_directory_has_no_bundles(tmp_path: Path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="unknown_bundle"):
        restore.bundle_path(str(empty), BUNDLE_NAME)


# ── 預設展開位置 ──────────────────────────────────────────────────────────────


def test_default_dest_is_derived_from_the_bundle_stamp(tmp_path: Path, monkeypatch):
    """展開位置預設在 home 底下、名字帶備份包的時間戳——同時還原兩份包不會互相覆蓋，
    而且使用者從目錄名就看得出這是哪一份。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert restore.default_dest(BUNDLE_NAME) == str(
        Path(tmp_path / "home") / ".claude-restore-20260101-1200"
    )


# ── 展開位置防呆（驗收 #3）────────────────────────────────────────────────────


def test_check_dest_rejects_overlap_with_the_live_data(tmp_path: Path, monkeypatch):
    """展開位置落在現役資料裡面就擋下——判定與備份輸出目錄共用同一組規則。

    重疊的後果不是「檔案被覆蓋」（tar 解到 dest/accounts/ 底下）而是更難察覺的：把一份
    完整副本塞進備份來源裡，下一次備份就會把它整包再收一遍。"""
    live = tmp_path / "home" / ".claude"
    live.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    roots = [str(live)]
    assert restore.check_dest(str(live), roots) == "inside_source"
    assert restore.check_dest(str(live / "restored"), roots) == "inside_source"
    assert restore.check_dest(str(tmp_path / "home"), roots) == "is_home"
    assert restore.check_dest(os.sep, roots) == "is_root"


def test_check_dest_accepts_missing_or_empty_location(tmp_path: Path):
    """不存在＝腳本會建；已存在但空的＝系統選擇器挑出來的必然形狀，兩者都可用。"""
    empty = tmp_path / "empty"
    empty.mkdir()
    assert restore.check_dest(str(tmp_path / "nope"), []) == "ok"
    assert restore.check_dest(str(empty), []) == "ok"


def test_check_dest_rejects_non_empty_location(tmp_path: Path):
    """非空一律拒絕——腳本絕不往既有內容上疊，UI 要在按下去之前就講出來。"""
    used = tmp_path / "used"
    used.mkdir()
    (used / "mine.txt").write_bytes(b"x")
    assert restore.check_dest(str(used), []) == "not_empty"


def test_check_dest_reports_a_file_in_the_way(tmp_path: Path):
    f = tmp_path / "afile"
    f.write_bytes(b"x")
    assert restore.check_dest(str(f), []) == "not_dir"


def test_check_dest_reports_unreadable_location(tmp_path: Path):
    """讀不到就說讀不到，不是硬猜成可用——防呆不得 fail-open。"""
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    blocked.chmod(0o000)
    try:
        assert restore.check_dest(str(blocked), []) == "denied"
    finally:
        blocked.chmod(0o700)   # 還原否則 tmp_path 清不掉


def test_check_dest_puts_containment_before_emptiness(tmp_path: Path, monkeypatch):
    """位置結構上就選錯時，先講那件事：把那個目錄清空也不會讓它變成一個合理的位置。"""
    live = tmp_path / "home" / ".claude"
    live.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    inside = live / "restored"
    inside.mkdir()
    (inside / "junk").write_bytes(b"x")     # 同時滿足 inside_source 與 not_empty
    assert restore.check_dest(str(inside), [str(live)]) == "inside_source"


# ── argv ─────────────────────────────────────────────────────────────────────


def test_build_restore_argv_passes_paths_as_arguments(tmp_path: Path):
    """比照 `backup.script.build_argv` 的兩個選擇：不經 `-lc`（路徑含空白／引號時，
    組 shell 字串等於自己開一個 quoting 漏洞），且顯式帶 `/bin/bash`（PyInstaller 的
    `datas` 不保證保留執行位元，靠 shebang 會在打包版變成 EACCES）。"""
    argv = restore.build_restore_argv("/b/my bundle.tar.gz", "/d/my dest")
    assert argv[0] == "/bin/bash"
    assert argv[1] == restore_script_path()
    assert argv[2:] == ["/b/my bundle.tar.gz", "-o", "/d/my dest"]
    assert all(isinstance(a, str) for a in argv)


def test_restore_script_is_present_in_the_repo():
    assert restore_script_available() is True
    assert restore_script_path().endswith("restore-claude.sh")

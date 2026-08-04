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


# ── 預設展開位置的撞名（真機驗收 finding）────────────────────────────────────
# app 不該建議一個自己隨後會拒絕的位置：跑過一次之後回到卡片，預設位置正是上次的展開
# 結果（非空），使用者看到的是「預設值＋橘色警告＋停用的按鈕」。


def test_resolve_dest_skips_an_occupied_default(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    base = home / ".claude-restore-20260101-1200"
    (base / "accounts").mkdir(parents=True)          # 上一次的展開結果

    assert restore.resolve_dest(None, BUNDLE_NAME) == str(base) + "-1"


def test_resolve_dest_keeps_counting_until_it_finds_a_free_one(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    base = home / ".claude-restore-20260101-1200"
    for suffix in ("", "-1", "-2"):
        d = Path(str(base) + suffix)
        d.mkdir()
        (d / "x").write_bytes(b"x")

    assert restore.resolve_dest(None, BUNDLE_NAME) == str(base) + "-3"


def test_resolve_dest_reuses_an_empty_default(tmp_path: Path, monkeypatch):
    """空目錄是可用的（系統選擇器挑出來的必然形狀），不該因為「存在」就跳過——
    否則每按一次變更又選回來，就多一個空殼目錄。"""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    base = home / ".claude-restore-20260101-1200"
    base.mkdir()

    assert restore.resolve_dest(None, BUNDLE_NAME) == str(base)


def test_resolve_dest_never_suffixes_a_user_choice(tmp_path: Path, monkeypatch):
    """使用者自己指定的位置**不套**撞名迴圈：他選什麼就是什麼，非空由 check_dest 照樣擋。
    悄悄把他選的 X 換成 X-1，等於在他沒看到的地方改掉他的決定。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    used = tmp_path / "used"
    used.mkdir()
    (used / "mine.txt").write_bytes(b"x")

    assert restore.resolve_dest(str(used), BUNDLE_NAME) == str(used)
    assert restore.check_dest(str(used), []) == "not_empty"


# ── 路徑模式：使用者用系統檔案選擇器挑的包（票 11）────────────────────────────
#
# **這條路沒有 allowlist**：移機情境下備份包不可能已經在「備份輸出目錄」裡（那個目錄是拿來
# 寫備份的，新機器還沒備份過任何東西）。放行的能力基準線是 `kind=terminal`（見票 11／增補
# spec §2.7.1），不是「使用者選的所以可信」——後端仍把它當不可信路徑驗。


def test_bundle_from_path_accepts_a_regular_file(tmp_path: Path):
    f = tmp_path / "somewhere" / "my-backup.tar.gz"
    f.parent.mkdir()
    f.write_bytes(b"x")
    assert restore.bundle_from_path(str(f)) == str(f)


def test_bundle_from_path_rejects_a_relative_path(tmp_path: Path):
    with pytest.raises(ValueError, match="bundle_path_invalid"):
        restore.bundle_from_path("relative/bundle.tar.gz")


def test_bundle_from_path_rejects_a_missing_file(tmp_path: Path):
    with pytest.raises(ValueError, match="bundle_not_found"):
        restore.bundle_from_path(str(tmp_path / "nope.tar.gz"))


def test_bundle_from_path_rejects_a_directory(tmp_path: Path):
    d = tmp_path / "adir"
    d.mkdir()
    with pytest.raises(ValueError, match="bundle_not_a_file"):
        restore.bundle_from_path(str(d))


def test_bundle_from_path_rejects_a_fifo(tmp_path: Path):
    """FIFO 要**開得起來才判得出型別**：唯讀 open 一個沒有 writer 的 FIFO 會阻塞，
    所以實作必須帶 `O_NONBLOCK`。

    **自帶 alarm 是必要的，不是保險**：實測拿掉 `O_NONBLOCK` 之後這條測試不會變紅，它會
    **永遠跑不完**——CI 會 hang 而不是 fail，而卡死的測試不是紅燈（票 10 的教訓）。
    專案沒裝 `pytest-timeout`，所以用 `signal.alarm` 自己來。"""
    import signal

    fifo = tmp_path / "afifo"
    os.mkfifo(fifo)

    def _bail(*_):
        raise AssertionError("bundle_from_path 在 FIFO 上阻塞了——實作漏了 O_NONBLOCK")

    previous = signal.signal(signal.SIGALRM, _bail)
    signal.alarm(5)
    try:
        with pytest.raises(ValueError, match="bundle_not_a_file"):
            restore.bundle_from_path(str(fifo))
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def test_bundle_from_path_rejects_a_socket(tmp_path: Path, monkeypatch):
    """socket 走的是**另一條分支**：它的 `os.open` 直接 ENOTSUP（實測），fstat 根本執行不到，
    型別只能回頭用 `stat` 判。少了那條分支，這裡會變成 `bundle_unreadable`。

    （bind 用相對路徑：AF_UNIX 的位址有 104 字元上限，而 pytest 的 `tmp_path` 比它長。）"""
    import socket as _socket

    monkeypatch.chdir(tmp_path)
    s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    try:
        s.bind("asock")
        with pytest.raises(ValueError, match="bundle_not_a_file"):
            restore.bundle_from_path(str(tmp_path / "asock"))
    finally:
        s.close()


def test_bundle_from_path_rejects_a_device(tmp_path: Path):
    """character device 走 fstat 那條分支（open 成功、S_ISREG 為假）。

    用 `/dev/null` 是因為造一個 device node 需要 root。它**只被唯讀開啟並 fstat**，不寫、
    也不是任何帳號目錄——沒有其他方式覆蓋這個型別。"""
    with pytest.raises(ValueError, match="bundle_not_a_file"):
        restore.bundle_from_path("/dev/null")


def test_bundle_from_path_rejects_a_dangling_symlink(tmp_path: Path):
    link = tmp_path / "dangling.tar.gz"
    link.symlink_to(tmp_path / "gone.tar.gz")
    with pytest.raises(ValueError, match="bundle_not_found"):
        restore.bundle_from_path(str(link))


def test_bundle_from_path_follows_a_symlink_to_a_regular_file(tmp_path: Path):
    """**symlink 不拒**：既然已經接受任意路徑，前端大可直接送 symlink 的目標——拒絕不減少
    攻擊面，只會擋掉合理用法（家目錄放一個指向隨身碟的連結）。"""
    real = tmp_path / "real.tar.gz"
    real.write_bytes(b"x")
    link = tmp_path / "link.tar.gz"
    link.symlink_to(real)
    assert restore.bundle_from_path(str(link)) == str(link)


def test_dest_for_bundle_path_derives_from_a_conforming_filename(tmp_path: Path, monkeypatch):
    """檔名符合備份包命名規則時，路徑模式與名字模式推出同一個預設位置。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    bundle = tmp_path / BUNDLE_NAME
    bundle.write_bytes(b"x")
    assert restore.dest_for_bundle_path(None, str(bundle)) == str(
        Path(tmp_path / "home") / ".claude-restore-20260101-1200"
    )


def test_dest_for_bundle_path_refuses_to_guess_from_an_odd_filename(tmp_path: Path, monkeypatch):
    """**檔名不符命名規則就不猜**（比照 `project_paths` 的建議值：推不出來就留空）。

    basename 會變成展開目錄名的一部分，而路徑模式的檔名是任意的。猜一個就得去 sanitize
    它，那條路只會長出更多邊界情況——不如要使用者明確指定位置。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    bundle = tmp_path / "我的備份 (2).tgz"
    bundle.write_bytes(b"x")
    with pytest.raises(ValueError, match="dest_required"):
        restore.dest_for_bundle_path(None, str(bundle))


def test_dest_for_bundle_path_takes_the_user_choice_whatever_the_filename(tmp_path: Path, monkeypatch):
    """使用者指定了位置就用它——檔名符不符合命名規則都不再有意義。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    bundle = tmp_path / "odd-name.tgz"
    bundle.write_bytes(b"x")
    chosen = tmp_path / "unpack-here"
    assert restore.dest_for_bundle_path(str(chosen), str(bundle)) == str(chosen)

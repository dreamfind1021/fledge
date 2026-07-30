import os
from datetime import datetime
from pathlib import Path

from fledge_sidecar.backup.bundles import days_since, last_attempt_failed, list_bundles


def _touch(d: Path, name: str, size: int = 10) -> None:
    (d / name).write_bytes(b"x" * size)


# ── 清單 ──────────────────────────────────────────────────────────────────────


def test_lists_bundles_newest_first(tmp_path: Path):
    _touch(tmp_path, "claude-backup-20260727-1432.tar.gz")
    _touch(tmp_path, "claude-backup-20260729-0900.tar.gz")
    assert [b.name for b in list_bundles(str(tmp_path))] == [
        "claude-backup-20260729-0900.tar.gz",
        "claude-backup-20260727-1432.tar.gz",
    ]


def test_created_ts_comes_from_filename_not_mtime(tmp_path: Path):
    """檔案被複製或搬動時 mtime 會變，檔名是打包當下的事實。"""
    _touch(tmp_path, "claude-backup-20260727-1432.tar.gz")
    os.utime(tmp_path / "claude-backup-20260727-1432.tar.gz", (0, 0))  # mtime 打成 1970
    (bundle,) = list_bundles(str(tmp_path))
    assert bundle.created_ts == datetime(2026, 7, 27, 14, 32).timestamp()


def test_size_is_reported(tmp_path: Path):
    _touch(tmp_path, "claude-backup-20260727-1432.tar.gz", size=1234)
    assert list_bundles(str(tmp_path))[0].size_bytes == 1234


def test_partial_and_unrelated_names_are_ignored(tmp_path: Path):
    """只認完整備份包的確切形狀。半成品（前導 `.` + `.partial` 後綴）被顯示成一次成功的
    備份，是這張卡最危險的失敗——使用者會看到「0 天前」配正常色。"""
    _touch(tmp_path, ".claude-backup-20260729-0900-12345.tar.gz.partial")
    _touch(tmp_path, "claude-backup-20260729-0900.tar.gz.partial")
    _touch(tmp_path, "unrelated.tar.gz")
    _touch(tmp_path, "claude-backup-20260729-0900.tar")
    assert list_bundles(str(tmp_path)) == []


def test_malformed_stamps_are_skipped(tmp_path: Path):
    """形狀對但時間戳無效（月份 13、日 40）：跳過不拋，與 usage parser 同契約。"""
    _touch(tmp_path, "claude-backup-2026-07-29.tar.gz")
    _touch(tmp_path, "claude-backup-20261340-9999.tar.gz")
    assert list_bundles(str(tmp_path)) == []


def test_directory_with_bundle_name_is_ignored(tmp_path: Path):
    """有人手動建了同名資料夾也不能被當成備份包。"""
    (tmp_path / "claude-backup-20260727-1432.tar.gz").mkdir()
    assert list_bundles(str(tmp_path)) == []


def test_missing_directory_returns_empty(tmp_path: Path):
    assert list_bundles(str(tmp_path / "nope")) == []


# ── 天數 ──────────────────────────────────────────────────────────────────────


def test_days_since_is_calendar_days():
    """今天備份完＝0、昨天＝1；不是 24 小時整除——使用者說「幾天前」時想的是日曆。"""
    now = datetime(2026, 7, 30, 9, 0)
    assert days_since(datetime(2026, 7, 30, 8, 59).timestamp(), now) == 0
    assert days_since(datetime(2026, 7, 29, 23, 59).timestamp(), now) == 1
    assert days_since(datetime(2026, 7, 23, 0, 0).timestamp(), now) == 7


def test_days_since_crosses_midnight_not_24h():
    """凌晨 00:30 看昨天 23:30 的備份：只差一小時，但日曆上是「1 天前」。
    這正是刻意不用 24 小時整除的理由。"""
    now = datetime(2026, 7, 30, 0, 30)
    assert days_since(datetime(2026, 7, 29, 23, 30).timestamp(), now) == 1


def test_days_since_none_when_never_backed_up():
    assert days_since(None, datetime(2026, 7, 30, 9, 0)) is None


# ── 上次嘗試是否失敗 ──────────────────────────────────────────────────────────


def test_last_attempt_failed_when_partial_newer_than_bundle(tmp_path: Path):
    """比最新備份包還新的殘骸＝上一次沒跑完。讓它沉默，使用者會看到「N 天前」
    卻不知道最近那次是失敗的。"""
    _touch(tmp_path, "claude-backup-20260727-1432.tar.gz")
    _touch(tmp_path, ".claude-backup-20260729-0900-12345.tar.gz.partial")
    assert last_attempt_failed(str(tmp_path), list_bundles(str(tmp_path))) is True


def test_last_attempt_not_failed_when_partial_older(tmp_path: Path):
    """舊殘骸不該讓一次成功的備份看起來像失敗。"""
    _touch(tmp_path, ".claude-backup-20260727-1000-12345.tar.gz.partial")
    _touch(tmp_path, "claude-backup-20260729-0900.tar.gz")
    assert last_attempt_failed(str(tmp_path), list_bundles(str(tmp_path))) is False


def test_last_attempt_failed_with_no_bundles_at_all(tmp_path: Path):
    """從未成功過但有殘骸：仍要算失敗。"""
    _touch(tmp_path, ".claude-backup-20260729-0900-12345.tar.gz.partial")
    assert last_attempt_failed(str(tmp_path), []) is True


def test_no_partial_means_no_failure(tmp_path: Path):
    _touch(tmp_path, "claude-backup-20260729-0900.tar.gz")
    assert last_attempt_failed(str(tmp_path), list_bundles(str(tmp_path))) is False


def test_malformed_partial_name_ignored(tmp_path: Path):
    """命名不符的檔案不是我們的殘骸，不能拿它來宣稱備份失敗。"""
    _touch(tmp_path, ".claude-backup-nonsense.tar.gz.partial")
    _touch(tmp_path, "important.tar.gz.partial")
    assert last_attempt_failed(str(tmp_path), []) is False


def test_partial_without_pid_segment_is_not_our_residue(tmp_path: Path):
    """沒有 PID 段的檔名不是本腳本產生的格式——不能拿它宣稱備份失敗，
    腳本的回收邏輯也不會刪它。兩邊的命名認定必須一致。"""
    _touch(tmp_path, ".claude-backup-20260729-0900.tar.gz.partial")
    assert last_attempt_failed(str(tmp_path), []) is False

"""移機「進行中」簿記與狀態機的契約（票 07，增補 spec §3）。

**全程假 HOME + tmp_path**：marker 寫在 `~/.fledge/`，沒有這層會寫進真實家目錄。

這份簿記是**便利性資料不是授權來源**（§3.4）：`source_root` 與 `mapping` 只拿來預填
install 頁的表單，真正的驗證全在 `install.plan()`。所以讀取一律 fail-safe——壞掉就當
作沒有，絕不擋住還原卡。
"""
import json
import os
from pathlib import Path

import pytest
from conftest import make_staging as _staging

from fledge_sidecar.backup import install as inst
from fledge_sidecar.backup import migration_state as ms


@pytest.fixture(autouse=True)
def _fake_home(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))


def _plan(tmp_path: Path) -> inst.InstallPlan:
    """一份真的 plan——`transaction_id` 綁 source_identity／落點／renames，手捏的假 id
    會讓 journal 定位與實際續作用的那一個對不上。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir(exist_ok=True)
    return inst.plan(str(src), {"work": {"config_dir": str(tgt), "label": ""}})


def _journal(tid: str, body: str = "") -> Path:
    path = inst.journal_path(tid)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def _good_record() -> str:
    return json.dumps({"node": "work/x", "dev": 1, "ino": 2, "kind": "dir"}) + "\n"


# ── marker 的讀寫 ────────────────────────────────────────────────────────────

def test_write_then_read_round_trips_source_and_mapping(tmp_path: Path):
    """續作要靠它把「使用者剛才填了什麼」帶回來——展開位置與專案對應都要原封不動。"""
    ms.write_marker("abc123", "/tmp/staging", [("/old/a", "/new/a")])
    got = ms.read_marker()
    assert got is not None
    assert got["transaction_id"] == "abc123"
    assert got["source_root"] == "/tmp/staging"
    assert got["mapping"] == [{"old": "/old/a", "new": "/new/a"}]


def test_write_marker_is_atomic_and_leaves_no_temp(tmp_path: Path):
    """硬中斷落在寫入中途不該留下半寫的 marker——那會讓下一次查詢看到形狀不對的檔案。"""
    ms.write_marker("abc123", "/tmp/staging", [])
    marker = Path(os.environ["HOME"]) / ".fledge" / "migration-in-progress.json"
    assert marker.exists()
    leftovers = [p.name for p in marker.parent.iterdir() if p.name != marker.name]
    assert leftovers == [], f"暫存檔沒清乾淨：{leftovers}"


def test_write_marker_overwrites_the_previous_round(tmp_path: Path):
    """只支援一個「進行中」的移機（§3.5）：新的一輪覆蓋舊的，不累積。"""
    ms.write_marker("old-tid", "/tmp/a", [("/x", "/y")])
    ms.write_marker("new-tid", "/tmp/b", [])
    got = ms.read_marker()
    assert got is not None and got["transaction_id"] == "new-tid"
    assert got["mapping"] == []


@pytest.mark.parametrize("payload", [
    "NOT JSON",
    "[]",                                            # 頂層不是物件
    json.dumps({"source_root": "/tmp/x"}),           # 缺 transaction_id
    json.dumps({"transaction_id": 1, "source_root": "/tmp/x", "mapping": []}),
    json.dumps({"transaction_id": "t", "source_root": "/tmp/x", "mapping": "nope"}),
    json.dumps({"transaction_id": "t", "source_root": "/tmp/x",
                "mapping": [{"old": "/a"}]}),        # mapping 項缺 new
])
def test_read_marker_is_fail_safe(payload: str):
    """壞掉一律當作沒有（§3.4）——這份資料不被信任，而還原卡不該因為它壞掉而壞掉。"""
    path = Path(os.environ["HOME"]) / ".fledge" / "migration-in-progress.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    assert ms.read_marker() is None


def test_read_marker_when_fledge_dir_is_unreadable():
    """`~/.fledge` 讀不出來（權限被收走）→ 當作沒有，不拋。"""
    fledge = Path(os.environ["HOME"]) / ".fledge"
    fledge.mkdir(parents=True, exist_ok=True)
    (fledge / "migration-in-progress.json").write_text("{}", encoding="utf-8")
    fledge.chmod(0o000)
    try:
        assert ms.read_marker() is None
    finally:
        fledge.chmod(0o700)


# ── 狀態機（§3.3.1 的六個 state） ────────────────────────────────────────────

def test_state_none_when_nothing_is_in_progress():
    assert ms.status() == {"state": "none"}


def test_state_none_when_marker_unusable_and_no_journal():
    path = Path(os.environ["HOME"]) / ".fledge" / "migration-in-progress.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("NOT JSON", encoding="utf-8")
    assert ms.status() == {"state": "none"}


def test_state_unfinished_unknown_when_journal_exists_without_usable_marker(
        tmp_path: Path):
    """有未清除的 journal 但沒有續作資訊：要說「上次沒完成」，但**不能**給繼續按鈕
    ——沒有 source_root 與 mapping，續作重算出來的是另一個 transaction。"""
    _journal("deadbeefdeadbeef", _good_record())
    assert ms.status() == {"state": "unfinished_unknown"}


def test_state_stale_marker_is_treated_as_finished_and_touches_nothing(
        tmp_path: Path):
    """journal 是**權威**：它被清掉代表那一輪完整成功了，殘留的 marker 只是刪除失敗的
    殘骸（§3.2 分兩步刪，崩在中間就是這個狀態）。

    **端點唯讀**（§3.3.2／§5）：不清除、不改寫——斷言 marker 的位元組與 mtime 一個都
    沒變。「唯讀查詢裡偷做寫入」正是本專案反覆強調的宣稱失真。"""
    ms.write_marker("no-such-journal", "/tmp/staging", [])
    marker = Path(os.environ["HOME"]) / ".fledge" / "migration-in-progress.json"
    before, before_stat = marker.read_bytes(), marker.stat()

    assert ms.status() == {"state": "stale_marker"}

    assert marker.read_bytes() == before
    assert marker.stat().st_mtime_ns == before_stat.st_mtime_ns


def test_state_source_missing_when_bundle_is_gone(tmp_path: Path):
    """matching journal 在，但展開的備份包不見了／不是 bundle 形狀 → 說得出「包已不在」
    並引導重新選包，**不給繼續按鈕**（續作會立刻撞 source_not_a_bundle）。"""
    plan = _plan(tmp_path)
    tid = inst.transaction_id(plan)
    _journal(tid, _good_record())
    ms.write_marker(tid, str(tmp_path / "not-a-bundle"), [])
    assert ms.status() == {"state": "source_missing"}


def test_state_journal_unreadable_uses_the_same_strictness_as_resuming(
        tmp_path: Path):
    """journal 讀得到但**解不出**：判準必須與 install 續作時實際會走的那條路徑一致
    （跨輪起底是「任何一行不完整即全體 fail-closed」）。用寬鬆版說「可續作」，使用者
    按下繼續只會拿到一整批 provenance_unavailable。"""
    plan = _plan(tmp_path)
    tid = inst.transaction_id(plan)
    _journal(tid, _good_record() + "NOT JSON\n")
    ms.write_marker(tid, plan.source_root, [])
    assert ms.status() == {"state": "journal_unreadable"}


def test_state_resumable_hands_back_source_and_mapping(tmp_path: Path):
    """三個條件都成立才說可以續作，並把預填用的兩樣東西交回去。"""
    plan = _plan(tmp_path)
    tid = inst.transaction_id(plan)
    _journal(tid, _good_record())
    ms.write_marker(tid, plan.source_root, [("/old/a", "/new/a")])
    assert ms.status() == {
        "state": "resumable",
        "source_root": plan.source_root,
        "mapping": [{"old": "/old/a", "new": "/new/a"}],
    }


def test_resume_info_never_leaks_into_other_states(tmp_path: Path):
    """`source_root`／`mapping` **只在 resumable 出現**（§3.3.2）：其餘狀態帶著它們，
    前端就可能拿一份不該用的續作資訊去預填。"""
    ms.write_marker("no-such-journal", "/tmp/staging", [("/old/a", "/new/a")])
    assert set(ms.status()) == {"state"}


def test_status_does_not_confuse_another_rounds_journal(tmp_path: Path):
    """**「有 journal」不等於「有這次的 journal」**（§3.3）：marker 指向 A、磁碟上只有
    B 的 journal 時不得說可續作——續作以 A 的 source_root＋mapping 重算出來的還是 A，
    讀不到 B，symlink 一樣補不回來。

    **也不得說「沒有未完成」**（Codex 票 07 R1 F1）：`write_marker()` 跑在 `install()`
    **之前**、matching journal 是 `install()` 內部才建的，所以「marker 在、它指的 journal
    不在」還有第二種來源——**它根本還沒建起來**（安裝正要開始、或 install 在開 journal 前
    就失敗）。第二輪一旦落在這個形狀，新 marker 就蓋掉了第一輪的：一律判「視同完成」會把
    第一輪那個沒收尾的 journal 整個遮蔽掉，使用者再也看不到「上次沒完成」。"""
    plan = _plan(tmp_path)
    tid = inst.transaction_id(plan)
    _journal("some-other-transaction", _good_record())      # 別人的、還沒收尾的
    ms.write_marker(tid, plan.source_root, [])
    assert ms.status() == {"state": "unfinished_unknown"}


def test_status_never_raises_when_fledge_is_unreadable():
    """唯讀的狀態查詢不該讓整張還原卡壞掉——`~/.fledge` 不可讀一律回 none。"""
    fledge = Path(os.environ["HOME"]) / ".fledge"
    fledge.mkdir(parents=True, exist_ok=True)
    fledge.chmod(0o000)
    try:
        assert ms.status() == {"state": "none"}
    finally:
        fledge.chmod(0o700)


def test_clear_marker_is_idempotent():
    """刪除 gate 可能在 marker 已經不在時再跑一次（重跑、續作），不該炸。"""
    ms.clear_marker()
    ms.write_marker("t", "/tmp/x", [])
    ms.clear_marker()
    ms.clear_marker()
    assert ms.read_marker() is None


def test_stale_marker_still_means_finished_when_nothing_is_left_behind(
        tmp_path: Path):
    """反面：**沒有任何** journal 時，marker 殘骸仍然視同完成——那時不論是「成功後刪
    marker 失敗」還是「根本沒開始」，都沒有任何沒收尾的東西，說「沒有未完成」都是對的。"""
    ms.write_marker("no-such-journal", "/tmp/staging", [])
    assert ms.status() == {"state": "stale_marker"}


def test_write_marker_fsyncs_the_directory_entry(tmp_path: Path, monkeypatch):
    """`os.replace` 之後**父目錄也要 fsync**（Codex 票 07 R1 F3）：斷電時 rename 本身不
    保證落盤——marker 可能整個消失（→ 沒有續作資訊）或舊的那份存活（→ 指向別輪）。

    這份簿記的存在理由就是「硬中斷之後接得回去」，而硬中斷包含斷電：**宣稱與實際保證
    等級必須逐字對齊**，少了這一步 docstring 就是在承諾做不到的事。"""
    synced: list[int] = []
    real_fsync = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: synced.append(fd) or real_fsync(fd))

    ms.write_marker("t", "/tmp/x", [])

    assert len(synced) >= 2, "檔案內容與父目錄各要一次"


def test_write_marker_survives_a_filesystem_without_dir_fsync(
        tmp_path: Path, monkeypatch):
    """目錄 fsync 不受支援（部分網路磁碟、exFAT）時**降級不擋安裝**——那是「這個檔案
    系統做不到」，不是「寫入失敗」。與 `install.py` 對每個目錄 fsync 同一立場。"""
    real_fsync = os.fsync

    def _no_dir_fsync(fd: int):
        if os.fstat(fd).st_mode & 0o170000 == 0o040000:      # 目錄
            raise OSError(22, "Invalid argument")
        return real_fsync(fd)

    monkeypatch.setattr(os, "fsync", _no_dir_fsync)

    ms.write_marker("t", "/tmp/x", [])
    got = ms.read_marker()
    assert got is not None and got["transaction_id"] == "t"

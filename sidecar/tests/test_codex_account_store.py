"""usage/codex_account_store.py——Codex 帳號每日用量的歷史檔（spec §5.2、§6-3／4／5／7）。"""
import fcntl
import json
import logging
import os
import stat
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from fledge_sidecar.usage import codex_account_store as store

NOW = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc).timestamp()


def _file(tmp_path: Path) -> Path:
    return tmp_path / "codex-account-usage.json"


def _raw(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_default_path_follows_config_dir_and_env(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("FLEDGE_CODEX_ACCOUNT_USAGE", raising=False)
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "cfg" / "config.json"))
    assert store.default_path() == tmp_path / "cfg" / "codex-account-usage.json"   # 不放 cache/：超過 10 天無法重建
    monkeypatch.setenv("FLEDGE_CODEX_ACCOUNT_USAGE", str(tmp_path / "x.json"))
    assert store.default_path() == tmp_path / "x.json"


def test_load_missing_file_is_empty(tmp_path: Path):
    h = store.load(_file(tmp_path))
    assert (h.accounts, h.default_model, h.fetches) == ({}, None, [])


def test_merge_creates_owner_only_file_without_leftovers(tmp_path: Path):
    p = _file(tmp_path / "sub")
    store.merge(p, "acc-1", {"2026-10-21": 5}, "gpt-6.1-sol", now=NOW)
    h = store.load(p)
    assert h.accounts == {"acc-1": {"2026-10-21": 5}} and h.default_model == "gpt-6.1-sol"
    assert stat.S_IMODE(p.stat().st_mode) == 0o600
    assert sorted(x.name for x in p.parent.iterdir()) == ["codex-account-usage.json", "codex-account-usage.json.lock"]


def test_merge_overwrites_returned_days_and_keeps_the_rest(tmp_path: Path):
    """上游只給 10 天：第 11 天以後才抓，最早那天仍在（§6-3）；同一天以新值為準，不重複累加。"""
    p = _file(tmp_path)
    store.merge(p, "acc-1", {f"2026-10-{d:02d}": d for d in range(11, 21)}, None, now=NOW)
    store.merge(p, "acc-1", {**{f"2026-10-{d:02d}": d for d in range(12, 21)}, "2026-10-12": 99, "2026-10-21": 21},
                None, now=NOW + 86400)
    assert store.load(p).accounts["acc-1"] == {**{f"2026-10-{d:02d}": d for d in range(11, 21)},
                                               "2026-10-12": 99, "2026-10-21": 21}


def test_merge_prunes_days_older_than_retention(tmp_path: Path):
    p = _file(tmp_path)
    p.write_text(json.dumps({"version": 1, "default_model": None, "fetches": [],
                             "accounts": {"acc-1": {"2025-09-16": 1, "2025-09-17": 2}}}), encoding="utf-8")
    store.merge(p, "acc-1", {}, None, now=NOW)        # 2026-10-22 往回 400 天＝2025-09-17
    assert store.load(p).accounts["acc-1"] == {"2025-09-17": 2}


def test_two_accounts_are_stored_apart(tmp_path: Path):
    """§6-5：帳號分開存、互不覆寫。"""
    p = _file(tmp_path)
    store.merge(p, "acc-a", {"2026-10-21": 5}, None, now=NOW)
    store.merge(p, "acc-b", {"2026-10-21": 7}, None, now=NOW)
    store.merge(p, "acc-a", {"2026-10-21": 9}, None, now=NOW)
    assert store.load(p).accounts == {"acc-a": {"2026-10-21": 9}, "acc-b": {"2026-10-21": 7}}


def test_default_model_is_kept_when_fetch_has_none(tmp_path: Path):
    p = _file(tmp_path)
    store.merge(p, "acc-1", {}, "gpt-6.1-sol", now=NOW)
    store.merge(p, "acc-1", {}, None, now=NOW)
    assert store.load(p).default_model == "gpt-6.1-sol"


def test_each_fetch_is_recorded_and_capped(tmp_path: Path, monkeypatch):
    """打包版 sidecar log 不落地：觀察紀錄記在歷史檔裡，之後回頭查上游行為。"""
    monkeypatch.setattr(store, "MAX_FETCHES", 3)
    p = _file(tmp_path)
    store.merge(p, "acc-1", {"2026-10-13": 1, "2026-10-12": 2, "2026-10-21": 3}, None, now=NOW)
    assert store.load(p).fetches == [{"at": NOW, "first": "2026-10-12", "last": "2026-10-21", "count": 3}]
    store.merge(p, "acc-1", {}, None, now=NOW + 1)
    assert store.load(p).fetches[-1] == {"at": NOW + 1, "first": None, "last": None, "count": 0}
    for i in range(2, 6):
        store.merge(p, "acc-1", {}, None, now=NOW + i)
    assert [f["at"] for f in store.load(p).fetches] == [NOW + 3, NOW + 4, NOW + 5]


def test_merge_waits_for_lock_and_rereads_inside_it(tmp_path: Path):
    """§6-4：另一個 Fledge 在我們等鎖期間寫進一個我們沒看過、上游也已經不給的日期，我們寫入後它仍在。"""
    p = _file(tmp_path)
    store.merge(p, "acc-1", {"2026-10-01": 1}, None, now=NOW)
    lock = os.open(str(p) + ".lock", os.O_RDWR)
    fcntl.flock(lock, fcntl.LOCK_EX)
    t = threading.Thread(target=store.merge, args=(p, "acc-1", {"2026-10-03": 3}, None, NOW))
    try:
        t.start()
        time.sleep(0.3)
        assert t.is_alive()                                       # 卡在鎖上，還沒寫
        other = _raw(p)
        other["accounts"]["acc-1"]["2026-10-02"] = 2              # 另一個實例在這時寫入
        p.write_text(json.dumps(other), encoding="utf-8")
    finally:
        os.close(lock)
        t.join(5)
    assert store.load(p).accounts["acc-1"] == {"2026-10-01": 1, "2026-10-02": 2, "2026-10-03": 3}


@pytest.mark.parametrize("content", [
    b"{not json",
    b"\xff\xfe\x00garbage",
    json.dumps({"version": 0, "accounts": {}, "default_model": None, "fetches": []}).encode(),
    json.dumps({"version": True, "accounts": {}, "default_model": None, "fetches": []}).encode(),
    json.dumps({"version": 1, "accounts": {"acc-1": {"2026-10-21": "5"}}, "default_model": None,
                "fetches": []}).encode(),
    json.dumps({"version": 1, "accounts": {"acc-1": {"2026-10-21": -1}}, "default_model": None,
                "fetches": []}).encode(),
    json.dumps({"version": 1, "accounts": {"acc-1": {"10/21": 5}}, "default_model": None, "fetches": []}).encode(),
    json.dumps({"version": 1, "accounts": {"acc-1": {}}, "default_model": None}).encode(),
], ids=["not-json", "not-utf8", "other-version", "bool-version", "str-tokens", "negative-tokens", "bad-date", "no-fetches"])
def test_corrupt_file_is_kept_aside_and_started_fresh(tmp_path: Path, caplog, content):
    """§6-7：原檔改名保留、記 warning、從空的重新開始——不可直接覆蓋。"""
    p = _file(tmp_path)
    p.write_bytes(content)
    with caplog.at_level(logging.WARNING, logger=store.__name__):
        store.merge(p, "acc-1", {"2026-10-21": 5}, None, now=NOW)
    kept = [x for x in tmp_path.iterdir() if x.name.startswith("codex-account-usage.json.corrupt-")]
    assert len(kept) == 1 and kept[0].read_bytes() == content
    assert store.load(p).accounts == {"acc-1": {"2026-10-21": 5}}
    assert any(kept[0].name in r.getMessage() for r in caplog.records)


def test_newer_version_is_left_alone(tmp_path: Path):
    """較新的 Fledge 寫的歷史檔（version 比本版大）不是壞檔：這一輪放棄寫入、原檔不動、不改名，讀取端當成空的。
    打包版與 dev 版常同時開——舊版若把它當壞檔改名，新版累積的歷史就從卡片上消失（合併前審查）。"""
    p = _file(tmp_path)
    content = json.dumps({"version": 2, "accounts": {"acc-1": {"2026-10-20": 1}}, "default_model": None,
                          "fetches": []}).encode()
    p.write_bytes(content)
    raised = None
    try:
        store.merge(p, "acc-1", {"2026-10-21": 5}, None, now=NOW)
    except Exception as exc:  # noqa: BLE001 —— 先比內容，再看拋的是不是 NewerVersionError
        raised = exc
    assert p.read_bytes() == content
    assert not [x for x in tmp_path.iterdir() if ".corrupt-" in x.name]
    assert type(raised).__name__ == "NewerVersionError"
    assert store.load(p).accounts == {}


def test_load_of_corrupt_file_is_empty_and_leaves_it_alone(tmp_path: Path):
    p = _file(tmp_path)
    p.write_bytes(b"{not json")
    assert store.load(p).accounts == {}
    assert sorted(x.name for x in tmp_path.iterdir()) == ["codex-account-usage.json"]
    assert p.read_bytes() == b"{not json"


@pytest.mark.skipif(os.geteuid() == 0, reason="root 不受檔案權限限制")
def test_unreadable_file_is_not_treated_as_corrupt(tmp_path: Path):
    """讀不到不等於壞掉：這一輪放棄、原檔不動、也不改名。"""
    p = _file(tmp_path)
    store.merge(p, "acc-1", {"2026-10-21": 5}, None, now=NOW)
    before = p.read_bytes()
    p.chmod(0)
    raised = None
    try:
        store.merge(p, "acc-1", {"2026-10-22": 6}, None, now=NOW)
    except PermissionError as exc:
        raised = exc
    finally:
        p.chmod(0o600)
    assert p.read_bytes() == before                       # 先比內容：被當壞檔覆蓋時要紅在這裡
    assert not [x for x in tmp_path.iterdir() if ".corrupt-" in x.name]
    assert isinstance(raised, PermissionError)


def test_directory_is_synced_after_each_rename(tmp_path: Path, monkeypatch):
    """換名本身也要落地（Codex plan R2）：上游每天往後滑，這次寫入若沒留下，最舊那天隔天就補不回來。
    每次 os.replace 之後同步所在目錄——壞檔改名保留那次也算。記下每次同步當下「新內容是否已換上」。"""
    p = _file(tmp_path)
    p.write_bytes(b"{not json")
    seen = []
    real = store._fsync_dir

    def spy(d):
        seen.append((d, p.exists() and b'"2026-10-21": 5' in p.read_bytes()))
        real(d)
    monkeypatch.setattr(store, "_fsync_dir", spy)
    store.merge(p, "acc-1", {"2026-10-21": 5}, None, now=NOW)
    assert seen == [(tmp_path, False), (tmp_path, True)]   # 壞檔改名之後一次、新內容換上之後一次


def test_directory_sync_failure_is_raised(tmp_path: Path, monkeypatch):
    """目錄同步失敗要往外拋（背景工作記 warning、下一輪重來），不能當成成功吞掉；暫存檔不殘留。"""
    p = _file(tmp_path)

    def boom(d):
        raise OSError("fsync failed")
    monkeypatch.setattr(store, "_fsync_dir", boom)
    raised = None
    try:
        store.merge(p, "acc-1", {"2026-10-21": 5}, None, now=NOW)
    except OSError as exc:
        raised = exc
    assert isinstance(raised, OSError)
    assert [x.name for x in tmp_path.iterdir() if x.name.endswith(".tmp")] == []


def test_failed_replace_keeps_old_file_and_removes_temp(tmp_path: Path, monkeypatch):
    p = _file(tmp_path)
    store.merge(p, "acc-1", {"2026-10-21": 5}, None, now=NOW)
    before = p.read_bytes()

    def boom(src, dst):
        raise OSError("disk full")
    monkeypatch.setattr(store.os, "replace", boom)
    with pytest.raises(OSError):
        store.merge(p, "acc-1", {"2026-10-22": 6}, None, now=NOW)
    assert p.read_bytes() == before
    assert [x.name for x in tmp_path.iterdir() if x.name.endswith(".tmp")] == []   # 暫存檔名是亂數，單獨斷言
    assert sorted(x.name for x in tmp_path.iterdir()) == ["codex-account-usage.json", "codex-account-usage.json.lock"]

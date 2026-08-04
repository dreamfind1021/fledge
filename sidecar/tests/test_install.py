"""`backup/install.py` 的行為契約。

**全程假 HOME + tmp_path，絕不碰真實的 ~/.claude。** 這個模組是唯一有能力寫現役目錄的
還原路徑，測試自己更要守住同一條線。
"""
import json
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import make_staging as _staging

from fledge_sidecar.backup import install as inst


@pytest.fixture(autouse=True)
def _fake_home(tmp_path: Path, monkeypatch):
    """票 04 起 install() 會寫 provenance journal 到 ~/.fledge——沒有這層假 HOME，
    本檔任何一條 install 測試都會寫進真實家目錄（硬性要求：絕不碰真實 ~/.claude、
    ~/.claude-tc、~/.fledge）。個別測試自己 setenv HOME 會蓋過這裡，不衝突。

    要真的 mkdir：票 04 R2 F1 後 journal 開啟走 fd-relative（從 home fd 逐層 O_NOFOLLOW），
    home 不存在會直接 journal_unavailable——真實環境 home 一定在，測試也要比照。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))


def _accounts(target: Path) -> dict[str, dict[str, str]]:
    return {"work": {"config_dir": str(target), "label": ""}}


def test_plan_counts_what_will_be_installed(tmp_path: Path):
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    assert p.targets == {"work": str(tgt.resolve())}
    assert p.will_install == 2          # skills/a.md 與 CLAUDE.md
    assert p.will_skip == []


def test_plan_lists_existing_targets_as_skip(tmp_path: Path):
    """現役已有的不會被覆蓋——plan 階段就要說得出來，不能等 install 才發現。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    (tgt / "CLAUDE.md").write_text("MINE", encoding="utf-8")
    p = inst.plan(str(src), _accounts(tgt))
    assert p.will_skip == ["CLAUDE.md"]
    assert p.will_install == 1


def test_plan_excludes_claude_json(tmp_path: Path):
    """.claude.json 混著真資產、機器身分與快取，一律不碰（spec 決策 3）。"""
    src = _staging(tmp_path)
    (src / "accounts" / "work" / ".claude.json").write_text("{}", encoding="utf-8")
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    assert ".claude.json" in p.excluded
    assert p.will_install == 2          # 沒把它算進去


def test_plan_refuses_source_without_manifest(tmp_path: Path):
    """來源必須是我們展開的目錄，不對任意目錄執行搬移。"""
    bare = tmp_path / "bare"
    bare.mkdir()
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.plan(str(bare), _accounts(tmp_path / "live"))


def test_plan_refuses_config_dir_at_home_or_above(tmp_path: Path, monkeypatch):
    """底線防呆（ADR-0001）：config_dir 是 home 本身或祖先時 containment 形同不設防。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    src = _staging(tmp_path)
    for bad in (str(home), str(tmp_path), "/"):
        with pytest.raises(ValueError, match="unsafe_config_dir"):
            inst.plan(str(src), {"work": {"config_dir": bad, "label": ""}})


def test_plan_rejects_path_like_account_keys(tmp_path: Path):
    """account key 會被拼進 Path(root, 'accounts', key)：絕對 key 讓 Path 丟棄 root、
    `..` key 走出 staging、含分隔符的 key 也一樣——而 manifest 是不可信輸入、config 的
    accounts 又可能被手動編輯。key 在模組信任邊界重驗（與 routes/config.py 的 _KEY_RE
    同規則），不依賴 config API 擋（Codex 票 03 R4）。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    for bad in ("/etc", "../outside", "a/b", ".", ".."):
        manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
        manifest["accounts"] = {bad: "/Users/olduser/.claude"}
        (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with pytest.raises(ValueError, match="invalid_account_key"):
            inst.plan(str(src), {bad: {"config_dir": str(tgt), "label": ""}})


def test_install_copies_files_into_empty_target(tmp_path: Path):
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert {r.outcome for r in results} == {"installed"}
    assert (tgt / "skills" / "a.md").read_text(encoding="utf-8") == "SKILL"
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"


def test_install_never_overwrites_existing(tmp_path: Path):
    """現役內容必須逐位元組不變——這是整個功能的核心保證。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    (tgt / "CLAUDE.md").write_text("MINE", encoding="utf-8")
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "MINE"
    assert any(r.rel_path == "CLAUDE.md" and r.outcome == "skipped" for r in results)


def test_install_is_idempotent(tmp_path: Path):
    """重跑：已裝的判 skipped，現役目錄零變化。中斷續作完全靠這個性質。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    inst.install(inst.plan(str(src), _accounts(tgt)))
    before = {p: p.read_bytes() for p in tgt.rglob("*") if p.is_file()}
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert {r.outcome for r in results} == {"skipped"}
    assert {p: p.read_bytes() for p in tgt.rglob("*") if p.is_file()} == before


def test_install_stops_when_source_root_swapped_after_plan(tmp_path: Path):
    """plan 到 install 之間 staging 被換掉 → 整批停手，不是跳過單項。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    impostor = _staging(tmp_path / "other")
    os.rename(src, tmp_path / "moved-away")
    os.rename(impostor, src)
    with pytest.raises(ValueError, match="source_root_moved"):
        inst.install(p)
    assert list(tgt.iterdir()) == []          # 一個檔案都沒寫


def test_install_stops_account_when_target_swapped_after_plan(tmp_path: Path):
    """plan 到 install 之間 target 被換掉 → 該帳號停手回 target_moved、一個檔案都不寫
    （票 03 R1：target 側的 identity 重驗，比照票 10 的 source 側；縮小窗口不是關閉）。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    os.rename(tgt, tmp_path / "moved-away")
    (tmp_path / "live").mkdir()                           # 替身
    results = inst.install(p)
    assert any(r.outcome == "failed" and r.error == "target_moved" for r in results)
    assert list((tmp_path / "live").iterdir()) == []      # 替身一個檔案都沒收到
    assert list((tmp_path / "moved-away").iterdir()) == []  # 原目錄也沒收到


def test_install_isolates_account_level_failure(tmp_path: Path):
    """單一帳號的落點壞掉（被一般檔占用）不得株連其餘帳號，也不得讓 OSError 穿出
    install()——route 只接 ValueError，穿出去就是裸 500（Codex 票 03 R2）。"""
    src = _staging(tmp_path)
    (src / "accounts" / "personal").mkdir()
    (src / "accounts" / "personal" / "CLAUDE.md").write_text("P", encoding="utf-8")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["personal"] = "/Users/olduser/.claude-tc"
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    tgt_work = tmp_path / "live-work"
    tgt_work.write_text("occupied", encoding="utf-8")     # work 的落點被檔案占用
    tgt_personal = tmp_path / "live-personal"
    tgt_personal.mkdir()
    accounts = {
        "work": {"config_dir": str(tgt_work), "label": ""},
        "personal": {"config_dir": str(tgt_personal), "label": ""},
    }
    results = inst.install(inst.plan(str(src), accounts))  # 不得 raise
    assert any(r.account == "work" and r.outcome == "failed" for r in results)
    assert (tgt_personal / "CLAUDE.md").read_text(encoding="utf-8") == "P"
    assert tgt_work.read_text(encoding="utf-8") == "occupied"   # 佔位檔一位元組不變


def test_install_fsyncs_account_root_before_returning(tmp_path: Path, monkeypatch):
    """根層檔案（如 CLAUDE.md）的目錄項持久性掛在 root dst_fd 的 fsync 上——只 fsync
    遞迴開出的子目錄的話，斷電後根層檔案連目錄項都可能消失，而 API 已回報 installed
    （Codex 票 03 R1）。spy 記 inode：root 目錄必須在被 fsync 的集合裡。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    synced: list[tuple[int, int]] = []
    real_fsync = os.fsync

    def _spy(fd):
        st = os.fstat(fd)
        synced.append((st.st_dev, st.st_ino))
        return real_fsync(fd)

    monkeypatch.setattr(inst.os, "fsync", _spy)
    inst.install(inst.plan(str(src), _accounts(tgt)))
    root_stat = os.stat(tgt)
    assert (root_stat.st_dev, root_stat.st_ino) in synced


def test_plan_and_install_agree_when_bundle_contains_file_symlinks(tmp_path: Path):
    """plan 用 os.walk、install 用 scandir——file symlink 在前者落進 filenames、在後者
    被略過（票 04 的第二階段才處理），兩邊語意不一致的話預覽數字就會穩定虛報
    （Codex 票 03 R1）。斷鏈 symlink 同理。"""
    src = _staging(tmp_path)
    work = src / "accounts" / "work"
    (work / "linked.md").symlink_to(work / "CLAUDE.md")   # 指向包內一般檔
    (work / "dangling.md").symlink_to(work / "nope")      # 斷鏈
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    assert p.will_install == 2                            # 兩條 symlink 都不算
    results = inst.install(p)
    installed = [r for r in results if r.outcome == "installed"]
    assert len(installed) == p.will_install
    assert not os.path.lexists(tgt / "linked.md")
    assert not os.path.lexists(tgt / "dangling.md")


def test_plan_marks_leaves_blocked_when_target_ancestor_is_a_file(tmp_path: Path):
    """目的地的 skills 是一般檔：install 只會在目錄層 fail、葉檔根本到不了——plan 把
    該子樹的葉檔列 blocked 而非算進 will_install，預覽數字才對得上（Codex 票 03 R2）。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    (tgt / "skills").write_text("occupied", encoding="utf-8")
    p = inst.plan(str(src), _accounts(tgt))
    assert p.will_install == 1                            # 只剩 CLAUDE.md
    assert os.path.join("skills", "a.md") in p.blocked
    results = inst.install(p)
    installed = [r for r in results if r.outcome == "installed"]
    assert len(installed) == p.will_install
    assert any(r.rel_path == "skills" and r.outcome == "failed" for r in results)
    assert (tgt / "skills").read_text(encoding="utf-8") == "occupied"   # 佔位檔不變


def test_plan_blocks_subtree_behind_symlinked_target_ancestor(tmp_path: Path):
    """目的地的 skills 是 symlink（即使指向真目錄）：install 的 O_NOFOLLOW 一律拒開，
    plan 要同語意列 blocked；連結指向的外部目錄不得收到任何寫入。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (tgt / "skills").symlink_to(outside)
    p = inst.plan(str(src), _accounts(tgt))
    assert p.will_install == 1
    assert os.path.join("skills", "a.md") in p.blocked
    results = inst.install(p)
    assert len([r for r in results if r.outcome == "installed"]) == p.will_install
    assert list(outside.iterdir()) == []                  # 外部目錄零寫入


def test_special_files_are_never_opened_nor_counted(tmp_path: Path):
    """FIFO 以 O_RDONLY 開啟會阻塞到有 writer 為止——特殊檔必須連 open 都不碰，
    plan 也不得把它算進 will_install（兩邊語意要一致）。"""
    src = _staging(tmp_path)
    os.mkfifo(src / "accounts" / "work" / "pipe")
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    assert p.will_install == 2                            # FIFO 不算
    results = inst.install(p)
    assert not os.path.lexists(tgt / "pipe")
    assert any(r.rel_path == "pipe" and r.outcome == "excluded" for r in results)


def test_install_excludes_claude_json_from_target(tmp_path: Path):
    """驗收：.claude.json 在結果的「不處理」清單裡，且目標位置確實沒有它。"""
    src = _staging(tmp_path)
    (src / "accounts" / "work" / ".claude.json").write_text("{}", encoding="utf-8")
    tgt = tmp_path / "live"
    tgt.mkdir()
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert not (tgt / ".claude.json").exists()
    assert any(r.rel_path == ".claude.json" and r.outcome == "excluded" for r in results)


def _staging_two_accounts_second_blocked(tmp_path: Path) -> tuple[Path, dict]:
    """雙帳號 staging，第二帳號（personal）的落點被一般檔占用 → 帳號級 failed →
    整體未完整成功。回 (src, accounts)。"""
    src = _staging(tmp_path)
    (src / "accounts" / "personal").mkdir()
    (src / "accounts" / "personal" / "P.md").write_text("P", encoding="utf-8")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["personal"] = "/Users/olduser/.claude-tc"
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    tgt_work = tmp_path / "live-work"
    tgt_work.mkdir()
    tgt_personal = tmp_path / "live-personal"
    tgt_personal.write_text("occupied", encoding="utf-8")
    accounts = {
        "work": {"config_dir": str(tgt_work), "label": ""},
        "personal": {"config_dir": str(tgt_personal), "label": ""},
    }
    return src, accounts


def test_journal_cleared_on_full_success(tmp_path: Path, monkeypatch):
    """完整成功 → journal 清除（ADR-0006：留著會讓還原卡永遠顯示「上次移機未完成」）。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    inst.install(p)
    assert not inst.journal_path(inst.transaction_id(p)).exists()
    assert inst.installed_nodes(inst.transaction_id(p)) == set()


def test_journal_kept_and_records_nodes_when_incomplete(tmp_path: Path, monkeypatch):
    """中途失敗 → journal 保留，且記錄了成功帳號的 node（中斷續作的基礎）。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src, accounts = _staging_two_accounts_second_blocked(tmp_path)
    p = inst.plan(str(src), accounts)
    results = inst.install(p)
    assert any(r.outcome == "failed" for r in results)
    recorded = inst.installed_nodes(inst.transaction_id(p))
    assert "work/CLAUDE.md" in recorded
    assert "work/skills/a.md" in recorded


def test_journal_corrupt_lines_do_not_break_reading(tmp_path: Path, monkeypatch):
    """簿記損壞（壞行）不讓移機失敗：壞行跳過、好行照讀。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    tid = "deadbeef00000000"
    jp = inst.journal_path(tid)
    jp.parent.mkdir(parents=True, exist_ok=True)
    jp.write_text('{"node": "work/a.md"}\nNOT JSON AT ALL\n{"node": "work/b.md"}\n',
                  encoding="utf-8")
    assert inst.installed_nodes(tid) == {"work/a.md", "work/b.md"}


def test_transaction_id_changes_when_staging_reexpanded(tmp_path: Path, monkeypatch):
    """同一 staging 路徑換一份 bundle（刪掉重展＝新 inode）→ 新 transaction_id，不讀到
    前次殘留的 journal node（Codex 票 04 R1 F1：provenance 跨 bundle／落點污染）。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    tid1 = inst.transaction_id(inst.plan(str(src), _accounts(tgt)))
    import shutil
    shutil.rmtree(src)
    src2 = _staging(tmp_path)                # 同路徑、新 inode
    tid2 = inst.transaction_id(inst.plan(str(src2), _accounts(tgt)))
    assert tid1 != tid2


def test_transaction_id_changes_when_target_changes(tmp_path: Path, monkeypatch):
    """同一 staging、改落點重跑 → 新 transaction_id：舊 journal 記的 node 相對舊落點，
    不該拿來授權新落點的既有內容（Codex 票 04 R1 F1）。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src = _staging(tmp_path)
    tid1 = inst.transaction_id(inst.plan(str(src), _accounts(tmp_path / "live1")))
    tid2 = inst.transaction_id(inst.plan(str(src), _accounts(tmp_path / "live2")))
    assert tid1 != tid2


def test_installed_nodes_distinguishes_missing_from_unreadable(tmp_path: Path, monkeypatch):
    """journal 不存在＝正常（回空）；存在但讀不出＝降級（拋，呼叫端據此保留）——
    兩者混為一談會把 IO 錯誤當「沒發布過」（Codex 票 04 R1 F3）。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert inst.installed_nodes("missing0000000000") == set()   # 不存在 → 空
    tid = "cafe000000000000"
    jp = inst.journal_path(tid)
    jp.parent.mkdir(parents=True, exist_ok=True)
    jp.write_text('{"node": "work/a.md"}\n', encoding="utf-8")
    real_read = Path.read_text

    def _boom(self, *a, **k):
        if self == jp:
            raise PermissionError(13, "unreadable")
        return real_read(self, *a, **k)

    monkeypatch.setattr(Path, "read_text", _boom)
    with pytest.raises(OSError):
        inst.installed_nodes(tid)


def test_install_keeps_journal_when_provenance_read_degrades(tmp_path: Path, monkeypatch):
    """第二階段 journal 重讀降級 → pending symlink 判 failed（不是 excluded）、journal
    保留：不能靜默略過 symlink 又清掉續作依據並誤報成功（Codex 票 04 R1 F3）。"""
    src = _staging_with_link(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    p = inst.plan(str(src), _accounts(tgt))

    def _boom(_source_root):
        raise OSError(5, "io error")

    # 第二階段的 provenance 讀取（read_manifest→pread journal_fd）任一降級都該保留 journal。
    # plan 已跑完，此 monkeypatch 只擊中 install 第二階段的 read_manifest。
    monkeypatch.setattr(inst, "read_manifest", _boom)
    results = inst.install(p)
    assert any(r.rel_path == "linked" and r.outcome == "failed" for r in results)
    assert inst.journal_path(inst.transaction_id(p)).exists()   # 未誤清


def test_journal_open_refuses_symlinked_journal_file(tmp_path: Path, monkeypatch):
    """~/.fledge/<journal> 是 symlink → 不跟隨、不把 JSONL append 到它指向的檔案，
    回 journal_unavailable（Codex 票 04 R2 F1）。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".fledge").mkdir(parents=True)
    victim = tmp_path / "victim.txt"
    victim.write_text("SACRED", encoding="utf-8")
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    inst.journal_path(inst.transaction_id(p)).symlink_to(victim)
    with pytest.raises(ValueError, match="journal_unavailable"):
        inst.install(p)
    assert victim.read_text(encoding="utf-8") == "SACRED"   # 零污染


def test_journal_open_refuses_symlinked_fledge_dir(tmp_path: Path, monkeypatch):
    """~/.fledge 本身是 symlink → 不跟隨（O_NOFOLLOW 只擋最後元件不夠，父目錄也要 pin）。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "home" / ".fledge").symlink_to(outside)   # home 由 autouse fixture 建
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    with pytest.raises(ValueError, match="journal_unavailable"):
        inst.install(p)
    assert list(outside.iterdir()) == []


def test_provenance_read_uses_pinned_fd_not_pathname(tmp_path: Path, monkeypatch):
    """journal 開啟後、第二階段讀取前，被換成 symlink 指向攻擊者的偽 journal（宣稱某個
    現役既有 node 是本次發布的）→ 讀取走已 pin 的 fd 不跟隨、injected node 不授權 symlink
    （Codex 票 04 R3：F1 只修了 journal 寫入開啟，讀取還在用 pathname）。"""
    src = _staging(tmp_path)
    (src / "accounts" / "work" / "evil").symlink_to("/Users/olduser/.claude/private")
    tgt = _home_target(tmp_path, monkeypatch)
    (tgt / "private").mkdir()
    (tgt / "private" / "secret.md").write_text("MINE", encoding="utf-8")
    fake = tmp_path / "fake-journal.jsonl"
    fake.write_text('{"node": "work/private"}\n', encoding="utf-8")   # 冒認 private 是本次裝的
    p = inst.plan(str(src), _accounts(tgt))
    real_read_manifest = inst.read_manifest

    def _swap_then_read(source_root):
        jp = inst.journal_path(inst.transaction_id(p))
        if jp.exists() and not jp.is_symlink():
            jp.unlink()
            jp.symlink_to(fake)            # 階段間把真 journal 換成指向偽 journal 的 symlink
        return real_read_manifest(source_root)

    monkeypatch.setattr(inst, "read_manifest", _swap_then_read)   # 只第二階段呼叫（plan 已跑完）
    results = inst.install(p)
    assert not os.path.lexists(tgt / "evil")   # injected node 未授權，連結沒建
    assert (tgt / "private" / "secret.md").read_text(encoding="utf-8") == "MINE"


def test_journal_id_is_stable_for_same_bundle_and_dest(tmp_path: Path, monkeypatch):
    """同一次還原的重跑必須接上同一份 journal，否則續作認不出前一輪。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    a = inst.transaction_id(inst.plan(str(src), _accounts(tgt)))
    b = inst.transaction_id(inst.plan(str(src), _accounts(tgt)))
    assert a == b


def _home_target(tmp_path: Path, monkeypatch) -> Path:
    """symlink 授權判準假設新機帳號目錄落在 new_home 的對應位置（spec §4.2.2／§4.2.3
    決策 9／10：舊路徑 `<old_home>/.claude` → `<new_home>/.claude`）。自訂 config_dir
    下 rewrite 對不上任何 node、symlink 一律 fail-safe 不建，那不是本區塊要測的。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir(exist_ok=True)
    tgt = tmp_path / "home" / ".claude"
    tgt.mkdir()
    return tgt


def _staging_with_link(tmp_path: Path) -> Path:
    """備份包裡有一條指向同帳號內另一個項目的 symlink（共通設置的典型形狀）。"""
    src = _staging(tmp_path)
    work = src / "accounts" / "work"
    (work / "commands").mkdir()
    (work / "commands" / "c.md").write_text("CMD", encoding="utf-8")
    (work / "linked").symlink_to("/Users/olduser/.claude/commands")
    return src


def test_symlink_built_when_target_was_installed(tmp_path: Path, monkeypatch):
    src = _staging_with_link(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    inst.install(inst.plan(str(src), _accounts(tgt)))
    assert (tgt / "linked").is_symlink()
    assert (tgt / "linked" / "c.md").read_text(encoding="utf-8") == "CMD"


def test_symlink_refused_when_target_outside_authorized_set(tmp_path: Path, monkeypatch):
    """指向授權集合外的絕對路徑 → 不建立，列進 excluded。"""
    src = _staging(tmp_path)
    (src / "accounts" / "work" / "evil").symlink_to("/etc/hosts")
    tgt = _home_target(tmp_path, monkeypatch)
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert not os.path.lexists(tgt / "evil")
    assert any(r.rel_path == "evil" and r.outcome == "excluded" for r in results)


def test_symlink_refused_when_target_exists_but_not_installed_by_us(tmp_path: Path, monkeypatch):
    """R4 抓到的具體攻擊：目標在授權 root 內、型別也相符，但不是本次搬過去的。

    對目錄而言，型別相符會一次暴露整棵既有內容——所以判準是 provenance 不是型別。"""
    src = _staging(tmp_path)
    (src / "accounts" / "work" / "peek").symlink_to("/Users/olduser/.claude/private")
    tgt = _home_target(tmp_path, monkeypatch)
    (tgt / "private").mkdir(parents=True)
    (tgt / "private" / "secret.md").write_text("MINE", encoding="utf-8")
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert not os.path.lexists(tgt / "peek")
    assert (tgt / "private" / "secret.md").read_text(encoding="utf-8") == "MINE"
    assert any(r.rel_path == "peek" and r.outcome == "excluded" for r in results)


def test_symlink_refused_when_relative_or_dotdot_escape(tmp_path: Path, monkeypatch):
    """相對路徑往上逃逸、或前綴合法但內嵌 `..` 的字面目標 → 都不建立。"""
    src = _staging(tmp_path)
    work = src / "accounts" / "work"
    (work / "esc1").symlink_to("../../../outside/secret")
    (work / "esc2").symlink_to("/Users/olduser/.claude/commands/../../../etc")
    tgt = _home_target(tmp_path, monkeypatch)
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    for name in ("esc1", "esc2"):
        assert not os.path.lexists(tgt / name)
        assert any(r.rel_path == name and r.outcome == "excluded" for r in results)


def test_symlink_refused_when_pointing_at_account_root_or_ancestor(tmp_path: Path, monkeypatch):
    """指向帳號目錄本身或其祖先 → 不建立（根不是 node、祖先更不是）。"""
    src = _staging(tmp_path)
    work = src / "accounts" / "work"
    (work / "self").symlink_to("/Users/olduser/.claude")
    (work / "up").symlink_to("/Users/olduser")
    tgt = _home_target(tmp_path, monkeypatch)
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    for name in ("self", "up"):
        assert not os.path.lexists(tgt / name)
        assert any(r.rel_path == name and r.outcome == "excluded" for r in results)


def test_symlink_phase_does_not_follow_intermediate_dir_swapped_between_phases(
        tmp_path: Path, monkeypatch):
    """第一階段建了真的中間目錄 sub，第二階段前 sub 被換成指向外部的 symlink →
    fd-relative 逐層 O_NOFOLLOW 拒絕跟隨、連結不落到外部（Codex 票 04 R1 F2）。

    用 installed_nodes 被呼叫當「第一階段已結束」的信號在階段間注入替換。"""
    src = _staging(tmp_path)
    work = src / "accounts" / "work"
    (work / "sub").mkdir()
    (work / "sub" / "c.md").write_text("CMD", encoding="utf-8")
    (work / "sub" / "linked").symlink_to("/Users/olduser/.claude/sub/c.md")
    tgt = _home_target(tmp_path, monkeypatch)
    outside = tmp_path / "outside"
    outside.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    real_read_manifest = inst.read_manifest

    def _swap_then_read(source_root):
        sub = tgt / "sub"
        if sub.is_dir() and not sub.is_symlink():
            import shutil
            shutil.rmtree(sub)
            (tgt / "sub").symlink_to(outside)      # 換成指向外部的 symlink
        return real_read_manifest(source_root)

    # read_manifest 是第二階段第一個 provenance 步驟；plan 已跑完，只擊中第二階段。
    monkeypatch.setattr(inst, "read_manifest", _swap_then_read)
    results = inst.install(p)
    assert list(outside.iterdir()) == []           # 外部零寫入
    assert any(r.rel_path == os.path.join("sub", "linked") and r.outcome == "failed"
               for r in results)


def test_symlink_built_via_dir_fd_not_full_pathname(tmp_path: Path, monkeypatch):
    """釘住 fd-relative 手法本身：os.symlink 收到 dir_fd 與 basename，不是完整 pathname
    （避免退回 pathname 的迴歸）。"""
    src = _staging_with_link(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    seen: dict = {}
    real_symlink = os.symlink

    def _spy(target, linkpath, *, dir_fd=None):
        seen["dir_fd"] = dir_fd
        seen["linkpath"] = linkpath
        return real_symlink(target, linkpath, dir_fd=dir_fd)

    monkeypatch.setattr(inst.os, "symlink", _spy)
    inst.install(inst.plan(str(src), _accounts(tgt)))
    assert seen["dir_fd"] is not None
    assert os.sep not in seen["linkpath"]          # basename，非完整 pathname


def test_symlink_cycle_builds_neither(tmp_path: Path, monkeypatch):
    """兩條互相指向的連結：目標都是 symlink、都不是本次發布的 node → 都不建立。"""
    src = _staging(tmp_path)
    work = src / "accounts" / "work"
    (work / "a").symlink_to("/Users/olduser/.claude/b")
    (work / "b").symlink_to("/Users/olduser/.claude/a")
    tgt = _home_target(tmp_path, monkeypatch)
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    for name in ("a", "b"):
        assert not os.path.lexists(tgt / name)
        assert any(r.rel_path == name and r.outcome == "excluded" for r in results)


def test_install_does_not_follow_symlinked_subdir_out_of_staging(tmp_path: Path):
    """惡意 bundle：staging 內的子目錄是指向外面的 symlink → 不得跟隨、不得寫出去。"""
    src = _staging(tmp_path)
    outside = tmp_path / "outside"
    (outside / "secret").mkdir(parents=True)
    (outside / "secret" / "x.md").write_text("SECRET", encoding="utf-8")
    (src / "accounts" / "work" / "escaped").symlink_to(outside / "secret")
    tgt = tmp_path / "live"
    tgt.mkdir()
    inst.install(inst.plan(str(src), _accounts(tgt)))
    assert not (tgt / "escaped" / "x.md").exists()


# ---------- 票 07：adopt-config 的授權時刻驗證 ----------


def test_validate_landing_spots_resolves_and_rejects(tmp_path: Path, monkeypatch):
    """授權發生的那一刻驗最嚴（spec §4.2.2）：key 文法（extra 用 extra:<name>，驗冒號
    後的裸名）、路徑重驗與帳號同一條規則（home／祖先拒）。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    ok = inst.validate_landing_spots(
        {"work": str(tmp_path / "a"), "extra:agents": str(tmp_path / "b")})
    assert ok == {"work": str(tmp_path / "a"), "extra:agents": str(tmp_path / "b")}
    with pytest.raises(ValueError, match="invalid_account_key"):
        inst.validate_landing_spots({"a/b": str(tmp_path / "a")})
    with pytest.raises(ValueError, match="invalid_account_key"):
        inst.validate_landing_spots({"extra:../x": str(tmp_path / "a")})
    with pytest.raises(ValueError, match="unsafe_config_dir"):
        inst.validate_landing_spots({"work": str(home)})


def test_validate_landing_spots_rejects_overlap(tmp_path: Path, monkeypatch):
    """落點互為祖先（含帳號×extra 交叉）→ overlapping_config_dirs：外層的安裝會把
    內層目錄整個蓋掉。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    with pytest.raises(ValueError, match="overlapping_config_dirs"):
        inst.validate_landing_spots(
            {"work": str(tmp_path / "a"), "personal": str(tmp_path / "a" / "sub")})
    with pytest.raises(ValueError, match="overlapping_config_dirs"):
        inst.validate_landing_spots(
            {"work": str(tmp_path / "a"), "extra:agents": str(tmp_path / "a")})


def test_plan_rejects_overlapping_landing_spots(tmp_path: Path, monkeypatch):
    """重疊檢查不能只在 adopt 授權時跑一次（Codex 票 07 R1 F2）：config 可被手編，
    install 時的 plan 必須以**當時的解析結果**對所有落點（帳號＋extra）重驗——巢狀
    落點會讓外層的安裝把內容灌進內層落點的樹裡。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    src = _staging_with_extra(tmp_path)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["personal"] = "/Users/olduser/.claude-tc"
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    nested_accounts = {
        "work": {"config_dir": str(tmp_path / "a"), "label": ""},
        "personal": {"config_dir": str(tmp_path / "a" / "sub"), "label": ""},
    }
    with pytest.raises(ValueError, match="overlapping_config_dirs"):
        inst.plan(str(src), nested_accounts)
    with pytest.raises(ValueError, match="overlapping_config_dirs"):
        inst.plan(str(src), _accounts(tmp_path / "a"),
                  extra={"agents": str(tmp_path / "a" / "agents")})


def _require_case_insensitive_fs(tmp_path: Path) -> None:
    probe = tmp_path / "CaseProbe"
    probe.mkdir(exist_ok=True)
    if not (tmp_path / "caseprobe").exists():
        pytest.skip("需要 case-insensitive 檔案系統（APFS 預設）")


def _two_account_staging(tmp_path: Path) -> Path:
    src = _staging(tmp_path)
    (src / "accounts" / "personal").mkdir()
    (src / "accounts" / "personal" / "P.md").write_text("P", encoding="utf-8")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["personal"] = "/Users/olduser/.claude-tc"
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return src


def test_install_fails_when_spots_converge_to_same_directory(tmp_path: Path, monkeypatch):
    """plan 的字串重疊檢查擋不住「plan 後才收斂」的落點（Codex 票 07 R2）。symlink
    置換構型已被票 09-1 祖先釘鎖在更早階段攔下（target 側 failed），本測試改用
    **APFS 大小寫別名**構型：兩個尚不存在、字串不同的落點建立後是同一實體目錄——
    fd 版 pairwise 重驗必須把兩個落點都 failed、零內容落地。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    _require_case_insensitive_fs(tmp_path)
    src = _two_account_staging(tmp_path)
    accounts = {
        "work": {"config_dir": str(tmp_path / "Alias" / "spot"), "label": ""},
        "personal": {"config_dir": str(tmp_path / "alias" / "spot"), "label": ""},
    }
    p = inst.plan(str(src), accounts)                 # 字串不重疊 → plan 過
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed"
               and r.error == "overlapping_config_dirs" for r in results)
    assert any(r.account == "personal" and r.outcome == "failed"
               and r.error == "overlapping_config_dirs" for r in results)
    assert list((tmp_path / "alias" / "spot").iterdir()) == []   # 零內容落地


def test_install_fails_when_spot_becomes_ancestor_of_another(tmp_path: Path, monkeypatch):
    """同上、祖先變體（大小寫別名構型）：收斂後一個落點變成另一個的祖先——identity
    相等比對抓不到，要走祖先鏈（fd-relative 逐層 ..）比對。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    _require_case_insensitive_fs(tmp_path)
    src = _two_account_staging(tmp_path)
    accounts = {
        "work": {"config_dir": str(tmp_path / "Alias" / "spot"), "label": ""},
        "personal": {"config_dir": str(tmp_path / "alias" / "spot" / "inner"),
                     "label": ""},
    }
    p = inst.plan(str(src), accounts)
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed"
               and r.error == "overlapping_config_dirs" for r in results)
    assert any(r.account == "personal" and r.outcome == "failed"
               and r.error == "overlapping_config_dirs" for r in results)
    spot = tmp_path / "alias" / "spot"
    assert [q for q in spot.rglob("*") if q.is_file()] == []   # 兩側零內容落地


def test_plan_treats_non_string_extra_confirmation_as_unconfirmed(
        tmp_path: Path, monkeypatch):
    """extra 確認值將來自 config.json（使用者可手編）：非字串不讓 plan 炸 500，
    視同未確認 → excluded。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": 7})
    assert "agents" in p.excluded


# ---------- 帳號側來源身分綁定（票 05 收尾裁示：比照 extra，封票 03 殘餘窗口） ----------


def test_install_fails_when_account_source_swapped_with_real_dir_after_plan(
        tmp_path: Path):
    """plan 之後 accounts/<key> 被換成另一個真目錄（O_NOFOLLOW 攔不到、root 身分沒變）
    → 來源身分不符記 failed、替身內容零落地——與 extra 同一條不變式：install 時狀態＝
    plan 時狀態。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    import shutil
    shutil.rmtree(src / "accounts" / "work")
    impostor = src / "accounts" / "work"
    impostor.mkdir()
    (impostor / "evil.md").write_text("EVIL", encoding="utf-8")
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed"
               and r.error == "source_moved" for r in results)
    assert not (tgt / "evil.md").exists()
    assert inst.journal_path(inst.transaction_id(p)).exists()


def test_install_fails_when_planned_account_source_deleted(tmp_path: Path):
    """plan 看過的帳號內容在 install 前被刪 → 不得靜默成功清 journal（「plan 說會裝」
    的整個帳號無聲消失＝誤報成功）。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    import shutil
    shutil.rmtree(src / "accounts" / "work")
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed"
               and r.error == "source_moved" for r in results)
    assert inst.journal_path(inst.transaction_id(p)).exists()


def test_install_records_failed_when_account_source_unopenable(tmp_path: Path):
    """accounts/<key> 被換成 symlink → 開失敗（O_NOFOLLOW）記 failed，不得與「備份包
    沒這個帳號的內容」混同靜默。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    import shutil
    shutil.rmtree(src / "accounts" / "work")
    (src / "accounts" / "work").symlink_to(tmp_path / "elsewhere")
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed" for r in results)
    assert list(tgt.iterdir()) == []
    assert inst.journal_path(inst.transaction_id(p)).exists()


def test_account_absent_at_plan_time_stays_silent(tmp_path: Path):
    """manifest 列了帳號、使用者也給了落點，但備份包從頭就沒有它的內容（plan 時身分
    None）→ ENOENT 正常靜默：不 failed、其餘帳號照裝、完整成功清 journal。"""
    src = _staging(tmp_path)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["personal"] = "/Users/olduser/.claude-tc"
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    tgt_work = tmp_path / "live-work"
    tgt_work.mkdir()
    tgt_personal = tmp_path / "live-personal"
    tgt_personal.mkdir()
    accounts = {
        "work": {"config_dir": str(tgt_work), "label": ""},
        "personal": {"config_dir": str(tgt_personal), "label": ""},
    }
    p = inst.plan(str(src), accounts)
    results = inst.install(p)
    assert not any(r.outcome == "failed" for r in results)
    assert (tgt_work / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"
    assert not inst.journal_path(inst.transaction_id(p)).exists()


def test_account_created_after_plan_is_not_installed(tmp_path: Path):
    """plan 時不存在、install 前才冒出來的帳號內容 → 不裝、記 failed：plan 沒掃描過
    的內容不寫進落點。"""
    src = _staging(tmp_path)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["personal"] = "/Users/olduser/.claude-tc"
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    tgt_work = tmp_path / "live-work"
    tgt_work.mkdir()
    tgt_personal = tmp_path / "live-personal"
    tgt_personal.mkdir()
    accounts = {
        "work": {"config_dir": str(tgt_work), "label": ""},
        "personal": {"config_dir": str(tgt_personal), "label": ""},
    }
    p = inst.plan(str(src), accounts)
    late = src / "accounts" / "personal"
    late.mkdir()
    (late / "late.md").write_text("LATE", encoding="utf-8")
    results = inst.install(p)
    assert any(r.account == "personal" and r.outcome == "failed"
               and r.error == "source_moved" for r in results)
    assert not (tgt_personal / "late.md").exists()


# ---------- 票 05：帳號目錄外的資產（extra/） ----------


def _staging_with_extra(tmp_path: Path) -> Path:
    """備份包含 extra/agents（帳號外資產）＋帳號內指向它的連結——票 05 的存在理由：
    skill 真身在 ~/.agents，帳號目錄裡只有一條 symlink 指過去。"""
    src = _staging(tmp_path)
    (src / "extra" / "agents" / "skills" / "s").mkdir(parents=True)
    (src / "extra" / "agents" / "skills" / "s" / "SKILL.md").write_text("X", encoding="utf-8")
    (src / "accounts" / "work" / "skills" / "s").symlink_to("/Users/olduser/.agents/skills/s")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["extra"] = {"agents": "/Users/olduser/.agents"}
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return src


def test_extra_asset_installed_and_account_link_resolves(tmp_path: Path, monkeypatch):
    """回歸測試（票 05 的存在理由）：skill 真身在帳號外時，extra 搬到使用者確認的落點，
    且帳號目錄裡指向它的連結搬完**解得開**——只搬 accounts/ 的話這條連結必斷，而共通
    設置的 repair 救不了指向第三位置的斷鏈（spec §4.2.1）。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    assert p.will_install == 3              # 帳號 2 檔＋extra 的 SKILL.md 也數進預覽
    inst.install(p)
    assert (home / ".agents" / "skills" / "s" / "SKILL.md").read_text(encoding="utf-8") == "X"
    assert (tgt / "skills" / "s").is_symlink()
    assert (tgt / "skills" / "s" / "SKILL.md").read_text(encoding="utf-8") == "X"


def test_extra_without_confirmed_landing_spot_is_excluded(tmp_path: Path, monkeypatch):
    """使用者沒確認落點的 extra 整項不搬且列 excluded——manifest 只能描述來源，不能
    自行指定目的地（spec §4.2.2 的 authz 邊界）；不說出來使用者會以為搬完了。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    p = inst.plan(str(src), _accounts(tgt))          # 沒給 extra
    assert "agents" in p.excluded
    assert p.extra_targets == {}
    inst.install(p)
    assert not (tmp_path / "home" / ".agents").exists()   # 整項未落地


def test_extra_name_must_be_a_single_path_component(tmp_path: Path, monkeypatch):
    """extra 的判準比帳號寬（要收 `.agents` 的前導點），但**仍然是單一路徑元件**：
    空字串／`.`／`..`／含分隔符／含 NUL 一律拒——name 會被拼進 Path(root, 'extra', name)
    與 fd-relative open，manifest 是不可信輸入。

    兩個入口各驗一次：漏掉任一邊，另一邊的放行就等於沒擋（票 13 的修法同時動了兩處）。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    spot = tmp_path / "spot"
    for bad in ("", ".", "..", "a/b", "/etc", "../outside", "a\0b"):
        with pytest.raises(ValueError, match="invalid_account_key"):
            inst.validate_landing_spots({f"extra:{bad}": str(spot)})
        manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
        manifest["extra"] = {bad: "/Users/olduser/.agents"}
        (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with pytest.raises(ValueError, match="invalid_account_key"):
            inst.plan(str(src), _accounts(tgt), extra={bad: str(spot)})


# ---------- 票 05：預覽的節點類型對帳（增補 spec §2.5.2 測試 2） ----------


def _staging_every_node_kind(tmp_path: Path) -> Path:
    """一份同時含**每一種節點類型**的備份包：一般檔／`.claude.json`／FIFO／授權 symlink／
    未授權 symlink／未確認落點的 extra／未指定落點的 account。

    `InstallPlan` **不是備份包內容的完整分類**（增補 spec §2.5.1），所以驗收的形式是
    「逐節點類型釘住去向」而不是單一守恆等式——後者在現行 `plan()` 的語意下不成立。"""
    src = _staging(tmp_path)                       # 已有 skills/a.md 與 CLAUDE.md
    work = src / "accounts" / "work"
    (work / ".claude.json").write_text("{}", encoding="utf-8")          # EXCLUDED_NAMES
    os.mkfifo(work / "pipe")                                            # 特殊檔
    (work / "commands").mkdir()
    (work / "commands" / "c.md").write_text("CMD", encoding="utf-8")
    # 授權 symlink：指向本次會裝的 node（舊 home 前綴改寫後對得上）
    (work / "linked").symlink_to("/Users/olduser/.claude/commands")
    # 未授權 symlink：指向這次不會裝的東西
    (work / "stray").symlink_to("/Users/olduser/.claude/never-installed")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["unpicked"] = "/Users/olduser/.claude-tc"      # 使用者沒給落點
    manifest["extra"] = {".agents": "/Users/olduser/.agents"}           # 未確認落點
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (src / "accounts" / "unpicked").mkdir()
    (src / "accounts" / "unpicked" / "X.md").write_text("X", encoding="utf-8")
    (src / "extra" / ".agents").mkdir(parents=True)
    (src / "extra" / ".agents" / "S.md").write_text("S", encoding="utf-8")
    return src


def test_preview_and_result_agree_per_node_kind(tmp_path: Path, monkeypatch):
    """**每一種節點類型都要有明確答案**，包括「預覽裡沒有、結果裡有」的 symlink。

    這條取代原本那個「四類相加＝可安裝項目數」的等式（增補 spec §2.5.1 指出它不成立）。
    UI 據此顯示：預覽的數字不能說成「總共會搬 N 項」，因為連結不在任何預覽數字裡。"""
    src = _staging_every_node_kind(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    p = inst.plan(str(src), _accounts(tgt))         # 只給 work 落點；unpicked 與 extra 都沒給

    # 預覽：一般檔進 will_install；.claude.json 與未確認 extra 進 excluded（**混合粒度**）
    assert p.will_install == 3                      # skills/a.md、CLAUDE.md、commands/c.md
    assert p.will_skip == []
    assert p.blocked == []
    assert sorted(p.excluded) == [".agents", ".claude.json"]
    # 完全不現身的三種：FIFO（執行時才成為 excluded result）、兩條 symlink、沒給落點的 account
    assert "pipe" not in p.excluded
    assert "unpicked" not in p.targets

    results = inst.install(p)
    by_rel = {(r.account, r.rel_path): r for r in results}

    # 一般檔：預覽說會裝、結果就是 installed
    assert by_rel[("work", "skills/a.md")].outcome == "installed"
    assert by_rel[("work", "commands/c.md")].outcome == "installed"
    # `.claude.json`：預覽與結果都是 excluded
    assert by_rel[("work", ".claude.json")].outcome == "excluded"
    # FIFO：**預覽裡沒有**，執行時才成為 excluded result
    assert by_rel[("work", "pipe")].outcome == "excluded"
    # 授權 symlink：**預覽裡沒有**，結果是 installed——這就是「結果比預覽多」的來源
    assert by_rel[("work", "linked")].outcome == "installed"
    assert (tgt / "linked").is_symlink()
    # 未授權 symlink：預覽裡沒有，結果是 excluded（不建）
    assert by_rel[("work", "stray")].outcome == "excluded"
    assert not (tgt / "stray").exists()
    # 沒給落點的 account 與未確認的 extra：一個位元組都沒落地
    assert not any(r.account == "unpicked" for r in results)
    assert not (tmp_path / "home" / ".agents").exists()

    # **結果的 installed 數大於預覽的 will_install**——正常，不是出錯（增補 spec §2.5.2）
    installed = sum(1 for r in results if r.outcome == "installed")
    assert installed > p.will_install


def test_preview_splits_excluded_and_names_missing_accounts(tmp_path: Path, monkeypatch):
    """**分類是後端的知識**（Codex 票 05 R1 F2／F3）。前端原本用「名稱差集」反推粒度、
    又拿 `bundle-info` 的舊快照與當下的 plan 做差集，兩者都會錯：

    - `_safe_extra_name` 允許 `.claude.json` 當 extra name（它是合法的單一路徑元件），
      名稱一碰撞，前端就會把帳號裡真正被排除的 `.claude.json` 一起從清單裡濾掉
    - 帳號清單來自較早的 `bundle-info`，而 plan 是**當下**重讀 manifest 與 config 算的；
      兩份快照之間 staging 被換過，新包多出來的帳號就完全漏報

    所以 `plan()` 在**同一份快照**裡直接回結構化的三欄。"""
    src = _staging(tmp_path)
    work = src / "accounts" / "work"
    (work / ".claude.json").write_text("{}", encoding="utf-8")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["unpicked"] = "/Users/olduser/.claude-tc"     # 沒給落點
    manifest["extra"] = {".claude.json": "/Users/olduser/.claude.json"}  # **與排除檔同名**
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (src / "accounts" / "unpicked").mkdir()

    p = inst.plan(str(src), _accounts(_home_target(tmp_path, monkeypatch)))

    assert p.excluded_files == [".claude.json"]        # 帳號裡那個檔
    assert p.unconfirmed_extra == [".claude.json"]     # 同名的 extra，各自一格
    assert p.missing_accounts == ["unpicked"]
    # 既有的混合欄位不變（install 路徑在用）——新欄位是**加上去**的，不是改語意
    assert sorted(p.excluded) == [".claude.json", ".claude.json"]


def test_plan_validates_every_manifest_account_key_even_without_a_target(
        tmp_path: Path, monkeypatch):
    """**manifest 的每個 account key 都要驗，不看 config 有沒有對應項**（Codex 票 05 R2）。

    `missing_accounts` 那條路徑原本排在 `_SAFE_KEY_RE` 之前，於是同一個非法 key 只因為
    使用者「碰巧沒給它落點」就會繞過信任邊界，被原樣放進 API response 與畫面上。
    `bundle_info()` 與 `landing_suggestions()` 都是一律先驗——這裡漏掉就又是一次
    「一邊有一邊沒有」。"""
    src = _staging(tmp_path)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["../outside"] = "/Users/olduser/.claude-tc"   # 沒給落點的非法 key
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="invalid_account_key"):
        inst.plan(str(src), _accounts(_home_target(tmp_path, monkeypatch)))


def test_preview_leaves_are_exhaustive_and_disjoint(tmp_path: Path, monkeypatch):
    """一般檔的 per-spot 守恆（增補 spec §2.5.2 測試 1）：掃到的每個 installable leaf
    恰好落入 `will_install`／`will_skip`／`blocked` **之一**，互斥且窮盡。

    這是預覽唯一成立的守恆律——把它擴大到「所有節點」就會變成那條不成立的等式。"""
    src = _staging(tmp_path)                        # skills/a.md、CLAUDE.md
    (src / "accounts" / "work" / "buried").mkdir()
    (src / "accounts" / "work" / "buried" / "deep.md").write_text("D", encoding="utf-8")
    tgt = _home_target(tmp_path, monkeypatch)
    (tgt / "CLAUDE.md").write_text("MINE", encoding="utf-8")            # → will_skip
    (tgt / "buried").write_text("occupied", encoding="utf-8")           # 祖先是檔案 → blocked

    p = inst.plan(str(src), _accounts(tgt))

    assert (p.will_install, p.will_skip, p.blocked) == (1, ["CLAUDE.md"], ["buried/deep.md"])
    assert p.will_install + len(p.will_skip) + len(p.blocked) == 3      # 三個一般檔，不多不少


# ---------- 票 02：bundle-info（唯讀摘要，增補 spec 缺口 1） ----------


def test_bundle_info_summarizes_the_bundle(tmp_path: Path):
    """`bundle` 頁要讓使用者確認「這是不是我要的那一包」：來源機器、備份時間、帳號與
    extra 清單、專案數。全部來自 manifest 與目錄計數，唯讀。"""
    src = _staging(tmp_path)
    (src / "accounts" / "work" / "projects" / "-Users-olduser-a").mkdir(parents=True)
    (src / "accounts" / "work" / "projects" / "-Users-olduser-b").mkdir()
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["personal"] = "/Users/olduser/.claude-tc"
    manifest["extra"] = {".agents": "/Users/olduser/.agents"}
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (src / "accounts" / "personal" / "projects" / "-Users-olduser-c").mkdir(parents=True)

    info = inst.bundle_info(str(src))

    assert info == {
        "host": "old-mac",
        "created": "20260731-1200",
        "accounts": ["personal", "work"],
        "extra": [".agents"],
        "project_count": 3,
    }


def test_bundle_info_counts_only_real_project_dirs(tmp_path: Path):
    """專案數的判準與 `project_paths()` 一致：`is_dir()` 且**非 symlink**（lstat 語意）。
    兩邊不一致的話 `bundle` 頁與 `paths` 頁的數字對不上，使用者會以為少了東西。"""
    src = _staging(tmp_path)
    projects = src / "accounts" / "work" / "projects"
    (projects / "-Users-olduser-a").mkdir(parents=True)
    (projects / "loose.jsonl").write_text("{}", encoding="utf-8")       # 檔案不算
    (projects / "linked").symlink_to(projects / "-Users-olduser-a")     # symlink 不算
    assert inst.bundle_info(str(src))["project_count"] == 1


def test_bundle_info_counts_zero_when_account_has_no_projects(tmp_path: Path):
    """帳號沒有 `projects/` 目錄（從沒用過 /resume 的帳號）→ 0，不是報錯。"""
    assert inst.bundle_info(str(_staging(tmp_path)))["project_count"] == 0


def test_bundle_info_does_not_follow_symlinked_dirs_out_of_the_bundle(tmp_path: Path):
    """**每一層都不得跟隨 symlink**（Codex 票 02 R1 F3）：`accounts/<key>` 或它底下的
    `projects` 是指向包外的連結時，`is_dir()` 會跟過去，於是這支唯讀端點就替一份惡意
    備份包遍歷本機任意目錄——回的 count 也不再描述這一包。

    只測 `projects` 的子項是 symlink 不夠：被穿越的是**目錄那一層**。"""
    outside = tmp_path / "outside"
    (outside / "a").mkdir(parents=True)
    (outside / "b").mkdir()

    src = _staging(tmp_path)
    (src / "accounts" / "work" / "projects").symlink_to(outside)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["linked"] = "/Users/olduser/.claude-tc"
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (src / "accounts" / "linked").symlink_to(tmp_path / "elsewhere")
    (tmp_path / "elsewhere" / "projects" / "c").mkdir(parents=True)

    assert inst.bundle_info(str(src))["project_count"] == 0


def test_bundle_info_rejects_path_like_account_key(tmp_path: Path):
    """key 會被拼進 `accounts/<key>/projects` 去數目錄——manifest 是不可信輸入，
    與 `project_paths()` 同一條信任邊界、同規則重驗。"""
    src = _staging(tmp_path)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"] = {"../outside": "/Users/olduser/.claude"}
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="invalid_account_key"):
        inst.bundle_info(str(src))


def test_bundle_info_refuses_a_directory_that_is_not_a_bundle(tmp_path: Path):
    """讀不到 manifest → `source_not_a_bundle`（沿用 `read_manifest` 的判準）。"""
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.bundle_info(str(plain))


def test_bundle_info_tolerates_manifest_without_host_or_created(tmp_path: Path):
    """`host`／`created` 只影響顯示、不參與任何路徑或安全決策——缺了就回空字串，
    不為一個顯示欄位讓整包看不到摘要（與 `restore-claude.sh::verify_manifest` 刻意
    不驗 `created` 同一個取捨）。"""
    src = _staging(tmp_path)
    (src / "manifest.json").write_text(json.dumps({"accounts": {}}), encoding="utf-8")
    info = inst.bundle_info(str(src))
    assert (info["host"], info["created"], info["accounts"]) == ("", "", [])


# ---------- 票 03：落點建議值（landing-suggestions，增補 spec 缺口 7） ----------


def _staging_for_suggestions(tmp_path: Path, **manifest_overrides) -> Path:
    """一個帳號在舊 home 底下、一個不在（NAS 掛載點），外加一個 extra。

    `base` 每次不同：`make_staging` 固定建 `<base>/staging`，同一個 tmp_path 呼叫兩次會
    `FileExistsError`，而下面有兩條測試要在迴圈裡造好幾份。"""
    base = tmp_path / f"case{len(list(tmp_path.glob('case*')))}"
    base.mkdir()
    src = _staging(base)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["nas"] = "/Volumes/NAS/claude"
    manifest["extra"] = {".agents": "/Users/olduser/.agents"}
    manifest.update(manifest_overrides)
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return src


def test_landing_suggestions_rewrites_home_prefix_and_refuses_to_guess(
        tmp_path: Path, monkeypatch):
    """建議值規則（上游 spec §4.2.2 決策 9）：舊路徑在舊 home 底下 → 換 home 前綴；
    **其餘留空不猜**（ADR-0001 允許 config_dir 是任意路徑，沒有正確答案可推）。

    extra 與帳號走同一條規則，只用 `kind` 區分——兩者的落點確認在 UI 上是同一件事。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    (home / ".agents").mkdir()          # 新機已經有這個目錄 → suggested_exists

    out = inst.landing_suggestions(str(_staging_for_suggestions(tmp_path)))

    assert out["home"] == "/Users/olduser"
    assert out["spots"] == [
        {"key": ".agents", "kind": "extra", "old_path": "/Users/olduser/.agents",
         "suggested": f"{home}/.agents", "suggested_exists": True},
        {"key": "nas", "kind": "account", "old_path": "/Volumes/NAS/claude",
         "suggested": "", "suggested_exists": False},      # 不在舊 home 底下 → 不猜
        {"key": "work", "kind": "account", "old_path": "/Users/olduser/.claude",
         "suggested": f"{home}/.claude", "suggested_exists": False},
    ]


def test_landing_suggestions_refuses_non_normalized_manifest_paths(
        tmp_path: Path, monkeypatch):
    """**建議值不得逃逸到新 home 之外**（Codex 階段 4 審查 F1）：`_rewrite_home_prefix`
    原本是裸字串前綴＋`os.path.join`，於是 `home=/old` 配 `old_path=/old/../../etc` 會產出
    `<new_home>/../../etc`——那個值既是輸入框預設值（click-through 授權誘導），又會被
    `suggested_exists` 交給 `os.path.isdir`，**等於讓一份惡意備份包探測本機任意路徑存在性**。

    不合格的 `old_path` → 該項 `suggested` 留空且**完全不探測**。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    src = _staging_for_suggestions(tmp_path, home="/old", accounts={
        "escape": "/old/../../etc",
        "dotdot": "/old/x/../../../etc",
        "trailing": "/old/x/",
        "relative": "old/x",
        "ok": "/old/x",
    })

    spots = {s["key"]: s for s in inst.landing_suggestions(str(src))["spots"]}

    for key in ("escape", "dotdot", "trailing", "relative"):
        assert spots[key]["suggested"] == "", key
        assert spots[key]["suggested_exists"] is False, key
    assert spots["ok"]["suggested"] == f"{home}/x"       # 正常的那一個照樣有建議值


def test_landing_suggestions_does_not_treat_sibling_prefix_as_inside_home(
        tmp_path: Path, monkeypatch):
    """containment 是**路徑元件**不是字串前綴：`/olduser/x` 不在 `/old` 底下。

    裸 `startswith("/old")` 會把它改寫成 `<new_home>ser/x`——一個既不存在也沒意義的
    建議值，而使用者看到預填值多半就按下去了。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    src = _staging_for_suggestions(tmp_path, home="/old", accounts={
        "sibling": "/olduser/x", "inside": "/old/x"})

    spots = {s["key"]: s for s in inst.landing_suggestions(str(src))["spots"]}

    assert spots["sibling"]["suggested"] == ""
    assert spots["inside"]["suggested"] == f"{home}/x"


def test_landing_suggestions_probes_nothing_when_home_is_unusable(
        tmp_path: Path, monkeypatch):
    """`read_manifest` 不驗 `home`（它只驗 accounts／extra 的形狀）。`home` 不是合格字串時
    **fail-soft**：回空字串、所有 suggested 留空、**完全不執行存在性探測**（Codex 階段 4 F3）。

    不 fail-closed 的理由與票 02 的 `_display_text` 同一條——`home` 只影響建議值這個便利功能、
    不參與任何授權決策，為它拒絕整包會讓手編過 manifest 的使用者連落點都沒得填。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    for bad in (None, 7, ["/old"], {"a": 1}, "relative/home", "/old/../x", ""):
        src = _staging_for_suggestions(tmp_path, home=bad)      # 每次一份新的 staging
        out = inst.landing_suggestions(str(src))
        assert out["home"] == "", bad
        assert all(s["suggested"] == "" for s in out["spots"]), bad
        assert all(s["suggested_exists"] is False for s in out["spots"]), bad


def test_landing_suggestions_tolerates_non_string_old_path(tmp_path: Path, monkeypatch):
    """`old_path` 非字串（manifest 可被手編）→ 該項留空，**不整份拒絕**：一個壞欄位不該
    讓使用者連其餘正常帳號的落點都沒得填。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    src = _staging_for_suggestions(tmp_path, accounts={"work": 7, "ok": "/Users/olduser/.c"})

    spots = {s["key"]: s for s in inst.landing_suggestions(str(src))["spots"]}

    assert (spots["work"]["old_path"], spots["work"]["suggested"]) == ("", "")
    assert spots["ok"]["suggested"] == f"{home}/.c"


def test_landing_suggestions_rejects_path_like_names(tmp_path: Path, monkeypatch):
    """key／name 與其他讀取面同一條信任邊界：帳號走 `_SAFE_KEY_RE`、extra 走
    `_safe_extra_name`（票 13）。它們會被顯示、也會被送回 `adopt-config`。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    with pytest.raises(ValueError, match="invalid_account_key"):
        inst.landing_suggestions(str(_staging_for_suggestions(
            tmp_path, accounts={"../outside": "/Users/olduser/.claude"})))
    with pytest.raises(ValueError, match="invalid_account_key"):
        inst.landing_suggestions(str(_staging_for_suggestions(
            tmp_path, extra={"a/b": "/Users/olduser/.agents"})))


def test_landing_suggestions_refuses_a_directory_that_is_not_a_bundle(tmp_path: Path):
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.landing_suggestions(str(plain))


# ---------- 票 13：extra name 的判準與帳號 key 分開 ----------


def _staging_with_dotted_extra(tmp_path: Path) -> Path:
    """extra name 帶前導點——`backup-claude.sh` 的 manifest key 是 `basename(路徑)`，
    真實的 `~/.agents` 產出的就是 `.agents`。既有 fixture 一律寫成不帶點的 `agents`，
    正是這條判準漂移藏了這麼久的原因（票 13）。"""
    src = _staging(tmp_path)
    (src / "extra" / ".agents" / "skills" / "s").mkdir(parents=True)
    (src / "extra" / ".agents" / "skills" / "s" / "SKILL.md").write_text("X", encoding="utf-8")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["extra"] = {".agents": "/Users/olduser/.agents"}
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return src


def test_landing_spots_and_plan_accept_dotted_extra_name(tmp_path: Path, monkeypatch):
    """`.agents` 是**專案自己的備份腳本**產出的合法 name，兩個入口都得收：`adopt-config`
    的授權時刻（`validate_landing_spots`）與 install 前的重驗（`plan`）。只放行其中一個，
    擋死的位置只是往後挪一站——使用者的 `~/.agents`（skill 真身常放在那裡）照樣搬不回去。"""
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    src = _staging_with_dotted_extra(tmp_path)
    assert inst.validate_landing_spots({"extra:.agents": str(home / ".agents")}) == \
        {"extra:.agents": str(home / ".agents")}
    p = inst.plan(str(src), _accounts(tgt), extra={".agents": str(home / ".agents")})
    assert p.extra_targets == {".agents": str(home / ".agents")}
    inst.install(p)
    assert (home / ".agents" / "skills" / "s" / "SKILL.md").read_text(encoding="utf-8") == "X"


def test_plan_refuses_extra_spot_at_home_or_above(tmp_path: Path, monkeypatch):
    """extra 落點的驗證規則與帳號完全一致（不因它不是帳號而放寬）：home 本身或祖先
    一律 unsafe_config_dir（ADR-0001 底線防呆）。"""
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    src = _staging_with_extra(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    for bad in (str(home), str(tmp_path), "/"):
        with pytest.raises(ValueError, match="unsafe_config_dir"):
            inst.plan(str(src), _accounts(tgt), extra={"agents": bad})


def test_plan_refuses_manifest_with_malformed_extra(tmp_path: Path):
    """manifest.extra 不是 {str: str} → source_not_a_bundle：它是 extra 迭代與拼路徑的
    基礎，不驗的話字串會被迭代成單字元 name、null 直接 TypeError 裸穿成 500（與
    accounts 的型別驗證同款）。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    for bad in (None, "oops", 7, ["agents"], {"agents": 7}, {"agents": None}):
        manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
        manifest["extra"] = bad
        (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with pytest.raises(ValueError, match="source_not_a_bundle"):
            inst.plan(str(src), _accounts(tgt))


def test_install_fails_when_extra_item_swapped_with_real_dir_after_plan(
        tmp_path: Path, monkeypatch):
    """plan 之後 extra/<name> 被換成**另一個真目錄**（O_NOFOLLOW 攔不到）→ 來源身分
    不符記 failed、替身內容零落地——不能把 plan 沒掃描過的內容裝進已確認落點
    （Codex 票 05 R1 F1：symlink 測試只證明了 O_NOFOLLOW 分支）。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    import shutil
    shutil.rmtree(src / "extra" / "agents")
    impostor = src / "extra" / "agents"
    (impostor / "skills").mkdir(parents=True)
    (impostor / "skills" / "evil.md").write_text("EVIL", encoding="utf-8")
    results = inst.install(p)
    assert any(r.account == "extra:agents" and r.outcome == "failed"
               and r.error == "source_moved" for r in results)
    assert not (home / ".agents" / "skills" / "evil.md").exists()   # 替身內容零落地
    assert inst.journal_path(inst.transaction_id(p)).exists()


def test_install_fails_when_planned_extra_item_deleted(tmp_path: Path, monkeypatch):
    """plan 看過的 extra 來源在 install 前被刪 → ENOENT **不得**靜默成功並清 journal：
    「plan 說會裝」的整項無聲消失就是誤報成功。「備份包本來就沒有」才容許靜默，
    兩者以 plan 時身分（None 與否）區分（Codex 票 05 R1 F1）。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    import shutil
    shutil.rmtree(src / "extra" / "agents")
    results = inst.install(p)
    assert any(r.account == "extra:agents" and r.outcome == "failed"
               and r.error == "source_moved" for r in results)
    assert inst.journal_path(inst.transaction_id(p)).exists()


def test_install_fails_when_planned_extra_dir_deleted(tmp_path: Path, monkeypatch):
    """整個 extra/ 在 plan 後被刪 → 同上，plan 看過的項目全記 failed、journal 保留。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    import shutil
    shutil.rmtree(src / "extra")
    results = inst.install(p)
    assert any(r.account == "extra:agents" and r.outcome == "failed"
               and r.error == "source_moved" for r in results)
    assert inst.journal_path(inst.transaction_id(p)).exists()


def test_extra_absent_at_plan_time_stays_silent(tmp_path: Path, monkeypatch):
    """manifest 列了 extra、使用者也確認了落點，但備份包**從頭就沒有**這份內容
    （plan 時身分為 None）→ install 的 ENOENT 走正常靜默：不 failed、完整成功清 journal。
    守住這條，上面的 fail-closed 才不會把正常備份包誤殺。"""
    src = _staging(tmp_path)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["extra"] = {"agents": "/Users/olduser/.agents"}
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    results = inst.install(p)
    assert not any(r.outcome == "failed" for r in results)
    assert not inst.journal_path(inst.transaction_id(p)).exists()   # 完整成功 → 清除


def test_extra_absent_item_with_extra_dir_present_stays_silent(
        tmp_path: Path, monkeypatch):
    """同上一條，但 extra/ 目錄本身存在、只缺這一項的內容——兩個 ENOENT 入口
    （extra/ 整個不在、單項不在）都要走「plan 時身分 None 才靜默」的同一判準。"""
    src = _staging(tmp_path)
    (src / "extra").mkdir()
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["extra"] = {"agents": "/Users/olduser/.agents"}
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    results = inst.install(p)
    assert not any(r.outcome == "failed" for r in results)
    assert not inst.journal_path(inst.transaction_id(p)).exists()


def test_extra_created_after_plan_is_not_installed(tmp_path: Path, monkeypatch):
    """plan 時不存在、install 前才冒出來的 extra 內容 → 不裝、記 failed：plan 沒掃描
    過的內容不寫進確認落點（與「換真目錄」同一條不變式：install 時狀態＝plan 時狀態）。"""
    src = _staging(tmp_path)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["extra"] = {"agents": "/Users/olduser/.agents"}
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    late = src / "extra" / "agents"
    late.mkdir(parents=True)
    (late / "late.md").write_text("LATE", encoding="utf-8")
    results = inst.install(p)
    assert any(r.account == "extra:agents" and r.outcome == "failed"
               and r.error == "source_moved" for r in results)
    assert not (home / ".agents" / "late.md").exists()


def test_install_records_failed_when_extra_item_unopenable(tmp_path: Path, monkeypatch):
    """plan 之後 extra/<name> 被換成 symlink → 開啟失敗（O_NOFOLLOW）但不是「不存在」：
    要記 failed 而非靜默跳過——「plan 說會裝」的整項無聲消失就是誤報成功（票 04 F3
    「不存在≠讀不出」的同款區分）；有 failed 則 journal 保留。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    import shutil
    shutil.rmtree(src / "extra" / "agents")
    (src / "extra" / "agents").symlink_to(tmp_path / "elsewhere")
    results = inst.install(p)
    assert any(r.account == "extra:agents" and r.outcome == "failed" for r in results)
    assert not (home / ".agents").exists()                      # 開失敗發生在任何寫入之前
    assert inst.journal_path(inst.transaction_id(p)).exists()   # failed → journal 保留


def test_install_records_failed_when_extra_dir_unopenable(tmp_path: Path, monkeypatch):
    """extra/ 整個被換成 symlink → 確認過落點的 extra 全記 failed，不得無聲消失。
    「備份包沒有 extra/」才是正常的不存在，那走 ENOENT 靜默路徑，兩者不得混同。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    p = inst.plan(str(src), _accounts(tgt), extra={"agents": str(home / ".agents")})
    replacement = tmp_path / "elsewhere"
    replacement.mkdir()
    import shutil
    shutil.rmtree(src / "extra")
    (src / "extra").symlink_to(replacement)
    results = inst.install(p)
    assert any(r.account == "extra:agents" and r.outcome == "failed" for r in results)
    assert list(replacement.iterdir()) == []                    # 替身目錄零讀寫
    assert inst.journal_path(inst.transaction_id(p)).exists()


# ---------- 票 06：專案目錄改名（對話歷史叫得出來） ----------


def _staging_with_history(tmp_path: Path) -> Path:
    """備份包含一個專案的對話歷史（projects/<encoded>/）＋記憶子目錄。"""
    src = _staging(tmp_path)
    proj = src / "accounts" / "work" / "projects" / "-Users-olduser-work-app"
    proj.mkdir(parents=True)
    lines = [
        {"type": "user", "cwd": "/Users/olduser/work/app", "uuid": "u1",
         "message": {"content": "看看 /Users/olduser/work/app/src"}},
        {"type": "assistant", "cwd": "/Users/olduser/work/app", "uuid": "u2"},
    ]
    (proj / "s.jsonl").write_text(
        "\n".join(json.dumps(o, ensure_ascii=False) for o in lines) + "\n",
        encoding="utf-8")
    (proj / "memory").mkdir()
    (proj / "memory" / "note.md").write_text("記憶檔", encoding="utf-8")
    return src


def _snapshot_tree(root: Path) -> dict[str, bytes]:
    """整棵樹的 {相對路徑: 位元組}（含 symlink 目標字串），驗「全程唯讀」用。"""
    snap: dict[str, bytes] = {}
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        if p.is_symlink():
            snap[rel] = b"->" + os.readlink(p).encode()
        elif p.is_file():
            snap[rel] = p.read_bytes()
        else:
            snap[rel] = b"<dir>"
    return snap


def test_mapping_renames_project_dir_and_keeps_bytes(tmp_path: Path):
    """指定對應之後，歷史裝到**新路徑編碼**出來的目錄底下，且歷史檔逐位元組與備份包
    相同——票 01 實測：定位只靠目錄名、內容完全不動。"""
    src = _staging_with_history(tmp_path)
    original = (src / "accounts" / "work" / "projects" / "-Users-olduser-work-app"
                / "s.jsonl").read_bytes()
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work/app", "/Users/newuser/work/app")])
    inst.install(p)
    assert (tgt / "projects" / "-Users-newuser-work-app" / "s.jsonl").read_bytes() \
        == original
    assert not (tgt / "projects" / "-Users-olduser-work-app").exists()


def test_memory_subdir_follows_the_rename(tmp_path: Path):
    """projects/<proj>/memory/ 是記憶檔，跟著專案目錄一起搬——漏了它等於丟掉記憶。"""
    src = _staging_with_history(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work/app", "/Users/newuser/work/app")])
    inst.install(p)
    assert (tgt / "projects" / "-Users-newuser-work-app" / "memory" / "note.md"
            ).read_text(encoding="utf-8") == "記憶檔"


def test_staging_is_byte_identical_after_install_with_mapping(tmp_path: Path):
    """改寫融進複製過程、staging 全程唯讀（spec §4.2.4）：整棵展開目錄位元組不變。"""
    src = _staging_with_history(tmp_path)
    before = _snapshot_tree(src)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work/app", "/Users/newuser/work/app")])
    inst.install(p)
    assert _snapshot_tree(src) == before


def test_unmapped_project_is_kept_and_reported(tmp_path: Path):
    """沒指定對應的專案照搬原位置，且 plan 把它列進 unmapped_projects——使用者要知道
    哪些專案的歷史在路徑變動時 `/resume` 會找不到。"""
    src = _staging_with_history(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    assert p.unmapped_projects == [{
        "account": "work",
        "encoded_dir": "-Users-olduser-work-app",
        "old_path": "/Users/olduser/work/app",
    }]
    inst.install(p)
    assert (tgt / "projects" / "-Users-olduser-work-app" / "s.jsonl").is_file()


def test_mapping_rerun_is_idempotent(tmp_path: Path):
    """帶 mapping 的重跑：plan 的預覽要用**改名後**的目的位置判 skip，第二輪全 skipped、
    現役零變化——中斷續作靠這個性質。"""
    src = _staging_with_history(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    mapping = [("/Users/olduser/work/app", "/Users/newuser/work/app")]
    inst.install(inst.plan(str(src), _accounts(tgt), mapping=mapping))
    before = {p: p.read_bytes() for p in tgt.rglob("*") if p.is_file()}
    p2 = inst.plan(str(src), _accounts(tgt), mapping=mapping)
    assert p2.will_install == 0
    results = inst.install(p2)
    assert {r.outcome for r in results} == {"skipped"}
    assert {p: p.read_bytes() for p in tgt.rglob("*") if p.is_file()} == before


def test_mapping_rejects_colliding_encoded_names(tmp_path: Path):
    """編碼有損（非英數全變 `-`）：兩個新路徑撞名、或撞上未改寫專案的既有目錄名，
    都要在寫任何東西之前整批拒絕。"""
    src = _staging_with_history(tmp_path)
    other = src / "accounts" / "work" / "projects" / "-Users-olduser-work-other"
    other.mkdir()
    (other / "t.jsonl").write_text(
        json.dumps({"cwd": "/Users/olduser/work/other"}) + "\n", encoding="utf-8")
    tgt = tmp_path / "live"
    tgt.mkdir()
    with pytest.raises(ValueError, match="mapping_collision"):
        inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work/app", "/a/b"),
                           ("/Users/olduser/work/other", "/a-b")])
    with pytest.raises(ValueError, match="mapping_collision"):
        inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work/app",
                            "/Users/olduser-work-other")])   # 撞未改寫專案的既有名
    with pytest.raises(ValueError, match="mapping_collision"):
        inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work/app", "/x/a"),
                           ("/Users/olduser/work/app", "/x/b")])   # 同一專案對兩個新路徑
    assert list(tgt.iterdir()) == []


def test_mapping_rejects_relative_new_path(tmp_path: Path):
    src = _staging_with_history(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    with pytest.raises(ValueError, match="mapping_not_absolute"):
        inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work/app", "relative/path")])


def test_mapping_rejects_unknown_old_project(tmp_path: Path):
    """old 必須是備份包裡確實存在的專案——mapping 也是不可信輸入的一種。"""
    src = _staging_with_history(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    with pytest.raises(ValueError, match="mapping_unknown_project"):
        inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/nope", "/Users/newuser/nope")])


def test_mapping_changes_transaction_id(tmp_path: Path):
    """journal node 以改名後的位置記——改 mapping 重跑＝不同 transaction，不讀舊
    journal（比照票 04 R1 F1 的落點 mapping 綁定）；同 mapping 重跑則穩定接上。"""
    src = _staging_with_history(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    mapping = [("/Users/olduser/work/app", "/Users/newuser/work/app")]
    tid_none = inst.transaction_id(inst.plan(str(src), _accounts(tgt)))
    tid_map1 = inst.transaction_id(inst.plan(str(src), _accounts(tgt), mapping=mapping))
    tid_map2 = inst.transaction_id(inst.plan(str(src), _accounts(tgt), mapping=mapping))
    assert tid_none != tid_map1
    assert tid_map1 == tid_map2


def test_project_paths_reads_old_path_from_history(tmp_path: Path):
    """編碼不可逆（非英數全變 `-`），舊路徑只能從歷史檔的 cwd 讀；舊 home 底下的
    給建議值（換 home 前綴）、並回報建議位置是否存在。純唯讀。"""
    src = _staging_with_history(tmp_path)
    found = inst.project_paths(str(src))
    home = str(Path(os.environ["HOME"]).resolve())
    assert found == [{
        "account": "work",
        "old_path": "/Users/olduser/work/app",
        "encoded_dir": "-Users-olduser-work-app",
        "suggested": f"{home}/work/app",
        "suggested_exists": False,
    }]


def test_project_paths_does_not_follow_jsonl_symlink(tmp_path: Path):
    """備份包不可信：專案目錄裡的 *.jsonl 可能是指向 staging 外的 symlink——唯讀
    端點跟隨它就是把外部檔案內容洩給 caller（Codex 票 06 R1 F1）。不跟隨、該專案
    因讀不出 cwd 而不列。"""
    src = _staging(tmp_path)
    victim = tmp_path / "victim.jsonl"
    victim.write_text(json.dumps({"cwd": "/LEAKED"}) + "\n", encoding="utf-8")
    proj = src / "accounts" / "work" / "projects" / "-Users-olduser-x"
    proj.mkdir(parents=True)
    (proj / "s.jsonl").symlink_to(victim)
    assert inst.project_paths(str(src)) == []


def test_peek_cwd_is_bounded(tmp_path: Path):
    """讀取有上限：cwd 出現在讀取上限之後的惡意／損壞 jsonl 不讓 sidecar 讀到底
    ——放棄、該專案不列（列不出舊路徑只是無法給建議值）。"""
    src = _staging(tmp_path)
    proj = src / "accounts" / "work" / "projects" / "-Users-olduser-x"
    proj.mkdir(parents=True)
    pad = json.dumps({"filler": "x" * (1 << 20)}) + "\n"     # 1MB 無 cwd 的行
    (proj / "s.jsonl").write_text(
        pad + json.dumps({"cwd": "/Users/olduser/x"}) + "\n", encoding="utf-8")
    assert inst.project_paths(str(src)) == []


def test_mapping_rejects_relative_old(tmp_path: Path):
    """old 必須是絕對路徑：已 encoded 的相對字串（encode 對它是恆等）能直接命中
    同名目錄、繞過「以真實舊路徑選擇專案」的語意（Codex 票 06 R1 F2）。"""
    src = _staging_with_history(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    with pytest.raises(ValueError, match="mapping_not_absolute"):
        inst.plan(str(src), _accounts(tgt),
                  mapping=[("-Users-olduser-work-app", "/Users/newuser/work/app")])


def test_mapping_rejects_lossy_alias_of_different_project(tmp_path: Path):
    """編碼有損：old=/Users/olduser/work.app 與既有專案 /Users/olduser/work/app 撞出
    同一個 encoded 名。命中的目錄其 cwd 與 old 不一致 → mapping_ambiguous 整批拒，
    不能把使用者沒選的專案改名（Codex 票 06 R1 F2）。"""
    src = _staging_with_history(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    with pytest.raises(ValueError, match="mapping_ambiguous"):
        inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work.app", "/Users/newuser/work/app")])


def test_symlink_into_renamed_project_follows_rename(tmp_path: Path, monkeypatch):
    """絕對 symlink 指進被改名的專案：授權查 journal 與回寫都要用**改名後**的位置
    ——否則 journal 記新名、查詢用舊名，連結被誤判 unauthorized 而丟失
    （Codex 票 06 R1 F3）。"""
    src = _staging_with_history(tmp_path)
    (src / "accounts" / "work" / "recent").symlink_to(
        "/Users/olduser/.claude/projects/-Users-olduser-work-app/s.jsonl")
    tgt = _home_target(tmp_path, monkeypatch)
    home = tmp_path / "home"
    new_path = f"{home}/work/app"
    from fledge_sidecar.project_scanner import encode_cc_project_dir
    new_enc = encode_cc_project_dir(new_path)
    p = inst.plan(str(src), _accounts(tgt),
                  mapping=[("/Users/olduser/work/app", new_path)])
    results = inst.install(p)
    assert (tgt / "recent").is_symlink()
    assert os.readlink(tgt / "recent") == str(tgt / "projects" / new_enc / "s.jsonl")
    assert any(r.rel_path == "recent" and r.outcome == "installed" for r in results)


def test_peek_skips_fifo_named_jsonl(tmp_path: Path):
    """FIFO 偽裝成 *.jsonl 不 open 不阻塞（scandir 判型＋O_NONBLOCK＋fstat 三層）。
    本測試在修復前的行為是 open 阻塞卡死整個測試行程，無法安全驗紅——紅驗證由
    「測試能跑完」本身承擔（修復前它永不返回）。"""
    src = _staging(tmp_path)
    proj = src / "accounts" / "work" / "projects" / "-Users-olduser-x"
    proj.mkdir(parents=True)
    os.mkfifo(proj / "a.jsonl")             # 排序在真檔前，先被掃到
    (proj / "b.jsonl").write_text(
        json.dumps({"cwd": "/Users/olduser/x"}) + "\n", encoding="utf-8")
    [found] = inst.project_paths(str(src))
    assert found["old_path"] == "/Users/olduser/x"


def test_peek_reads_first_files_even_when_project_has_many(tmp_path: Path):
    """正常專案常有數十個 session 檔：檔數上限是「只開前 N 個（排序後）」，**不是**
    「超過 N 個就整批放棄」——後者會把功能對真實備份打壞（Codex 票 06 R2 的但書）。"""
    src = _staging(tmp_path)
    proj = src / "accounts" / "work" / "projects" / "-Users-olduser-x"
    proj.mkdir(parents=True)
    (proj / "a.jsonl").write_text(
        json.dumps({"cwd": "/Users/olduser/x"}) + "\n", encoding="utf-8")
    for i in range(30):
        (proj / f"z{i:02d}.jsonl").write_text(
            json.dumps({"note": "no cwd"}) + "\n", encoding="utf-8")
    [found] = inst.project_paths(str(src))
    assert found["old_path"] == "/Users/olduser/x"


def test_peek_file_cap_excludes_later_files(tmp_path: Path):
    """cwd 只出現在排序第 N＋1 個檔案之後 → 放棄回 None（上限語意釘住：只開前 N 個）。"""
    src = _staging(tmp_path)
    proj = src / "accounts" / "work" / "projects" / "-Users-olduser-x"
    proj.mkdir(parents=True)
    for i in range(inst._PEEK_MAX_FILES):
        (proj / f"a{i:02d}.jsonl").write_text(
            json.dumps({"note": "no cwd"}) + "\n", encoding="utf-8")
    (proj / "zz.jsonl").write_text(
        json.dumps({"cwd": "/Users/olduser/x"}) + "\n", encoding="utf-8")
    assert inst.project_paths(str(src)) == []


def test_peek_cwd_does_not_materialize_full_sort(tmp_path: Path, monkeypatch):
    """資源輪廓釘住（Codex 票 06 R3）：檔數上限必須在**列舉階段**生效（nsmallest，
    O(上限) 記憶體），不得退化回 sorted(...)[:N] 的全量實體化＋排序——兩者輸出語意
    相同，語意測試殺不死這個退化。monkeypatch sorted 為拋錯：_peek_cwd 的路徑不得
    用到全量排序，退化即紅。"""
    src = _staging(tmp_path)
    proj = src / "accounts" / "work" / "projects" / "-Users-olduser-x"
    proj.mkdir(parents=True)
    (proj / "a.jsonl").write_text(
        json.dumps({"cwd": "/Users/olduser/x"}) + "\n", encoding="utf-8")
    for i in range(20):
        (proj / f"z{i:02d}.jsonl").write_text("{}\n", encoding="utf-8")
    import builtins

    def _boom(*a, **k):
        raise AssertionError("全量 sorted 不得出現在 _peek_cwd 路徑")

    monkeypatch.setattr(builtins, "sorted", _boom)
    assert inst._peek_cwd(proj) == "/Users/olduser/x"


# ---------- 票 09：install 寫入面 target 側身分階段間硬化 ----------


def test_new_target_ancestor_swapped_to_symlink_after_plan(tmp_path: Path):
    """票 09-1：plan 時 target 不存在→釘最深既存祖先；install 前祖先被換成指向外部
    的 symlink → 該帳號 failed（O_NOFOLLOW 拒開、穩定判別碼）、外部零寫入。"""
    src = _staging(tmp_path)
    base = tmp_path / "base"
    base.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    p = inst.plan(str(src), {"work": {"config_dir": str(base / "nest" / "live"),
                                      "label": ""}})
    base.rmdir()
    base.symlink_to(outside)
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed" for r in results)
    assert list(outside.iterdir()) == []


def test_new_target_ancestor_swapped_to_real_dir_after_plan(tmp_path: Path):
    """同上、真目錄變體：祖先被換成另一個真目錄（O_NOFOLLOW 攔不到）→ 身分不符
    target_moved、替身零寫入。"""
    src = _staging(tmp_path)
    base = tmp_path / "base"
    base.mkdir()
    p = inst.plan(str(src), {"work": {"config_dir": str(base / "nest" / "live"),
                                      "label": ""}})
    import shutil
    shutil.rmtree(base)
    base.mkdir()                                # 同名、新 inode
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed"
               and r.error == "target_moved" for r in results)
    assert list(base.rglob("*")) == []          # 替身樹零寫入


def test_intermediate_created_after_plan_is_tolerated(tmp_path: Path):
    """中間元件在 plan 後被第三方建成**真目錄** → 不算衝突、EEXIST 容忍照常往下建。"""
    src = _staging(tmp_path)
    base = tmp_path / "base"
    base.mkdir()
    p = inst.plan(str(src), {"work": {"config_dir": str(base / "nest" / "live"),
                                      "label": ""}})
    (base / "nest").mkdir()
    results = inst.install(p)
    assert {r.outcome for r in results} == {"installed"}
    assert (base / "nest" / "live" / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"


def test_symlink_refused_when_node_replaced_after_first_phase(
        tmp_path: Path, monkeypatch):
    """票 09-2：node 在第一階段記錄後、第二階段建連結前被換成**別的既有目錄**（同名
    同型別、不同 inode）→ 身分不符不授權、不建——現行只驗集合 membership（名字沒變）
    會誤放行，把連結指到不是本次發布的內容。"""
    src = _staging_with_link(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    p = inst.plan(str(src), _accounts(tgt))
    real_read_manifest = inst.read_manifest

    def _swap_then_read(source_root):
        cmds = tgt / "commands"
        if cmds.is_dir() and not cmds.is_symlink():
            import shutil
            shutil.rmtree(cmds)
            cmds.mkdir()                    # 同名、新 inode
        return real_read_manifest(source_root)

    monkeypatch.setattr(inst, "read_manifest", _swap_then_read)
    results = inst.install(p)
    assert not os.path.lexists(tgt / "linked")
    # 判 failed 不判 excluded：這是篡改形狀，journal 必須保留（excluded 會放行清除，
    # 重跑時 node 全 EEXIST 不再記錄、連結永久補不回——票 04 F3 同型）。
    assert any(r.rel_path == "linked" and r.outcome == "failed"
               and r.error == "node_identity_mismatch" for r in results)
    assert inst.journal_path(inst.transaction_id(p)).exists()


def test_symlink_refused_when_node_becomes_symlink_after_first_phase(
        tmp_path: Path, monkeypatch):
    """同上、symlink 變體：node 被換成指向外部的 symlink → O_NOFOLLOW 拒開、不授權
    不建，外部零觸碰。"""
    src = _staging_with_link(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    outside = tmp_path / "outside"
    outside.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    real_read_manifest = inst.read_manifest

    def _swap_then_read(source_root):
        cmds = tgt / "commands"
        if cmds.is_dir() and not cmds.is_symlink():
            import shutil
            shutil.rmtree(cmds)
            cmds.symlink_to(outside)
        return real_read_manifest(source_root)

    monkeypatch.setattr(inst, "read_manifest", _swap_then_read)
    results = inst.install(p)
    assert not os.path.lexists(tgt / "linked")
    assert any(r.rel_path == "linked" and r.outcome == "failed"
               and r.error == "node_identity_mismatch" for r in results)
    assert list(outside.iterdir()) == []
    assert inst.journal_path(inst.transaction_id(p)).exists()


def test_reparented_spot_mid_install_stops_both(tmp_path: Path, monkeypatch):
    """票 09-3：fd 版重疊重驗通過後、寫入中，落點 B 被 rename 進落點 A 的樹（名字對
    上 A 來源的子目錄）→ A 開該子目錄時認出是別的落點的 root、停寫，雙方 failed
    overlapping_config_dirs；B 的 inode 不收 A 的內容、journal 不記污染項。"""
    src = _two_account_staging(tmp_path)
    tgt_work = tmp_path / "live-work"
    tgt_work.mkdir()
    tgt_personal = tmp_path / "live-personal"
    tgt_personal.mkdir()
    accounts = {
        "work": {"config_dir": str(tgt_work), "label": ""},
        "personal": {"config_dir": str(tgt_personal), "label": ""},
    }
    p = inst.plan(str(src), accounts)
    real_drop = inst._drop_overlapping_spots

    def _drop_then_reparent(prepared, results):
        kept = real_drop(prepared, results)
        os.rename(tgt_personal, tgt_work / "skills")   # B 的 root 搬進 A 樹、名字對上
        return kept

    monkeypatch.setattr(inst, "_drop_overlapping_spots", _drop_then_reparent)
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed"
               and r.error == "overlapping_config_dirs" for r in results)
    assert any(r.account == "personal" and r.outcome == "failed"
               and r.error == "overlapping_config_dirs" for r in results)
    moved = tgt_work / "skills"                        # ＝B 的 inode
    assert not (moved / "a.md").exists()               # A 的內容零跨帳號寫入
    assert not (moved / "P.md").exists()               # B 也停手
    assert "work/skills" not in inst.installed_nodes(inst.transaction_id(p))


def test_reparented_prior_round_dir_is_recognized(tmp_path: Path, monkeypatch):
    """票 09-3 跨輪變體：**前輪**（中斷續作）裝出的別家目錄被搬進本落點樹裡——
    dir_owners 以 journal 的身分記錄起底，本輪一開就認得出、雙方停寫。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src = _two_account_staging(tmp_path)
    tgt_work = tmp_path / "live-work"
    tgt_work.mkdir()
    tgt_personal = tmp_path / "live-personal"
    tgt_personal.mkdir()
    accounts = {
        "work": {"config_dir": str(tgt_work), "label": ""},
        "personal": {"config_dir": str(tgt_personal), "label": ""},
    }
    p = inst.plan(str(src), accounts)
    # 偽造前輪：personal 曾裝出一個目錄，之後被搬到 work 樹裡、名字對上 work 的來源
    (tgt_work / "skills").mkdir()
    st = os.stat(tgt_work / "skills")
    jp = inst.journal_path(inst.transaction_id(p))
    jp.parent.mkdir(parents=True, exist_ok=True)
    jp.write_text(json.dumps({"node": "personal/stuff", "dev": st.st_dev,
                              "ino": st.st_ino, "kind": "dir"}) + "\n",
                  encoding="utf-8")
    results = inst.install(p)
    assert any(r.account == "work" and r.outcome == "failed"
               and r.error == "overlapping_config_dirs" for r in results)
    assert not (tgt_work / "skills" / "a.md").exists()


def test_symlink_removed_when_node_swapped_after_verification(
        tmp_path: Path, monkeypatch):
    """票 09 R1 F1：_node_identity_matches 通過後、_symlink_at 建立前 node 被換——
    建後重驗必須抓到、拆掉剛建的連結、記 failed。"""
    src = _staging_with_link(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    p = inst.plan(str(src), _accounts(tgt))
    real_match = inst._node_identity_matches
    state = {"n": 0}

    def _match_then_swap(root_fd, rel, expected):
        ok = real_match(root_fd, rel, expected)
        state["n"] += 1
        if state["n"] == 1 and ok:            # 首次（建前）驗證通過後置換 node
            import shutil
            shutil.rmtree(tgt / "commands")
            (tgt / "commands").mkdir()
        return ok

    monkeypatch.setattr(inst, "_node_identity_matches", _match_then_swap)
    results = inst.install(p)
    assert not os.path.lexists(tgt / "linked")
    assert any(r.rel_path == "linked" and r.outcome == "failed"
               and r.error == "node_identity_mismatch" for r in results)


def test_unreadable_prior_journal_fails_closed(tmp_path: Path, monkeypatch):
    """票 09 R1 F2：journal 非空但解不出（invalid UTF-8）→ 全體落點 fail-closed
    provenance_unavailable、零寫入——跨輪 dir_owners 起底不得靜默降級。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    jp = inst.journal_path(inst.transaction_id(p))
    jp.parent.mkdir(parents=True, exist_ok=True)
    jp.write_bytes(b"\xff\xfe not utf8 \xff\n")
    results = inst.install(p)
    assert all(r.outcome == "failed" and r.error == "provenance_unavailable"
               for r in results)
    assert list(tgt.iterdir()) == []


def test_prior_journal_pread_oserror_fails_closed(tmp_path: Path, monkeypatch):
    """同上、I/O 錯誤變體：pread 拋 OSError → fail-closed 不裸拋、零寫入。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    jp = inst.journal_path(inst.transaction_id(p))
    jp.parent.mkdir(parents=True, exist_ok=True)
    jp.write_text(json.dumps({"node": "work/x", "dev": 1, "ino": 2,
                              "kind": "dir"}) + "\n", encoding="utf-8")

    def _boom(*a, **k):
        raise OSError(5, "io error")

    monkeypatch.setattr(inst.os, "pread", _boom)
    results = inst.install(p)
    assert all(r.outcome == "failed" and r.error == "provenance_unavailable"
               for r in results)
    assert list(tgt.iterdir()) == []


def test_rollback_spares_user_object_swapped_in_after_link(
        tmp_path: Path, monkeypatch):
    """票 09 R2 F1：建後重驗失敗、回滾 unlink 前 link 被換成使用者的同名一般檔——
    回滾必須先驗「仍是本輪建的 symlink 且字面值一致」才刪，換入的檔案不得誤刪。"""
    src = _staging_with_link(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    p = inst.plan(str(src), _accounts(tgt))
    real_match = inst._node_identity_matches
    state = {"n": 0}

    def _hook(root_fd, rel, expected):
        ok = real_match(root_fd, rel, expected)
        state["n"] += 1
        if state["n"] == 1 and ok:            # 建前驗證後換 node → 建後重驗必失敗
            import shutil
            shutil.rmtree(tgt / "commands")
            (tgt / "commands").mkdir()
        elif state["n"] == 2:
            # 驗證回傳後、發布決策前：使用者在最終名放上**同字面值的 symlink**
            # （Codex R3：同型別＋同 target 的身分混淆變體）——暫名發布模型下
            # 最終名從不被回滾，該物件必須原封不動。
            (tgt / "linked").symlink_to("/Users/olduser/.claude/commands")
        return ok

    monkeypatch.setattr(inst, "_node_identity_matches", _hook)
    results = inst.install(p)
    assert os.path.islink(tgt / "linked")             # 使用者的連結原封不動
    assert any(r.rel_path == "linked" and r.outcome == "failed"
               and r.error == "node_identity_mismatch" for r in results)
    assert not [e for e in os.listdir(tgt) if e.startswith(".fledge-lnk-")]  # 暫名清乾淨


def test_corrupt_prior_journal_lines_fail_closed(tmp_path: Path, monkeypatch):
    """票 09 R2 F2：journal 非空且內容損壞（**合法 UTF-8**）——malformed JSON／缺身分
    欄位／好壞行混雜，跨輪起底一律全體 fail-closed provenance_unavailable、零寫入；
    寬鬆容錯只留給公開 installed_nodes。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    src = _staging(tmp_path)
    good = json.dumps({"node": "work/x", "dev": 1, "ino": 2, "kind": "dir"})
    cases = ["NOT JSON\n",
             json.dumps({"node": "work/x"}) + "\n",
             good + "\nNOT JSON\n"]
    for i, payload in enumerate(cases):
        tgt = tmp_path / f"live{i}"
        tgt.mkdir()
        p = inst.plan(str(src), _accounts(tgt))
        jp = inst.journal_path(inst.transaction_id(p))
        jp.parent.mkdir(parents=True, exist_ok=True)
        jp.write_text(payload, encoding="utf-8")
        results = inst.install(p)
        assert all(r.outcome == "failed" and r.error == "provenance_unavailable"
                   for r in results), payload
        assert list(tgt.iterdir()) == [], payload


def test_existing_entry_at_link_name_is_skipped_untouched(
        tmp_path: Path, monkeypatch):
    """發布分支的 EEXIST 語意（票 09 R4）：最終名已有使用者的項目 → os.link EEXIST
    → skipped、該項目原封不動、暫名清乾淨——驗證成功後的發布路徑確實走到。"""
    src = _staging_with_link(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    (tgt / "linked").write_text("USER", encoding="utf-8")   # 使用者既有同名檔
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert (tgt / "linked").read_text(encoding="utf-8") == "USER"
    assert any(r.rel_path == "linked" and r.outcome == "skipped" for r in results)
    assert not [e for e in os.listdir(tgt) if e.startswith(".fledge-lnk-")]


# ── 前一輪硬中斷留下的暫存殘骸：回報給呼叫端（票 06，增補 spec §4.2） ────────────
#
# `install()` 本來就會指認殘骸並 WARNING log，但**只進 log，使用者永遠看不到**。
# Plan B 的結果頁要把位置顯示出來並提供「在 Finder 中顯示」，所以需要一份絕對路徑清單。
# **app 不代勞刪除**（可用的判準全是可偽造的檔名特徵，達不到「只刪自己建的」）。


def _dead_pid() -> int:
    """一個確定已經不在的進程編號：跑完並回收過的子行程。

    `find_stale_temps` 只指認「產生者已確定不在」的暫存名（ESRCH 是唯一確定的訊號），
    寫死一個大數字在別的機器上可能剛好命中活著的進程，那時整條測試會靜默地什麼都沒驗到。"""
    proc = subprocess.Popen([sys.executable, "-c", ""])
    proc.wait(timeout=30)
    return proc.pid


def _plant_stale(directory: Path, pid: int, tag: str) -> Path:
    """在 `directory` 放一個「前一輪硬中斷留下的暫存檔」形狀的檔案。"""
    victim = directory / f".fledge-install-{pid}-{tag}"
    victim.write_text("HALF", encoding="utf-8")
    return victim


def _mark_unfinished_round(tmp_path: Path) -> None:
    """讓「有一輪沒收尾」成立——殘骸掃描的 gating（首次安裝一律不掃）。

    刻意用**別的 transaction** 的 journal：本次的 journal 若非空，跨輪 dir_owners
    起底會去解析它，那是另一條路徑，不該混進這組測試。"""
    jdir = tmp_path / "home" / ".fledge"
    jdir.mkdir(parents=True, exist_ok=True)
    (jdir / "restore-journal-0123456789abcdef.jsonl").write_text("", encoding="utf-8")


def test_stale_out_collects_absolute_paths_for_accounts_and_extra(
        tmp_path: Path, monkeypatch):
    """殘骸清單要能直接拿去開 Finder → **絕對路徑**（增補 spec §4.2）。

    模組內部累積的是 `<落點 key>/<rel>` 的**相對**形式（log 維持它——不必要地印出
    使用者的絕對路徑沒有好處），而 key 對應的落點分住兩張表：帳號在 `targets`、extra
    在 `extra_targets` 且 key 帶 `extra:` 前綴。直接把內部清單 extend 出去，前端拿到的
    是一份開不了的路徑。"""
    src = _staging_with_extra(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    agents = tmp_path / "home" / ".agents"
    agents.mkdir()
    (tgt / "skills").mkdir()            # 子目錄層的殘骸也要拼對
    pid = _dead_pid()
    planted = [
        _plant_stale(tgt, pid, "aaaaaaaa"),
        _plant_stale(tgt / "skills", pid, "bbbbbbbb"),
        _plant_stale(agents, pid, "cccccccc"),
    ]
    _mark_unfinished_round(tmp_path)

    stale: list[str] = []
    inst.install(inst.plan(str(src), _accounts(tgt), extra={"agents": str(agents)}),
                 stale_out=stale)
    assert sorted(stale) == sorted(str(p) for p in planted)
    assert all(os.path.isabs(s) for s in stale)


def test_stale_out_stays_empty_when_no_round_was_left_unfinished(
        tmp_path: Path, monkeypatch):
    """首次安裝不掃描目的地（成本按目的地既有目錄項計費，不是按殘骸數），所以傳了
    收集參數也回空清單——殘骸就擺在那裡也一樣。新增的 side-channel 不得把既有的
    gating 繞過去。"""
    src = _staging(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    _plant_stale(tgt, _dead_pid(), "aaaaaaaa")

    stale: list[str] = []
    inst.install(inst.plan(str(src), _accounts(tgt)), stale_out=stale)
    assert stale == []


def test_install_without_stale_out_keeps_reporting_only_to_log(
        tmp_path: Path, monkeypatch, caplog):
    """不傳收集參數時行為與既有完全一致：照樣掃、照樣 WARNING log、結果照樣完整。

    收集參數是選填的 side-channel，`install()` 的回傳型別有大量既有斷言依賴——這條是
    那批斷言的回歸保護。"""
    src = _staging(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    _plant_stale(tgt, _dead_pid(), "aaaaaaaa")
    _mark_unfinished_round(tmp_path)

    with caplog.at_level(logging.WARNING, logger="fledge_sidecar.backup.install"):
        results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert "殘留的暫存檔" in caplog.text
    assert {r.outcome for r in results} == {"installed"}


def test_stale_scan_covers_only_what_this_round_walks(tmp_path: Path, monkeypatch):
    """**記錄在案的界線**（票 08 的成本取捨；Codex 票 06 R2 F2 再次指出）：殘骸掃描的
    範圍就是本輪會寫入的目錄——遞迴由**來源**樹驅動，所以前一輪留在深層的殘骸，若本輪
    的來源不再有那個子樹（重展的 bundle 少了它、mapping 改了目的地、來源子目錄開不起來），
    就掃不到。

    **不改成「獨立遍歷每個落點的目的樹」**：那是票 08 R1 F3 記錄過的成本決策——落點常有
    上千個使用者既有檔案，那等於每次安裝都全掃一次使用者的現役目錄；而漏報的後果有界，
    殘骸是無害的隱藏檔，只是少告訴使用者幾個位置。

    這條測試釘的是界線本身，不是「期望的行為」。要改掃描策略的人會先在這裡看到取捨。"""
    src = _staging(tmp_path)
    tgt = _home_target(tmp_path, monkeypatch)
    # 前一輪在深層留下的殘骸——本輪的來源沒有 `gone/` 這個子樹，走不到那裡
    (tgt / "gone").mkdir()
    deep = _plant_stale(tgt / "gone", _dead_pid(), "dddddddd")
    shallow = _plant_stale(tgt, _dead_pid(), "aaaaaaaa")
    _mark_unfinished_round(tmp_path)

    stale: list[str] = []
    inst.install(inst.plan(str(src), _accounts(tgt)), stale_out=stale)
    assert stale == [str(shallow)], "本輪會寫入的那一層要指認得到"
    assert deep.exists(), "走不到的深層殘骸原封不動——只是這一輪報不出來"


# ---------- 票 10：安全讀取展開目錄裡的 JSON ----------
#
# 展開目錄的內容全部來自不可信的 tar（spec §4.2.2）。`manifest.json` 與票 09 要讀的
# `fledge/config.json` 是同一份不可信輸入的兩個讀取點，共用 `read_bundle_json`。


def _plant_fledge_config(src: Path, payload: dict) -> None:
    """比照 `backup-claude.sh:267` 的產出佈局：`<bundle>/fledge/config.json`。"""
    (src / "fledge").mkdir(exist_ok=True)
    (src / "fledge" / "config.json").write_text(json.dumps(payload), encoding="utf-8")


def test_read_bundle_json_reads_a_nested_object(tmp_path: Path):
    """票 09 會讀的就是這一份：中間隔一層目錄也要讀得到，否則這支原語對它沒用。"""
    src = _staging(tmp_path)
    payload = {"kms_root": "/Users/olduser/kms", "subscriptions": []}
    _plant_fledge_config(src, payload)
    assert inst.read_bundle_json(str(src), "fledge", "config.json") == payload


def test_read_bundle_json_refuses_a_missing_file(tmp_path: Path):
    """包裡沒有這一份是**正常情況**（舊版備份腳本產的包就沒有）——原語只負責拋，
    「當作沒有、移機不失敗」的處置由呼叫端決定（票 09）。"""
    src = _staging(tmp_path)
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.read_bundle_json(str(src), "fledge", "config.json")


def test_read_bundle_json_refuses_a_non_object_top_level(tmp_path: Path):
    """頂層不是物件就不是我們要的東西——`read_manifest` 原本自己驗這一條，搬進原語
    之後票 09 那一側也一體適用（`config.json` 是 list 時 `.get` 會裸 AttributeError）。"""
    src = _staging(tmp_path)
    (src / "fledge").mkdir()
    (src / "fledge" / "config.json").write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.read_bundle_json(str(src), "fledge", "config.json")


def test_read_manifest_refuses_a_manifest_symlinked_inside_the_bundle(tmp_path: Path):
    """`manifest.json` 是 symlink → source_not_a_bundle，**指到包內也一樣**。

    判準是「它是不是 symlink」，不是「它指到哪裡」：要判後者就得在解析後重新比對
    路徑，那正是 TOCTOU 的形狀（比照 `_require_source_identity` 的順序理由）。

    decoy 是一份**完全合格**的 manifest——跟過去會成功回傳，所以少了 `O_NOFOLLOW`
    這條就變紅。目標若是壞掉的 JSON，形狀驗證那關照樣會擋下，測試就什麼都沒驗到。"""
    src = _staging(tmp_path)
    manifest = (src / "manifest.json").read_text(encoding="utf-8")
    (src / "decoy.json").write_text(manifest, encoding="utf-8")
    (src / "manifest.json").unlink()
    (src / "manifest.json").symlink_to("decoy.json")
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.read_manifest(str(src))


def test_read_manifest_refuses_a_manifest_symlinked_outside_the_bundle(tmp_path: Path):
    """包外那一格是**資訊洩漏**：manifest 的內容會經 `adopt-config` 的回應回顯給前端
    （`routes/restore.py` 拿它驗 account key／extra name），跟過去就是把展開目錄外的
    JSON 內容送出去。目標同樣是合格的 manifest，跟過去會成功。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "someone-elses.json"
    secret.write_text(json.dumps({
        "accounts": {"leaked": "/Users/olduser/.claude"}, "extra": {},
    }), encoding="utf-8")
    base = tmp_path / "case"
    base.mkdir()
    src = _staging(base)
    (src / "manifest.json").unlink()
    (src / "manifest.json").symlink_to(secret)
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.read_manifest(str(src))


def test_read_bundle_json_refuses_a_symlinked_intermediate_directory(tmp_path: Path):
    """中間層目錄是 symlink 也要擋：只擋最後一個元件的話，包裡一條 `fledge -> /`
    的目錄連結就能把讀取帶出展開目錄。

    `manifest.json` 沒有中間層，這條只有票 09 的路徑走得到——但原語現在就要正確。
    目標是一份合格 JSON，跟過去會成功回傳，所以中間層漏掉 `O_NOFOLLOW` 就變紅。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "config.json").write_text(
        json.dumps({"kms_root": "/leaked"}), encoding="utf-8")
    base = tmp_path / "case"
    base.mkdir()
    src = _staging(base)
    (src / "fledge").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.read_bundle_json(str(src), "fledge", "config.json")


class _StillBlocked(BaseException):
    """FIFO 逾時哨兵。**故意繼承 `BaseException`**：`read_manifest` 把 OSError 正規化成
    `source_not_a_bundle`，而 `TimeoutError` 正是 OSError 的子類——第一版用它當哨兵，
    結果阻塞滿五秒之後被吞成判別碼、測試照樣綠（測試名稱說的事沒真的驗）。"""


def test_read_manifest_refuses_a_fifo_without_blocking(tmp_path: Path):
    """`manifest.json` 是 FIFO → source_not_a_bundle，**而且不會卡住**。

    這是兩件事，要分開驗：POSIX 上唯讀開 FIFO 會等到有 writer 為止，少了 `O_NONBLOCK`
    的實作會讓這條測試永遠跑不完——**卡死的測試不是紅燈**。所以自帶 alarm，逾時就丟
    `_StillBlocked`，它穿得過 `pytest.raises` 與實作的 except 兩層。"""
    src = _staging(tmp_path)
    (src / "manifest.json").unlink()
    os.mkfifo(src / "manifest.json")

    def _blocked(signum, frame):
        raise _StillBlocked("read_manifest 在 FIFO 上阻塞了")

    previous = signal.signal(signal.SIGALRM, _blocked)
    signal.alarm(2)
    try:
        with pytest.raises(ValueError, match="source_not_a_bundle"):
            inst.read_manifest(str(src))
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def test_read_manifest_refuses_a_manifest_that_is_a_directory(tmp_path: Path):
    """**回歸保護，不是行為驗證**（誠實標註）：目錄這一格在裸 `read_text`（IsADirectoryError）
    與新原語（`fstat` 判非一般檔）底下都是 source_not_a_bundle，拿掉哪一道防線它都不會
    變紅。它釘的是判別碼不變，不是某一行實作。"""
    src = _staging(tmp_path)
    (src / "manifest.json").unlink()
    (src / "manifest.json").mkdir()
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.read_manifest(str(src))


def test_read_manifest_refuses_json_over_the_size_limit(tmp_path: Path):
    """大小上限的**兩側各一格**：只測超出的那一格，把上限寫成 0 也會綠。"""
    src = _staging(tmp_path)
    base = json.loads((src / "manifest.json").read_text(encoding="utf-8"))

    def _write_manifest_of_size(total: int) -> None:
        # pad 只放 ASCII 'x'，JSON 不跳脫，補幾個字元總長就多幾個
        empty = json.dumps({**base, "pad": ""})
        (src / "manifest.json").write_text(
            json.dumps({**base, "pad": "x" * (total - len(empty))}), encoding="utf-8")

    _write_manifest_of_size(inst._BUNDLE_JSON_MAX_BYTES)
    assert inst.read_manifest(str(src))["accounts"] == base["accounts"]

    _write_manifest_of_size(inst._BUNDLE_JSON_MAX_BYTES + 1)
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.read_manifest(str(src))

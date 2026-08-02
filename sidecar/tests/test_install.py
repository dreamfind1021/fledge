"""`backup/install.py` 的行為契約。

**全程假 HOME + tmp_path，絕不碰真實的 ~/.claude。** 這個模組是唯一有能力寫現役目錄的
還原路徑，測試自己更要守住同一條線。
"""
import json
import os
from pathlib import Path

import pytest
from conftest import make_staging as _staging

from fledge_sidecar.backup import install as inst


@pytest.fixture(autouse=True)
def _fake_home(tmp_path: Path, monkeypatch):
    """票 04 起 install() 會寫 provenance journal 到 ~/.fledge——沒有這層假 HOME，
    本檔任何一條 install 測試都會寫進真實家目錄（硬性要求：絕不碰真實 ~/.claude、
    ~/.claude-tc、~/.fledge）。個別測試自己 setenv HOME 會蓋過這裡，不衝突。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))


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
    home.mkdir()
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

    def _boom(_tid):
        raise OSError(5, "io error")

    monkeypatch.setattr(inst, "installed_nodes", _boom)
    results = inst.install(p)
    assert any(r.rel_path == "linked" and r.outcome == "failed" for r in results)
    assert inst.journal_path(inst.transaction_id(p)).exists()   # 未誤清


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

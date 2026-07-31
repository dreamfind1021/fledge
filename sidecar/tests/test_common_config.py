import os
from pathlib import Path
from typing import get_args

import pytest

from fledge_sidecar.setup import common_config as cc


def _accounts(tmp_path: Path) -> dict[str, dict[str, str]]:
    (tmp_path / "claude").mkdir()
    (tmp_path / "claude-tc").mkdir()
    return {
        "work": {"config_dir": str(tmp_path / "claude"), "label": "工作"},
        "personal": {"config_dir": str(tmp_path / "claude-tc"), "label": "私人"},
    }


def test_entry_specs_are_the_allowlist():
    names = [s.name for s in cc.ENTRY_SPECS]
    assert names == ["commands", "plugins", "skills", "settings.json", "CLAUDE.md", "projects"]
    by_name = {s.name: s for s in cc.ENTRY_SPECS}
    assert by_name["commands"].share == "symlink"
    assert by_name["CLAUDE.md"].share == "copy"      # 唯一 copy 項
    assert by_name["projects"].default_selected is False  # 進階項、預設不選


def test_build_graph_resolves_dirs_and_separates_roles(tmp_path: Path):
    g = cc.build_account_graph(_accounts(tmp_path), "work", ["personal"])
    assert g.source_key == "work"
    assert g.source_dir == str((tmp_path / "claude").resolve())
    assert g.targets == {"personal": str((tmp_path / "claude-tc").resolve())}


def test_build_graph_resolves_symlinked_account_dir(tmp_path: Path):
    # account dir 本身是 symlink → resolve 成實體路徑（containment root 必須穩定）
    real = tmp_path / "real-claude"
    real.mkdir()
    link = tmp_path / "linked-claude"
    link.symlink_to(real)
    (tmp_path / "tgt").mkdir()
    accounts = {
        "work": {"config_dir": str(link)},
        "personal": {"config_dir": str(tmp_path / "tgt")},
    }
    g = cc.build_account_graph(accounts, "work", ["personal"])
    assert g.source_dir == str(real.resolve())


def test_build_graph_rejects_unknown_keys(tmp_path: Path):
    accounts = _accounts(tmp_path)
    with pytest.raises(ValueError, match="unknown_account"):
        cc.build_account_graph(accounts, "ghost", ["personal"])
    with pytest.raises(ValueError, match="unknown_account"):
        cc.build_account_graph(accounts, "work", ["ghost"])


def test_build_graph_rejects_unusable_config_dir_string(tmp_path: Path):
    # expand_and_validate 的拒絕理由（中文 prose）不可外洩給 route——統一轉判別碼
    accounts = _accounts(tmp_path)
    for bad in ("", "   ", "relative/claude"):
        accounts["personal"] = {"config_dir": bad}
        with pytest.raises(ValueError, match="invalid_config_dir"):
            cc.build_account_graph(accounts, "work", ["personal"])


def test_build_graph_rejects_source_in_targets_and_empty_targets(tmp_path: Path):
    accounts = _accounts(tmp_path)
    with pytest.raises(ValueError, match="source_in_targets"):
        cc.build_account_graph(accounts, "work", ["work"])
    with pytest.raises(ValueError, match="empty_targets"):
        cc.build_account_graph(accounts, "work", [])


def test_build_graph_rejects_target_resolving_to_source_dir(tmp_path: Path):
    # 不同 key 但 config_dir 解析到同一實體目錄（symlink 別名／尾斜線寫法）。
    # 放行的話 source 目錄會被自己的備份動作改名，再被連成 broken link＝資料破壞。
    real = tmp_path / "claude"
    real.mkdir()
    alias = tmp_path / "claude-alias"
    alias.symlink_to(real)
    accounts = {
        "work": {"config_dir": str(real)},
        "personal": {"config_dir": str(alias)},
    }
    with pytest.raises(ValueError, match="target_equals_source"):
        cc.build_account_graph(accounts, "work", ["personal"])


def test_build_graph_rejects_overlapping_account_dirs(tmp_path: Path):
    # 祖先／子孫重疊同樣會破壞 source：
    # ①source 在 target 之下 → target_path 正好是 source 自己，備份會改名 source dir
    # ②target 在 source 之下 → 會在 source 內建連結指回其父目錄（可成環）
    parent = tmp_path / "a"
    (parent / "commands").mkdir(parents=True)
    with pytest.raises(ValueError, match="overlapping_account_dirs"):
        cc.build_account_graph(
            {"work": {"config_dir": str(parent / "commands")},
             "personal": {"config_dir": str(parent)}},
            "work", ["personal"])
    with pytest.raises(ValueError, match="overlapping_account_dirs"):
        cc.build_account_graph(
            {"work": {"config_dir": str(parent)},
             "personal": {"config_dir": str(parent / "commands")}},
            "work", ["personal"])


def test_build_graph_allows_sibling_account_dirs(tmp_path: Path):
    # 本專案真實配置＝平行目錄（~/.claude 與 ~/.claude-tc），overlap 防呆絕不能誤擋。
    # `.claude-tc` 不該被 `.claude` 前綴命中——is_within_root 以 root+os.sep 比對。
    for name in ("claude", "claude-tc"):
        (tmp_path / name).mkdir()
    g = cc.build_account_graph(
        {"work": {"config_dir": str(tmp_path / "claude")},
         "personal": {"config_dir": str(tmp_path / "claude-tc")}},
        "work", ["personal"])
    assert g.targets["personal"] == str((tmp_path / "claude-tc").resolve())


def test_build_graph_rejects_duplicate_target_dirs(tmp_path: Path):
    # 兩個 target 指同一目錄：同一份資料會被連續處理兩次（第二次看到的是第一次的產物）
    src = tmp_path / "src"
    src.mkdir()
    shared = tmp_path / "shared"
    shared.mkdir()
    alias = tmp_path / "shared-alias"
    alias.symlink_to(shared)
    accounts = {
        "work": {"config_dir": str(src)},
        "a": {"config_dir": str(shared)},
        "b": {"config_dir": str(alias)},
    }
    with pytest.raises(ValueError, match="duplicate_target"):
        cc.build_account_graph(accounts, "work", ["a", "b"])


def test_build_graph_rejects_overlapping_target_dirs(tmp_path: Path):
    # target 彼此巢狀與 target-source 重疊是同一族破壞：外層 target 的 entry 路徑可能
    # 正好是內層 target 的整個 config_dir（如 a=/t 的 projects 項＝b=/t/projects），
    # 備份會把內層帳號目錄整個改名。兩種登記順序都要擋，不能靠 target_keys 排列漏網。
    src = tmp_path / "src"
    src.mkdir()
    outer = tmp_path / "t"
    (outer / "projects").mkdir(parents=True)
    accounts = {
        "work": {"config_dir": str(src)},
        "a": {"config_dir": str(outer)},
        "b": {"config_dir": str(outer / "projects")},
    }
    for order in (["a", "b"], ["b", "a"]):
        with pytest.raises(ValueError, match="overlapping_account_dirs"):
            cc.build_account_graph(accounts, "work", order)


def test_build_graph_rejects_home_ancestor_and_root(tmp_path: Path, monkeypatch):
    # 底線防呆（ADR-0001）：config_dir 指到 home 本身／home 祖先／根，
    # containment 完全不會叫，apply 會直接在 home 底下動手
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    for bad in (str(home), str(tmp_path), "/"):
        accounts = {
            "work": {"config_dir": str(home / ".claude")},
            "personal": {"config_dir": bad},
        }
        with pytest.raises(ValueError, match="unsafe_config_dir"):
            cc.build_account_graph(accounts, "work", ["personal"])


def test_build_graph_allows_dir_outside_home(tmp_path: Path, monkeypatch):
    # 允許任意路徑（ADR-0001）：home 外的自訂布局合法
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    outside = tmp_path / "elsewhere" / "claude-work"
    outside.mkdir(parents=True)
    accounts = {
        "work": {"config_dir": str(home / ".claude")},
        "personal": {"config_dir": str(outside)},
    }
    g = cc.build_account_graph(accounts, "work", ["personal"])
    assert g.targets["personal"] == str(outside.resolve())


def _dirs(tmp_path: Path) -> tuple[str, str]:
    """回 (source_dir, target_dir)，兩者皆已建立。"""
    src = tmp_path / "src"
    src.mkdir()
    tgt = tmp_path / "tgt"
    tgt.mkdir()
    return str(src), str(tgt)


SYMLINK_SPEC = cc.EntrySpec("commands", "symlink", True)
COPY_SPEC = cc.EntrySpec("CLAUDE.md", "copy", True)


def test_probe_source_missing_wins_over_everything(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    # source 沒有 commands/，即便 target 有實體目錄也不該動 → source_missing
    (Path(tgt) / "commands").mkdir()
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "source_missing"


def test_probe_missing_and_ok(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "missing"
    (Path(tgt) / "commands").symlink_to(Path(src) / "commands")
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "ok"


def test_probe_ok_accepts_equivalent_link_written_differently(tmp_path: Path):
    # 既有連結用相對路徑寫成，realpath 相同即視為 ok（不做無謂重建）
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    os.symlink(os.path.relpath(Path(src) / "commands", tgt), Path(tgt) / "commands")
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "ok"


def test_probe_rejects_link_that_matches_only_outside_source_dir(tmp_path: Path):
    # source entry 自己是 symlink 指到帳號目錄外時，target 直接連向同一實體目標雖然
    # realpath 相等，卻繞過了 source 帳號目錄。plan 明訂「source entry 是 symlink 時連
    # 字面路徑、不追鏈」以維持「連結目標限另一登記帳號」不變式——判 ok 等於從探測端把
    # 它放回來（Fledge 會宣稱已共通、C 的 repair 也修不到）。應判 wrong_link 由 relink 改正。
    src, tgt = _dirs(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (Path(src) / "commands").symlink_to(outside)
    (Path(tgt) / "commands").symlink_to(outside)
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "wrong_link"


def test_probe_wrong_and_broken_link(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    link = Path(tgt) / "commands"
    link.symlink_to(elsewhere)
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "wrong_link"
    link.unlink()
    link.symlink_to(tmp_path / "gone")
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "broken_link"


def test_probe_real_file_dir_and_empty_dir(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    empty = Path(tgt) / "commands"
    empty.mkdir()
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "empty_dir"  # 空目錄不必備份
    (empty / "x.md").write_text("hi", encoding="utf-8")
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "real_dir"
    empty_rm = Path(tgt) / "commands"
    (empty_rm / "x.md").unlink()
    empty_rm.rmdir()
    (Path(tgt) / "commands").write_text("actually a file", encoding="utf-8")
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "real_file"


def test_probe_copy_entry_states(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "CLAUDE.md").write_text("rules", encoding="utf-8")
    assert cc.probe_entry(src, tgt, COPY_SPEC) == "missing"
    (Path(tgt) / "CLAUDE.md").write_text("rules", encoding="utf-8")
    assert cc.probe_entry(src, tgt, COPY_SPEC) == "ok"          # 內容相同
    (Path(tgt) / "CLAUDE.md").write_text("different", encoding="utf-8")
    assert cc.probe_entry(src, tgt, COPY_SPEC) == "content_differs"
    (Path(tgt) / "CLAUDE.md").unlink()
    (Path(tgt) / "CLAUDE.md").symlink_to(Path(src) / "CLAUDE.md")
    assert cc.probe_entry(src, tgt, COPY_SPEC) == "unexpected_type"  # copy 項不該是 symlink


def test_probe_rejects_source_types_the_action_cannot_handle(tmp_path: Path):
    # source 型別必須先驗：否則 apply 會「先備份 target、再讀 source 失敗」，
    # 把使用者的 live 檔搬走卻沒放回任何東西
    src, tgt = _dirs(tmp_path)
    (Path(src) / "CLAUDE.md").mkdir()                       # copy 項的 source 是目錄
    assert cc.probe_entry(src, tgt, COPY_SPEC) == "source_unsupported"
    (Path(src) / "CLAUDE.md").rmdir()
    (Path(src) / "CLAUDE.md").symlink_to(tmp_path / "gone")  # broken symlink
    assert cc.probe_entry(src, tgt, COPY_SPEC) == "source_unsupported"
    # symlink 項的 source 是 broken symlink → 連過去只會製造 broken link，不做
    (Path(src) / "commands").symlink_to(tmp_path / "gone")
    assert cc.probe_entry(src, tgt, SYMLINK_SPEC) == "source_unsupported"


def test_probe_accepts_copy_source_symlinked_to_regular_file(tmp_path: Path):
    # source 是 symlink 指向實體檔＝可讀，忠實同步其內容（合法布局，不擋）
    src, tgt = _dirs(tmp_path)
    real = tmp_path / "real-claude.md"
    real.write_text("shared", encoding="utf-8")
    (Path(src) / "CLAUDE.md").symlink_to(real)
    assert cc.probe_entry(src, tgt, COPY_SPEC) == "missing"


def test_plan_maps_states_to_actions_and_overwrite_flag(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    for name in ("commands", "plugins", "skills"):
        (Path(src) / name).mkdir()
    (Path(src) / "CLAUDE.md").write_text("rules", encoding="utf-8")
    (Path(tgt) / "plugins").mkdir()
    (Path(tgt) / "plugins" / "a.json").write_text("{}", encoding="utf-8")  # real_dir
    (Path(tgt) / "CLAUDE.md").write_text("mine", encoding="utf-8")          # content_differs
    accounts = {"work": {"config_dir": src}, "personal": {"config_dir": tgt}}
    g = cc.build_account_graph(accounts, "work", ["personal"])
    p = cc.plan(g, ["commands", "plugins", "skills", "CLAUDE.md"])
    by_entry = {o.entry: o for o in p.operations}
    assert p.source_dir == str(Path(src).resolve())
    assert p.targets == {"personal": str(Path(tgt).resolve())}
    assert (by_entry["commands"].state, by_entry["commands"].action) == ("missing", "create_link")
    assert by_entry["commands"].needs_overwrite is False
    assert (by_entry["plugins"].state, by_entry["plugins"].action) == ("real_dir", "backup_and_link")
    assert by_entry["plugins"].needs_overwrite is True
    assert (by_entry["skills"].state, by_entry["skills"].action) == ("missing", "create_link")
    assert (by_entry["CLAUDE.md"].state, by_entry["CLAUDE.md"].action) == (
        "content_differs", "backup_and_copy")
    assert by_entry["CLAUDE.md"].needs_overwrite is True
    assert by_entry["commands"].target_path == str(Path(tgt).resolve() / "commands")


def test_plan_missing_copy_entry_maps_to_copy_not_create_link(tmp_path: Path):
    # missing 是唯一依 share 分流的狀態：copy 項不存在時要複製，不能建 symlink
    src, tgt = _dirs(tmp_path)
    (Path(src) / "CLAUDE.md").write_text("rules", encoding="utf-8")
    (Path(src) / "commands").mkdir()
    g = cc.build_account_graph(
        {"work": {"config_dir": src}, "personal": {"config_dir": tgt}}, "work", ["personal"])
    by_entry = {o.entry: o for o in cc.plan(g, ["commands", "CLAUDE.md"]).operations}
    assert by_entry["CLAUDE.md"].state == "missing"
    assert by_entry["CLAUDE.md"].action == "copy"
    assert by_entry["commands"].action == "create_link"


def test_action_for_handles_every_entry_state():
    # 漏一個 state＝plan() 在該狀態下 KeyError。以 EntryState 自身列舉而非手抄清單，
    # 日後新增狀態卻忘了補 _ACTION_BY_STATE 時這裡才會紅（映射表無法自我把關）。
    states = get_args(cc.EntryState)
    assert len(states) == 11
    for state in states:
        for share in ("symlink", "copy"):
            action, needs_overwrite = cc._action_for(state, share)
            assert action in get_args(cc.EntryAction)
            assert isinstance(needs_overwrite, bool)


def test_plan_rejects_unknown_entry(tmp_path: Path):
    accounts = _accounts(tmp_path)
    g = cc.build_account_graph(accounts, "work", ["personal"])
    with pytest.raises(ValueError, match="unknown_entry"):
        cc.plan(g, ["commands", "../../etc/passwd"])


def test_plan_covers_every_target(tmp_path: Path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "commands").mkdir()
    t1 = tmp_path / "t1"
    t1.mkdir()
    t2 = tmp_path / "t2"
    t2.mkdir()
    accounts = {
        "work": {"config_dir": str(src)},
        "a": {"config_dir": str(t1)},
        "b": {"config_dir": str(t2)},
    }
    g = cc.build_account_graph(accounts, "work", ["a", "b"])
    p = cc.plan(g, ["commands"])
    assert sorted(o.account for o in p.operations) == ["a", "b"]


def _graph(src: str, tgt: str) -> cc.AccountGraph:
    accounts = {"work": {"config_dir": src}, "personal": {"config_dir": tgt}}
    return cc.build_account_graph(accounts, "work", ["personal"])


def _manual_plan(src: str | Path, tgt: str | Path,
                 operations: list[cc.Operation]) -> cc.Plan:
    """手工組 Plan（不經 `plan()`）的測試捷徑，單一 `personal` target。

    `source_identity` 一律取 source dir **當下**的真實身分，讓票 10 的 per-mutation
    重驗自然通過——這些測試各自要驗的是別的不變式，不該被 source 重驗攔在前面。"""
    source_dir = str(Path(src).resolve())
    return cc.Plan(source_dir=source_dir, targets={"personal": str(Path(tgt).resolve())},
                   operations=operations, source_identity=cc.dir_identity(source_dir))


def test_apply_creates_links_and_copies(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(src) / "commands" / "a.md").write_text("A", encoding="utf-8")
    (Path(src) / "CLAUDE.md").write_text("rules", encoding="utf-8")
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["commands", "CLAUDE.md"]), overwrite=[])
    outcomes = {r.entry: r.outcome for r in res.results}
    assert outcomes == {"commands": "created", "CLAUDE.md": "copied"}
    link = Path(tgt) / "commands"
    assert link.is_symlink()
    assert os.readlink(link) == str(Path(src).resolve() / "commands")  # 字面指 source entry
    assert (link / "a.md").read_text(encoding="utf-8") == "A"
    assert (Path(tgt) / "CLAUDE.md").read_text(encoding="utf-8") == "rules"
    assert not (Path(tgt) / "CLAUDE.md").is_symlink()  # copy 項是實體檔


def test_apply_links_literal_path_when_source_entry_is_symlink(tmp_path: Path):
    # source entry 本身是 symlink → 連字面路徑，不追鏈（link target 永遠留在 source dir 內）
    src, tgt = _dirs(tmp_path)
    far = tmp_path / "far"
    far.mkdir()
    (Path(src) / "commands").symlink_to(far)
    g = _graph(src, tgt)
    cc.apply(cc.plan(g, ["commands"]), overwrite=[])
    assert os.readlink(Path(tgt) / "commands") == str(Path(src).resolve() / "commands")


def test_apply_relinks_wrong_and_broken_without_overwrite(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(src) / "skills").mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (Path(tgt) / "commands").symlink_to(elsewhere)          # wrong_link
    (Path(tgt) / "skills").symlink_to(tmp_path / "gone")    # broken_link
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["commands", "skills"]), overwrite=[])
    assert {r.outcome for r in res.results} == {"relinked"}
    assert os.readlink(Path(tgt) / "commands") == str(Path(src).resolve() / "commands")
    assert elsewhere.is_dir()   # 原目標沒被碰


def test_apply_replaces_empty_dir_without_backup(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").mkdir()   # 空目錄（首次登入常見）
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["commands"]), overwrite=[])
    assert res.results[0].outcome == "created"
    assert res.results[0].backup_path is None
    assert (Path(tgt) / "commands").is_symlink()


def test_apply_skips_ok_and_source_missing(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").symlink_to(Path(src) / "commands")   # 已 ok
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["commands", "plugins"]), overwrite=[])  # plugins source 沒有
    assert {r.entry: r.outcome for r in res.results} == {
        "commands": "skipped", "plugins": "skipped"}
    assert not (Path(tgt) / "plugins").exists()   # 不替使用者發明目錄


def test_apply_creates_missing_target_dir(tmp_path: Path):
    # 首次 onboarding：target 帳號 config_dir 還不存在 → 自動建最後一層
    src = tmp_path / "src"
    src.mkdir()
    (src / "commands").mkdir()
    tgt = tmp_path / "not-yet"
    accounts = {"work": {"config_dir": str(src)}, "personal": {"config_dir": str(tgt)}}
    g = cc.build_account_graph(accounts, "work", ["personal"])
    res = cc.apply(cc.plan(g, ["commands"]), overwrite=[])
    assert res.results[0].outcome == "created"
    assert (tgt / "commands").is_symlink()


def test_apply_fails_target_when_parent_missing(tmp_path: Path):
    # 只建最後一層：父目錄不存在＝路徑很可能打錯，不遞建一串垃圾目錄
    src = tmp_path / "src"
    src.mkdir()
    (src / "commands").mkdir()
    tgt = tmp_path / "no" / "such" / "parent"
    accounts = {"work": {"config_dir": str(src)}, "personal": {"config_dir": str(tgt)}}
    g = cc.build_account_graph(accounts, "work", ["personal"])
    res = cc.apply(cc.plan(g, ["commands"]), overwrite=[])
    assert res.results[0].outcome == "failed"
    assert res.results[0].error


def test_apply_continues_after_one_entry_fails(tmp_path: Path, monkeypatch):
    # 逐項盡力：單項失敗不阻斷其餘 entry
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(src) / "skills").mkdir()
    real_symlink = os.symlink

    def _boom(source, target, **kw):
        if str(target).endswith("commands"):
            raise PermissionError("nope")
        return real_symlink(source, target, **kw)

    monkeypatch.setattr(cc.os, "symlink", _boom)
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["commands", "skills"]), overwrite=[])
    by_entry = {r.entry: r for r in res.results}
    assert by_entry["commands"].outcome == "failed"
    assert by_entry["skills"].outcome == "created"


def test_apply_marks_stale_when_fs_changed_after_plan(tmp_path: Path):
    # TOCTOU：plan 後 target 冒出實體檔 → apply 前重探測不符 → stale，不依過時 plan 覆寫
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    g = _graph(src, tgt)
    p = cc.plan(g, ["commands"])
    assert p.operations[0].state == "missing"
    (Path(tgt) / "commands").write_text("appeared after plan", encoding="utf-8")
    res = cc.apply(p, overwrite=[])
    assert res.results[0].outcome == "stale"
    assert (Path(tgt) / "commands").read_text(encoding="utf-8") == "appeared after plan"


def test_apply_refuses_when_target_dir_swapped_for_symlink(tmp_path: Path):
    # parent containment 重驗（spec §6.5）：plan 後整個 target account dir 被換成
    # 指向別處的 symlink → 所有 mutation 都會落到 account dir 外
    src = tmp_path / "src"
    src.mkdir()
    (src / "commands").mkdir()
    tgt = tmp_path / "tgt"
    tgt.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    g = _graph(str(src), str(tgt))
    p = cc.plan(g, ["commands"])
    tgt.rmdir()
    tgt.symlink_to(outside)
    res = cc.apply(p, overwrite=[])
    assert res.results[0].outcome == "failed"
    assert not (outside / "commands").exists()   # 沒寫出 account dir


def test_relink_never_deletes_a_real_file_it_did_not_inspect(tmp_path: Path, monkeypatch):
    # 殘餘 race：重探測說是 symlink，但 unlink 之前被換成實體檔。
    # 直接 unlink 會誤刪未授權資料（relink 的 needs_overwrite=False），
    # 故改走「隔離改名→驗型別」——資料必須存活。
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").write_text("REAL", encoding="utf-8")
    op = cc.Operation("personal", "commands", str(Path(tgt).resolve() / "commands"),
                      "wrong_link", "relink", False)
    p = _manual_plan(src, tgt, [op])
    monkeypatch.setattr(cc, "probe_entry", lambda *a, **k: "wrong_link")  # 騙過重探測
    res = cc.apply(p, overwrite=[])
    assert res.results[0].outcome in {"stale", "failed"}
    survivors = [q for q in Path(tgt).iterdir()
                 if q.is_file() and not q.is_symlink()
                 and q.read_text(encoding="utf-8") == "REAL"]
    assert survivors, "實體檔必須存活（原位或隔離備份）"


def test_relink_restore_does_not_clobber_a_file_that_reappeared(tmp_path: Path, monkeypatch):
    # 隔離改名後、還原前，target 位置又冒出新檔：還原用的 os.rename 會靜默覆蓋它。
    # 正確行為是保留隔離檔並回報位置——新舊兩份資料都必須存活。
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").write_text("REAL", encoding="utf-8")
    real_backup = cc._backup

    def _backup_then_someone_writes(path: str) -> str:
        b = real_backup(path)
        Path(path).write_text("NEW", encoding="utf-8")   # 空窗中冒出的新檔
        return b

    monkeypatch.setattr(cc, "_backup", _backup_then_someone_writes)
    monkeypatch.setattr(cc, "probe_entry", lambda *a, **k: "wrong_link")
    op = cc.Operation("personal", "commands", str(Path(tgt).resolve() / "commands"),
                      "wrong_link", "relink", False)
    p = _manual_plan(src, tgt, [op])
    r = cc.apply(p, overwrite=[]).results[0]
    assert r.outcome == "stale"
    assert r.backup_path is not None
    assert Path(r.backup_path).read_text(encoding="utf-8") == "REAL"   # 舊資料在隔離檔
    assert (Path(tgt) / "commands").read_text(encoding="utf-8") == "NEW"  # 新檔沒被蓋掉


def test_backup_never_overwrites_existing_backup(tmp_path: Path):
    # 同秒內第二次備份不得蓋掉第一次（rename 對檔案是靜默覆蓋，會直接吃掉資料）
    victim = tmp_path / "commands"
    victim.write_text("first", encoding="utf-8")
    b1 = cc._backup(str(victim))
    victim.write_text("second", encoding="utf-8")
    b2 = cc._backup(str(victim))
    assert b1 != b2
    assert Path(b1).read_text(encoding="utf-8") == "first"
    assert Path(b2).read_text(encoding="utf-8") == "second"


def test_apply_rechecks_containment_before_every_op(tmp_path: Path, monkeypatch):
    # 票券不變式：「mkdir 後與每個 op 前各驗」。prepared 是 per-account 快取，只驗
    # mkdir 那次的話，多 entry 帳號在第一個 op 完成後被抽換，其餘 entry 會整批寫到
    # account dir 外。這裡在第一個連結建好之後才抽換，只有 per-op 那道能擋。
    src = tmp_path / "src"
    src.mkdir()
    (src / "commands").mkdir()
    (src / "skills").mkdir()
    tgt = tmp_path / "tgt"
    tgt.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    g = _graph(str(src), str(tgt))
    p = cc.plan(g, ["commands", "skills"])
    real_symlink = os.symlink
    swapped: list[str] = []

    def _swap_after_first_link(source, target, **kw):
        real_symlink(source, target, **kw)
        if not swapped:
            swapped.append(str(target))
            for child in tgt.iterdir():
                child.unlink()
            tgt.rmdir()
            real_symlink(outside, tgt)   # 不走 Path.symlink_to：它會再繞回被 patch 的 os.symlink

    monkeypatch.setattr(cc.os, "symlink", _swap_after_first_link)
    outcomes = [r.outcome for r in cc.apply(p, overwrite=[]).results]
    assert outcomes == ["created", "failed"]
    assert not (outside / "skills").exists()   # 沒寫出 account dir


def test_apply_stops_when_source_dir_is_swapped_after_the_probe(tmp_path: Path, monkeypatch):
    """source 側的 check→use 窗口（票 10）：閘與重探測都通過之後、mutation 之前，
    source dir 被改名再於同一路徑放進另一個目錄。建出來的連結字面仍是 `source_dir/entry`，
    指的卻是沒經過 `build_account_graph` 驗證的內容——必須停手。

    抽換點刻意放在 `probe_entry` **回傳之後**：在呼叫 apply 之前就換好的話，測到的是
    前置閘而不是這個窗口（票 08 的既有測試已經涵蓋前置閘）。"""
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    outside = tmp_path / "elsewhere"
    (outside / "commands").mkdir(parents=True)
    (Path(tgt) / "commands").symlink_to(outside / "commands")   # wrong_link → relink，免授權
    p = cc.plan(_graph(src, tgt), ["commands"])
    assert [op.state for op in p.operations] == ["wrong_link"]

    impostor = tmp_path / "impostor"
    (impostor / "commands").mkdir(parents=True)
    real_probe = cc.probe_entry

    def _probe_then_swap(source_dir: str, target_dir: str, spec):
        state = real_probe(source_dir, target_dir, spec)
        os.rename(src, tmp_path / "moved-away")   # 閘已通過才動手
        os.rename(impostor, src)                  # 同一路徑、不同目錄
        return state

    monkeypatch.setattr(cc, "probe_entry", _probe_then_swap)

    (r,) = cc.apply(p, overwrite=[]).results

    assert r.outcome == "failed"
    assert r.error == "source_dir_moved"
    # 原連結必須原封不動：relink 不需要 overwrite 授權，動了就是免授權改寫
    assert os.readlink(Path(tgt) / "commands") == str(outside / "commands")


def test_repair_stops_when_source_dir_is_swapped_after_the_gate(tmp_path: Path, monkeypatch):
    """`_require_usable_source` 是一次性前置閘，驗過的身分沒有綁進後續每次 mutation。
    它通過之後 source 被換掉，repair 重建出來的連結就會指向未經驗證的內容。"""
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "skills").mkdir()
    (tgt / "skills").symlink_to(_old_machine(tmp_path, "skills"))   # broken_link
    p = cc.plan(_graph(str(src), str(tgt)), ["skills"])
    assert [op.state for op in p.operations] == ["broken_link"]

    impostor = tmp_path / "impostor"
    (impostor / "skills").mkdir(parents=True)
    real_probe = cc.probe_entry

    def _probe_then_swap(source_dir: str, target_dir: str, spec):
        state = real_probe(source_dir, target_dir, spec)
        os.rename(src, tmp_path / "moved-away")
        os.rename(impostor, src)
        return state

    monkeypatch.setattr(cc, "probe_entry", _probe_then_swap)

    (r,) = cc.repair(p).results

    assert r.outcome == "failed"
    assert r.error == "source_dir_moved"
    assert os.readlink(tgt / "skills") == str(_old_machine(tmp_path, "skills"))


def test_apply_refuses_destructive_without_overwrite(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").mkdir()
    (Path(tgt) / "commands" / "mine.md").write_text("MINE", encoding="utf-8")
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["commands"]), overwrite=[])
    assert res.results[0].outcome == "conflict"
    assert (Path(tgt) / "commands" / "mine.md").read_text(encoding="utf-8") == "MINE"


def test_apply_backs_up_real_dir_then_links(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").mkdir()
    (Path(tgt) / "commands" / "mine.md").write_text("MINE", encoding="utf-8")
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["commands"]), overwrite=[("personal", "commands")])
    r = res.results[0]
    assert r.outcome == "created"
    assert r.backup_path is not None
    backup = Path(r.backup_path)
    assert backup.parent == Path(tgt).resolve()      # 就地改名，不跨目錄搬移
    assert backup.name.startswith("commands.fledge-backup-")
    assert (backup / "mine.md").read_text(encoding="utf-8") == "MINE"
    assert (Path(tgt) / "commands").is_symlink()


def test_apply_backs_up_conflicting_claude_md(tmp_path: Path):
    src, tgt = _dirs(tmp_path)
    (Path(src) / "CLAUDE.md").write_text("shared", encoding="utf-8")
    (Path(tgt) / "CLAUDE.md").write_text("mine", encoding="utf-8")
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["CLAUDE.md"]), overwrite=[("personal", "CLAUDE.md")])
    r = res.results[0]
    assert r.outcome == "copied"
    assert Path(r.backup_path).read_text(encoding="utf-8") == "mine"
    assert (Path(tgt) / "CLAUDE.md").read_text(encoding="utf-8") == "shared"


def test_apply_backs_up_symlinked_copy_entry_without_following_it(tmp_path: Path):
    # copy 項是 symlink 指到 source dir 外：備份用 rename（不跟隨），
    # 再以 O_EXCL 建新檔——絕不能寫穿到那個外部檔案
    src, tgt = _dirs(tmp_path)
    (Path(src) / "CLAUDE.md").write_text("shared", encoding="utf-8")
    outside = tmp_path / "outside.md"
    outside.write_text("DO NOT TOUCH", encoding="utf-8")
    (Path(tgt) / "CLAUDE.md").symlink_to(outside)
    g = _graph(src, tgt)
    p = cc.plan(g, ["CLAUDE.md"])
    assert p.operations[0].state == "unexpected_type"
    r = cc.apply(p, overwrite=[("personal", "CLAUDE.md")]).results[0]
    assert r.outcome == "copied"
    assert outside.read_text(encoding="utf-8") == "DO NOT TOUCH"   # 外部檔案毫髮無傷
    assert (Path(tgt) / "CLAUDE.md").read_text(encoding="utf-8") == "shared"
    assert not (Path(tgt) / "CLAUDE.md").is_symlink()
    # 原本那條 symlink 是使用者的東西，必須以備份保留（不是被 unlink 丟掉）
    assert r.backup_path is not None
    assert Path(r.backup_path).is_symlink()
    assert os.readlink(r.backup_path) == str(outside)


def test_overwrite_for_one_account_does_not_authorize_another(tmp_path: Path):
    # 授權以 (account, entry) 為單位：勾了 a 帳號的 commands，不得連帶炸掉 b 帳號的
    src = tmp_path / "src"
    src.mkdir()
    (src / "commands").mkdir()
    dirs = {}
    for key in ("a", "b"):
        d = tmp_path / key
        d.mkdir()
        (d / "commands").mkdir()
        (d / "commands" / "mine.md").write_text(key, encoding="utf-8")
        dirs[key] = d
    accounts = {
        "work": {"config_dir": str(src)},
        "a": {"config_dir": str(dirs["a"])},
        "b": {"config_dir": str(dirs["b"])},
    }
    g = cc.build_account_graph(accounts, "work", ["a", "b"])
    res = cc.apply(cc.plan(g, ["commands"]), overwrite=[("a", "commands")])
    by_account = {r.account: r.outcome for r in res.results}
    assert by_account == {"a": "created", "b": "conflict"}
    assert (dirs["b"] / "commands" / "mine.md").read_text(encoding="utf-8") == "b"


def test_failed_replacement_still_reports_backup_path(tmp_path: Path, monkeypatch):
    # 備份成功但建連結失敗：使用者的資料在備份裡，結果必須告訴他備份在哪
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").mkdir()
    (Path(tgt) / "commands" / "mine.md").write_text("MINE", encoding="utf-8")

    def _boom(source, target, **kw):
        raise PermissionError("nope")

    monkeypatch.setattr(cc.os, "symlink", _boom)
    g = _graph(src, tgt)
    res = cc.apply(cc.plan(g, ["commands"]), overwrite=[("personal", "commands")])
    r = res.results[0]
    assert r.outcome == "failed"
    assert r.backup_path is not None
    assert (Path(r.backup_path) / "mine.md").read_text(encoding="utf-8") == "MINE"


def test_apply_recomputes_authorization_from_probed_state(tmp_path: Path):
    # 授權需求不得採信傳入的 Plan：手工 Plan 宣稱 needs_overwrite=False 卻帶破壞性
    # 動作時，模組在前一步才剛重探並確認 state，應據此重算而非讀 op 欄位。
    # ADR-0002 由 route 重算 plan 擋第一道，這是模組自己的第二道。
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").mkdir()
    (Path(tgt) / "commands" / "mine.md").write_text("MINE", encoding="utf-8")
    lying_op = cc.Operation("personal", "commands", str(Path(tgt).resolve() / "commands"),
                            "real_dir", "backup_and_link", False)
    p = _manual_plan(src, tgt, [lying_op])
    res = cc.apply(p, overwrite=[])
    assert res.results[0].outcome == "conflict"
    assert (Path(tgt) / "commands" / "mine.md").read_text(encoding="utf-8") == "MINE"
    assert not (Path(tgt) / "commands").is_symlink()


def test_failed_copy_replacement_still_reports_backup_path(tmp_path: Path, monkeypatch):
    # backup_and_copy 的復原性：備份成功但複製失敗時，備份位置一樣要回報
    # （既有測試只涵蓋 backup_and_link 那半邊）
    src, tgt = _dirs(tmp_path)
    (Path(src) / "CLAUDE.md").write_text("shared", encoding="utf-8")
    (Path(tgt) / "CLAUDE.md").write_text("mine", encoding="utf-8")

    # 收 **kwargs：common_config 目前不傳 dir_fd，但 stub 不該綁死在呼叫端的當前寫法上
    # ——真的收窄成兩個位置參數的話，哪天呼叫端加了關鍵字參數就會炸 TypeError
    # （而 deploy 只捕 OSError），測試變成崩潰而不是紅。
    def _boom(source_entry: str, target_path: str, **kwargs) -> None:
        raise PermissionError("nope")

    monkeypatch.setattr(cc.safe_fs, "copy_file_no_clobber", _boom)
    g = _graph(src, tgt)
    r = cc.apply(cc.plan(g, ["CLAUDE.md"]), overwrite=[("personal", "CLAUDE.md")]).results[0]
    assert r.outcome == "failed"
    assert r.backup_path is not None
    assert Path(r.backup_path).read_text(encoding="utf-8") == "mine"


def test_build_graph_rejects_case_alias_of_source_dir(tmp_path: Path):
    # APFS 預設不分大小寫：~/.claude 與 ~/.CLAUDE 是同一個目錄，但 resolve() 不做
    # 大小寫正規化，字串比對看不出來。放行的話 apply 會把 source 自己的 entry 備份
    # 改名、再建一個指向自己的 broken symlink——使用者資料從正常路徑就消失了。
    src = tmp_path / "claude"
    (src / "commands").mkdir(parents=True)
    alias = tmp_path / "CLAUDE"
    if not os.path.exists(alias):
        pytest.skip("此檔案系統區分大小寫，無此別名情境")
    accounts = {"work": {"config_dir": str(src)}, "personal": {"config_dir": str(alias)}}
    with pytest.raises(ValueError, match="target_equals_source"):
        cc.build_account_graph(accounts, "work", ["personal"])


def test_build_graph_rejects_case_alias_nested_under_source(tmp_path: Path):
    # 同理但用巢狀別名：target 落在 source 之下，字串比對同樣漏掉
    src = tmp_path / "claude"
    (src / "projects").mkdir(parents=True)
    nested_alias = tmp_path / "CLAUDE" / "projects"
    if not os.path.exists(nested_alias):
        pytest.skip("此檔案系統區分大小寫，無此別名情境")
    accounts = {"work": {"config_dir": str(src)}, "personal": {"config_dir": str(nested_alias)}}
    with pytest.raises(ValueError, match="overlapping_account_dirs"):
        cc.build_account_graph(accounts, "work", ["personal"])


def test_apply_refuses_operation_whose_path_is_not_in_the_graph(tmp_path: Path):
    # apply 必須驗每個 op 確實屬於 graph：op.target_path 不等於
    # join(plan.targets[account], entry) 時，_apply_one 會照著 op 給的路徑動手，
    # 等於在未登記的目錄裡改名／建連結。授權與否都不得放行。
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "commands").mkdir()
    (outside / "commands" / "PRECIOUS.md").write_text("不該被碰", encoding="utf-8")
    rogue = cc.Operation("personal", "commands", str(outside / "commands"),
                         "real_dir", "backup_and_link", True)
    p = _manual_plan(src, tgt, [rogue])
    for overwrite in ([], [("personal", "commands")]):
        r = cc.apply(p, overwrite=overwrite).results[0]
        assert r.outcome == "failed"
        assert r.error == "operation_not_in_graph"
        assert (outside / "commands" / "PRECIOUS.md").read_text(encoding="utf-8") == "不該被碰"
        assert not (outside / "commands").is_symlink()


def test_backup_survives_repeated_collisions_in_one_second(tmp_path: Path):
    # 撞名迴圈要能處理任意次數，不是只處理第一次（只測兩次的話 `if lexists: -1`
    # 這種寫死一層的 mutant 也會過）
    victim = tmp_path / "commands"
    backups = []
    for payload in ("first", "second", "third", "fourth"):
        victim.write_text(payload, encoding="utf-8")
        backups.append(cc._backup(str(victim)))
    assert len(set(backups)) == 4
    assert [Path(b).read_text(encoding="utf-8") for b in backups] == [
        "first", "second", "third", "fourth"]


def test_apply_reports_stable_error_codes_not_raw_os_messages(tmp_path: Path, monkeypatch):
    # OpResult.error 是前端合約的一部分（route 以 asdict 原封轉出）。str(OSError) 會夾帶
    # errno 文字與絕對路徑，前端 i18n 映不到（CLAUDE.md §4.6.13）——一律回穩定判別碼。
    import errno as errno_mod

    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()

    def _denied(source, target, **kw):
        raise PermissionError(errno_mod.EACCES, "Permission denied")

    monkeypatch.setattr(cc.os, "symlink", _denied)
    g = _graph(src, tgt)
    r = cc.apply(cc.plan(g, ["commands"]), overwrite=[]).results[0]
    assert r.outcome == "failed"
    assert r.error == "permission_denied"
    assert "/" not in (r.error or ""), "判別碼不得夾帶路徑"


def test_apply_logs_destructive_outcomes(tmp_path: Path, caplog):
    # 破壞性操作要留伺服端稽核紀錄：使用者事後找不到 .fledge-backup-* 時，log 是唯一線索
    src, tgt = _dirs(tmp_path)
    (Path(src) / "commands").mkdir()
    (Path(tgt) / "commands").mkdir()
    (Path(tgt) / "commands" / "mine.md").write_text("MINE", encoding="utf-8")
    g = _graph(src, tgt)
    with caplog.at_level("INFO", logger=cc.__name__):
        cc.apply(cc.plan(g, ["commands"]), overwrite=[])          # → conflict
    assert any(r.levelname == "INFO" for r in caplog.records)
    assert any(r.levelname == "WARNING" and "conflict" in r.getMessage() for r in caplog.records)


# ── repair（票 08：移機／還原後的斷鏈修復）──────────────────────────────
# 修復會刪除並重建 symlink，是破壞性操作。本組測試全程只用假 HOME 與 tmp 目錄：
# 真實的 ~/.claude、~/.claude-tc 不出現在任何一條路徑上，連「舊機器路徑」都造在
# tmp_path 內（刻意不建立）。這個 repo 有過驗收腳本 rm -rf 掉使用者目錄的前科。


def _restored_home(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    """還原後的現場：HOME 指到 tmp_path 內的假 home，兩個帳號目錄都在其中。"""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    src = home / ".claude"
    src.mkdir()
    tgt = home / ".claude-tc"
    tgt.mkdir()
    return src, tgt


def _old_machine(tmp_path: Path, entry: str) -> Path:
    """舊機器上的絕對路徑（如 /Users/<舊使用者>/.claude/skills）。本機不存在——
    刻意不建立，連過去就是備份包帶回來的那種斷鏈。"""
    return tmp_path / "old-home" / ".claude" / entry


def test_repair_relinks_broken_links_to_this_machine(tmp_path: Path, monkeypatch):
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "skills").mkdir()
    (src / "skills" / "a.md").write_text("real skill", encoding="utf-8")
    (tgt / "skills").symlink_to(_old_machine(tmp_path, "skills"))

    g = _graph(str(src), str(tgt))
    p = cc.plan(g, ["skills"])
    assert [op.state for op in p.operations] == ["broken_link"]

    res = cc.repair(p)

    assert [(r.account, r.entry, r.outcome) for r in res.results] == [
        ("personal", "skills", "relinked")]
    # 指向本機 source 帳號的字面路徑，而不是把舊指向抄過來
    assert os.readlink(tgt / "skills") == str(src.resolve() / "skills")
    assert (tgt / "skills" / "a.md").read_text(encoding="utf-8") == "real skill"  # 真的讀得到


def test_repair_does_not_rewrite_a_deliberate_alternate_link(tmp_path: Path, monkeypatch):
    # wrong_link 只代表「沒指向目前的 source entry」，分不出「備份帶回的舊機連結」與
    # 「使用者刻意指到別處、目前仍然有效的設置」。relink 不需 overwrite 授權，收進 repair
    # 就等於免授權改寫後者——那類連結交給共通設置卡（看得到逐項狀態才按套用＝人工授權）。
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    (src / "commands" / "a.md").write_text("source copy", encoding="utf-8")
    mine = tmp_path / "dotfiles" / "commands"
    mine.mkdir(parents=True)
    (mine / "a.md").write_text("MY OWN", encoding="utf-8")
    (tgt / "commands").symlink_to(mine)

    g = _graph(str(src), str(tgt))
    p = cc.plan(g, ["commands"])
    assert [op.state for op in p.operations] == ["wrong_link"]
    before = os.lstat(tgt / "commands").st_ino

    res = cc.repair(p)

    assert res.results[0].outcome == "skipped"
    assert os.readlink(tgt / "commands") == str(mine)        # 指向原封不動
    assert os.lstat(tgt / "commands").st_ino == before
    assert (tgt / "commands" / "a.md").read_text(encoding="utf-8") == "MY OWN"
    assert not list(tgt.glob("*.fledge-backup-*"))


def test_repair_does_not_rebuild_links_that_are_already_correct(tmp_path: Path, monkeypatch):
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "skills").mkdir()
    (tgt / "skills").symlink_to(src.resolve() / "skills")

    g = _graph(str(src), str(tgt))
    p = cc.plan(g, ["skills"])
    assert [op.state for op in p.operations] == ["ok"]
    before = os.lstat(tgt / "skills").st_ino    # 重建過的 symlink 會換 inode

    res = cc.repair(p)

    assert res.results[0].outcome == "skipped"
    assert os.lstat(tgt / "skills").st_ino == before
    assert not list(tgt.glob("*.fledge-backup-*"))   # 連隔離改名都沒發生過


def test_repair_leaves_broken_links_outside_the_allowlist_untouched(tmp_path: Path, monkeypatch):
    # 不在共通設置清單內的斷鏈可能是使用者自建的，我們沒有立場替他決定該指去哪
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "skills").mkdir()
    (tgt / "skills").symlink_to(_old_machine(tmp_path, "skills"))
    mine = tgt / "my-notes"
    mine.symlink_to(_old_machine(tmp_path, "my-notes"))
    mine_before = os.readlink(mine)

    res = cc.repair(cc.plan(_graph(str(src), str(tgt)), ["skills"]))

    assert [(r.entry, r.outcome) for r in res.results] == [("skills", "relinked")]
    assert mine.is_symlink()
    assert os.readlink(mine) == mine_before      # 連結本身原封不動
    assert not mine.exists()                     # 仍是斷鏈——沒有被「順手修好」
    assert not list(tgt.glob("*.fledge-backup-*"))


def test_repair_refuses_when_source_account_dir_is_gone(tmp_path: Path, monkeypatch):
    # 還原了 target 卻沒還原 source（或還原到別的位置）時，逐項回「source_missing 已跳過」
    # 只是把同一個原因講六遍。前提不成立就整批停手，一個乾淨的判別碼。
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "skills").mkdir()
    (tgt / "skills").symlink_to(_old_machine(tmp_path, "skills"))
    p = cc.plan(_graph(str(src), str(tgt)), ["skills"])
    assert [op.state for op in p.operations] == ["broken_link"]

    (src / "skills").rmdir()
    src.rmdir()

    with pytest.raises(ValueError, match="source_dir_missing"):
        cc.repair(p)
    # 沒有拿不存在的 source 去重建連結——那只會把斷鏈換成另一條斷鏈
    assert os.readlink(tgt / "skills") == str(_old_machine(tmp_path, "skills"))
    assert not list(tgt.glob("*.fledge-backup-*"))


def test_repair_refuses_when_source_dir_is_not_a_usable_directory(tmp_path: Path, monkeypatch):
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "skills").mkdir()
    (tgt / "skills").symlink_to(_old_machine(tmp_path, "skills"))
    p = cc.plan(_graph(str(src), str(tgt)), ["skills"])

    # (a) 位置被實體檔占住：join 出來的 source entry 永遠不會存在
    (src / "skills").rmdir()
    src.rmdir()
    src.write_text("not a dir", encoding="utf-8")
    with pytest.raises(ValueError, match="source_dir_unusable"):
        cc.repair(p)

    # (b) 被換成指向別處的 symlink：isdir 仍為真，但已不是 plan 驗過的那個目錄。
    #     放行等於把 target 的連結指進一個沒經過 build_account_graph 的目錄。
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "skills").mkdir(parents=True)
    src.unlink()
    src.symlink_to(elsewhere)
    with pytest.raises(ValueError, match="source_dir_unusable"):
        cc.repair(p)

    assert os.readlink(tgt / "skills") == str(_old_machine(tmp_path, "skills"))


def test_repair_reports_every_entry_and_only_touches_broken_ones(tmp_path: Path, monkeypatch):
    src, tgt = _restored_home(tmp_path, monkeypatch)
    second = src.parent / ".claude-work"
    second.mkdir()
    for name in ("commands", "plugins", "skills", "projects"):
        (src / name).mkdir()
    (src / "settings.json").write_text("{}", encoding="utf-8")
    (src / "CLAUDE.md").write_text("source rules", encoding="utf-8")

    (tgt / "commands").symlink_to(_old_machine(tmp_path, "commands"))   # broken_link
    (tgt / "plugins").mkdir()                                          # real_dir
    (tgt / "plugins" / "mine.md").write_text("MINE", encoding="utf-8")
    # skills 不存在 → missing
    (tgt / "settings.json").symlink_to(src.resolve() / "settings.json")  # ok
    (tgt / "CLAUDE.md").write_text("target rules", encoding="utf-8")     # content_differs
    (tgt / "projects").symlink_to(_old_machine(tmp_path, "projects"))    # broken_link
    (second / "commands").symlink_to(_old_machine(tmp_path, "commands"))

    accounts = {
        "work": {"config_dir": str(src)},
        "personal": {"config_dir": str(tgt)},
        "extra": {"config_dir": str(second)},
    }
    g = cc.build_account_graph(accounts, "work", ["personal", "extra"])
    p = cc.plan(g, [s.name for s in cc.ENTRY_SPECS])

    res = cc.repair(p)

    assert [(r.account, r.entry, r.outcome) for r in res.results] == [
        ("personal", "commands", "relinked"),
        ("personal", "plugins", "skipped"),
        ("personal", "skills", "skipped"),
        ("personal", "settings.json", "skipped"),
        ("personal", "CLAUDE.md", "skipped"),
        ("personal", "projects", "relinked"),   # 進階項也在 allowlist 內，同樣修得回來
        ("extra", "commands", "relinked"),      # 失敗與否逐帳號獨立，兩個 target 都處理
        ("extra", "plugins", "skipped"),
        ("extra", "skills", "skipped"),
        ("extra", "settings.json", "skipped"),
        ("extra", "CLAUDE.md", "skipped"),
        ("extra", "projects", "skipped"),
    ]
    # 沒被修的每一項都必須原封不動：repair 不做「備份後覆蓋」那類需要授權的動作
    assert (tgt / "plugins" / "mine.md").read_text(encoding="utf-8") == "MINE"
    assert not (tgt / "plugins").is_symlink()
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "target rules"
    assert not (tgt / "skills").exists() and not (tgt / "skills").is_symlink()
    for d in (tgt, second):
        assert not list(d.glob("*.fledge-backup-*"))


def test_repair_continues_after_one_entry_fails(tmp_path: Path, monkeypatch):
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    (src / "skills").mkdir()
    (tgt / "commands").symlink_to(_old_machine(tmp_path, "commands"))
    (tgt / "skills").symlink_to(_old_machine(tmp_path, "skills"))
    p = cc.plan(_graph(str(src), str(tgt)), ["commands", "skills"])

    real_symlink = cc.os.symlink

    def _fail_first(source, target, **kw):
        if target.endswith("commands"):
            raise PermissionError(13, "Permission denied")
        return real_symlink(source, target, **kw)

    monkeypatch.setattr(cc.os, "symlink", _fail_first)
    res = cc.repair(p)

    by_entry = {r.entry: r for r in res.results}
    assert by_entry["commands"].outcome == "failed"
    assert by_entry["commands"].error == "permission_denied"   # 穩定判別碼，不是 OSError 原文
    assert by_entry["skills"].outcome == "relinked"            # 一項失敗不影響其餘
    assert os.readlink(tgt / "skills") == str(src.resolve() / "skills")


def test_repair_does_not_relink_when_state_changed_after_plan(tmp_path: Path, monkeypatch):
    # TOCTOU：plan→repair 之間斷鏈位置被換成實體檔。relink 不需 overwrite 授權，
    # 誤刪就是無授權的資料破壞——重探測不符一律停手。
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    (tgt / "commands").symlink_to(_old_machine(tmp_path, "commands"))
    p = cc.plan(_graph(str(src), str(tgt)), ["commands"])
    assert p.operations[0].state == "broken_link"

    (tgt / "commands").unlink()
    (tgt / "commands").write_text("appeared after plan", encoding="utf-8")

    res = cc.repair(p)

    assert res.results[0].outcome == "stale"
    assert (tgt / "commands").read_text(encoding="utf-8") == "appeared after plan"


def test_repair_refuses_operation_whose_path_is_not_in_the_graph(tmp_path: Path, monkeypatch):
    # repair 是 C 直接呼叫的入口，op-in-graph 檢查必須在這條路徑上也成立
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "commands").symlink_to(_old_machine(tmp_path, "commands"))
    rogue = cc.Operation("personal", "commands", str(outside / "commands"),
                         "broken_link", "relink", False)
    p = _manual_plan(src, tgt, [rogue])

    r = cc.repair(p).results[0]

    assert r.outcome == "failed"
    assert r.error == "operation_not_in_graph"
    assert os.readlink(outside / "commands") == str(_old_machine(tmp_path, "commands"))


def test_repair_refuses_when_source_dir_cannot_be_read(tmp_path: Path, monkeypatch):
    # 防呆不得 fail-open：探測不出 source 的內容時一律不動，而不是照著 plan 動手
    src, tgt = _restored_home(tmp_path, monkeypatch)
    (src / "skills").mkdir()
    (tgt / "skills").symlink_to(_old_machine(tmp_path, "skills"))
    p = cc.plan(_graph(str(src), str(tgt)), ["skills"])

    src.chmod(0o000)
    try:
        with pytest.raises(ValueError, match="source_dir_unusable"):
            cc.repair(p)
    finally:
        src.chmod(0o700)          # 還原，否則 tmp_path 清不掉
    assert os.readlink(tgt / "skills") == str(_old_machine(tmp_path, "skills"))

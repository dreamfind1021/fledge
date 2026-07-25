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

from pathlib import Path

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

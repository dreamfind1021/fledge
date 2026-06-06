from pathlib import Path

from fledge_sidecar.app_config import AppConfig, DEFAULT_CONFIG


def test_load_missing_returns_default(tmp_path: Path):
    cfg_path = tmp_path / "config.json"
    cfg = AppConfig.load(cfg_path)
    assert cfg.roots == []
    assert cfg.accounts == DEFAULT_CONFIG["accounts"]


def test_save_then_load_roundtrip(tmp_path: Path):
    cfg_path = tmp_path / "config.json"
    work = tmp_path / "work"
    work.mkdir()
    cfg = AppConfig.load(cfg_path)
    cfg.add_root(str(work), "work")
    cfg.save()

    reloaded = AppConfig.load(cfg_path)
    assert len(reloaded.roots) == 1
    assert reloaded.roots[0]["path"] == str(work.resolve())
    assert reloaded.roots[0]["default_account"] == "work"


def test_save_creates_parent_dir(tmp_path: Path):
    cfg_path = tmp_path / "nested" / "dir" / "config.json"
    cfg = AppConfig.load(cfg_path)
    cfg.save()
    assert cfg_path.exists()


def _cfg(tmp_path: Path) -> AppConfig:
    return AppConfig(path=tmp_path / "config.json")


def test_remove_root(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.roots = [{"path": "/a", "default_account": "work"}]
    cfg.remove_root("/a")
    assert cfg.roots == []


def test_set_root_account(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.roots = [{"path": "/a", "default_account": "work"}]
    cfg.set_root_account("/a", "personal")
    assert cfg.roots[0]["default_account"] == "personal"


def test_add_and_remove_manual(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.add_manual("/m", "work")
    assert cfg.manual_projects == [{"path": "/m", "account": "work"}]
    cfg.remove_manual("/m")
    assert cfg.manual_projects == []


def test_set_and_clear_override(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.set_override("/p", "personal")
    assert cfg.project_overrides["/p"] == {"account": "personal"}
    cfg.clear_override("/p")
    assert "/p" not in cfg.project_overrides


def test_save_is_atomic_no_tmp_left(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.add_root("/a", "work")
    cfg.save()
    assert (tmp_path / "config.json").exists()
    assert not (tmp_path / "config.json.tmp").exists()
    reloaded = AppConfig.load(tmp_path / "config.json")
    assert reloaded.roots == [{"path": "/a", "default_account": "work"}]


def test_add_account(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.add_account("team", "~/.claude-team", "團隊")
    assert cfg.accounts["team"] == {"config_dir": "~/.claude-team", "label": "團隊"}


def test_set_account_config_dir_and_label(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.accounts = {"work": {"config_dir": "~/.claude", "label": "工作"}}
    cfg.set_account_config_dir("work", "~/.claude-new")
    cfg.set_account_label("work", "上班")
    assert cfg.accounts["work"] == {"config_dir": "~/.claude-new", "label": "上班"}


def test_account_references(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.roots = [{"path": "/a", "default_account": "work"}, {"path": "/b", "default_account": "personal"}]
    cfg.manual_projects = [{"path": "/m", "account": "work"}]
    cfg.project_overrides = {"/p": {"account": "work"}}
    refs = cfg.account_references("work")
    assert refs == {"roots": ["/a"], "manual": ["/m"], "overrides": ["/p"]}


def test_remove_account_with_reassign(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.accounts = {"work": {"config_dir": "~/.claude", "label": "工作"},
                    "personal": {"config_dir": "~/.claude-tc", "label": "私人"}}
    cfg.roots = [{"path": "/a", "default_account": "personal"}]
    cfg.manual_projects = [{"path": "/m", "account": "personal"}]
    cfg.project_overrides = {"/p": {"account": "personal"}}
    cfg.remove_account("personal", reassign_to="work")
    assert "personal" not in cfg.accounts
    assert cfg.roots[0]["default_account"] == "work"
    assert cfg.manual_projects[0]["account"] == "work"
    assert cfg.project_overrides["/p"]["account"] == "work"


def test_remove_account_no_refs_no_reassign(tmp_path: Path):
    cfg = _cfg(tmp_path)
    cfg.accounts = {"work": {"config_dir": "~/.claude", "label": "工作"},
                    "team": {"config_dir": "~/.claude-team", "label": "團隊"}}
    cfg.remove_account("team")
    assert "team" not in cfg.accounts
    assert "work" in cfg.accounts


def test_load_migrates_symlink_root_to_real_path(tmp_path: Path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    cfg_path = tmp_path / "config.json"
    cfg = AppConfig.load(cfg_path)
    cfg.roots = [{"path": str(link), "default_account": "work"}]
    cfg.save()

    reloaded = AppConfig.load(cfg_path)
    assert reloaded.roots[0]["path"] == str(real.resolve())


def test_load_dedups_symlink_alias_roots(tmp_path: Path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    cfg_path = tmp_path / "config.json"
    cfg = AppConfig.load(cfg_path)
    cfg.roots = [
        {"path": str(real), "default_account": "work"},
        {"path": str(link), "default_account": "personal"},
    ]
    cfg.save()

    reloaded = AppConfig.load(cfg_path)
    assert len(reloaded.roots) == 1
    assert reloaded.roots[0]["path"] == str(real.resolve())
    assert reloaded.roots[0]["default_account"] == "work"


def test_load_keeps_relative_path_unchanged(tmp_path: Path):
    # 保護既有行為：非絕對路徑應直接保留（不誤 resolve 成 cwd-relative），修前修後都應 PASS
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(
        '{"version":1,"roots":[{"path":"relative/x","default_account":"work"}],'
        '"accounts":{},"manual_projects":[],"project_overrides":{},"ui":{}}',
        encoding="utf-8",
    )
    reloaded = AppConfig.load(cfg_path)
    assert reloaded.roots[0]["path"] == "relative/x"


def test_load_migrates_override_key(tmp_path: Path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    cfg_path = tmp_path / "config.json"
    cfg = AppConfig.load(cfg_path)
    cfg.project_overrides = {str(link): {"account": "personal"}}
    cfg.save()

    reloaded = AppConfig.load(cfg_path)
    assert str(real.resolve()) in reloaded.project_overrides
    assert reloaded.project_overrides[str(real.resolve())] == {"account": "personal"}  # value 不丟失

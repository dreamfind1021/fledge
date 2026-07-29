import json
from pathlib import Path

from fledge_sidecar.app_config import AppConfig, DEFAULT_CONFIG


def test_load_missing_returns_default(tmp_path: Path):
    cfg_path = tmp_path / "config.json"
    cfg = AppConfig.load(cfg_path)
    assert cfg.roots == []
    assert cfg.accounts == DEFAULT_CONFIG["accounts"]


def test_default_config_is_single_account(tmp_path: Path):
    """新使用者預設只有一個帳號（票 31）——雙帳號是進階用法，不預設塞給每個人：
    多出來的第二個帳號會讓精靈白跑一頁共通設置、觀測面板多一個永遠沒資料的帳號。

    期望值**寫死**而不是比對 `DEFAULT_CONFIG`——後者是同義反覆，改了預設值也永遠綠。
    `label` 空字串是刻意的：UI 缺 label 時退回顯示 key（`sidebarGroups`），於是後端
    不必輸出任何 user-facing 文案（CLAUDE.md §4.6.13），顯示名交給使用者自己設。"""
    cfg = AppConfig.load(tmp_path / "config.json")
    assert cfg.accounts == {"default": {"config_dir": "~/.claude", "label": ""}}


def test_existing_config_keeps_its_own_accounts(tmp_path: Path):
    """票 31 的成立前提：改預設**不能動到既有使用者**。有 `accounts` 欄位的設定檔一律原樣載入，
    即使它用的是已經不再是預設的 work/personal。"""
    cfg_path = tmp_path / "config.json"
    legacy = {
        "work": {"config_dir": "~/.claude", "label": "工作"},
        "personal": {"config_dir": "~/.claude-tc", "label": "私人"},
    }
    cfg_path.write_text(
        json.dumps({"version": 1, "roots": [], "accounts": legacy}), encoding="utf-8"
    )
    assert AppConfig.load(cfg_path).accounts == legacy


def test_existing_config_without_accounts_field_gets_default(tmp_path: Path):
    """設定檔存在卻缺 `accounts`：會拿到當前預設，而不是舊的 work/personal。

    這是 `load()` 唯一一處「檔案存在也會碰到 DEFAULT_CONFIG」的路徑（Codex 票 31 R1 Medium）。
    Fledge 自己寫不出這種檔案（`to_dict()` 固定輸出 accounts），只可能來自手動編輯——本就是
    損壞狀態，給它舊預設同樣只是另一種猜測，故**刻意不為它保留 legacy fallback**。
    這條測試是要讓這個取捨被看見：哪天有人想改成別的行為，會先撞到這裡。"""
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({"version": 1, "roots": []}), encoding="utf-8")
    assert AppConfig.load(cfg_path).accounts == {"default": {"config_dir": "~/.claude", "label": ""}}


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


# ── 畸形元素的容錯（Codex PR-gate R3）──
# load() 的自我遷移原本對每個 root/manual 直接 r.get()／{**r}，元素若不是 dict 就 AttributeError／
# TypeError——**一筆**壞資料讓整個 GET /api/config 回 500，連同一份 config 裡合法的項目一起失效。
# scan_all 的逐項跳過因此形同虛設：請求根本到不了那裡。


def _write(tmp_path, payload: dict) -> Path:
    p = tmp_path / "config.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    return p


def test_load_skips_non_dict_root_but_keeps_valid_ones(tmp_path: Path):
    p = _write(tmp_path, {"roots": [None, {"path": "/tmp/ok", "default_account": "work"}]})
    cfg = AppConfig.load(p)
    assert [r["default_account"] for r in cfg.roots] == ["work"]


def test_load_skips_root_with_non_string_path(tmp_path: Path):
    p = _write(tmp_path, {"roots": [{"path": {"a": 1}, "default_account": "work"}]})
    cfg = AppConfig.load(p)
    assert cfg.roots == []


def test_load_skips_non_dict_manual_but_keeps_valid_ones(tmp_path: Path):
    p = _write(tmp_path, {"manual_projects": [["bad"], {"path": "/tmp/m", "account": "work"}]})
    cfg = AppConfig.load(p)
    assert [m["account"] for m in cfg.manual_projects] == ["work"]


def test_load_skips_non_dict_override(tmp_path: Path):
    p = _write(tmp_path, {"project_overrides": {"/a": "not-a-dict", "/b": {"account": "work"}}})
    cfg = AppConfig.load(p)
    assert [v["account"] for v in cfg.project_overrides.values()] == ["work"]

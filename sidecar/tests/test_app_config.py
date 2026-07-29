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


def test_load_keeps_malformed_root_without_breaking_valid_ones(tmp_path: Path):
    """畸形元素原樣保留（不丟棄，見 round-trip 測試），合法元素照常 canonicalize。"""
    p = _write(tmp_path, {"roots": [None, {"path": "/tmp/ok", "default_account": "work"}]})
    cfg = AppConfig.load(p)
    assert None in cfg.roots
    assert [r["default_account"] for r in cfg.roots if isinstance(r, dict)] == ["work"]


def test_load_keeps_root_with_non_string_path_uncanonicalized(tmp_path: Path):
    """truthy 但非字串的 path 不得進 _migrate_path（Path() 會拋 TypeError），原值保留。"""
    p = _write(tmp_path, {"roots": [{"path": {"a": 1}, "default_account": "work"}]})
    cfg = AppConfig.load(p)
    assert cfg.roots == [{"path": {"a": 1}, "default_account": "work"}]


def test_load_keeps_malformed_manual_without_breaking_valid_ones(tmp_path: Path):
    p = _write(tmp_path, {"manual_projects": [["bad"], {"path": "/tmp/m", "account": "work"}]})
    cfg = AppConfig.load(p)
    assert ["bad"] in cfg.manual_projects
    assert [m["account"] for m in cfg.manual_projects if isinstance(m, dict)] == ["work"]


def test_load_keeps_malformed_override_without_breaking_valid_ones(tmp_path: Path):
    p = _write(tmp_path, {"project_overrides": {"/a": "not-a-dict", "/b": {"account": "work"}}})
    cfg = AppConfig.load(p)
    assert cfg.project_overrides["/a"] == "not-a-dict"
    assert any(isinstance(v, dict) and v.get("account") == "work" for v in cfg.project_overrides.values())


def test_load_save_roundtrip_preserves_malformed_entries(tmp_path: Path):
    """畸形元素必須原樣保留、能 round-trip。

    所有 config 寫入端點都是 load() → 改一個欄位 → save()，而 save() 以 to_dict() 整份覆蓋。
    若 load() 把畸形元素丟掉，使用者只是改個 label 或訂閱費，那些資料就**永久消失**且無備份——
    改動前它們雖然會讓 API 回 500，但檔案裡還在、還救得回來。不可逆的資料遺失比讀取失敗更嚴重。"""
    payload = {
        "roots": [None, {"path": "/tmp/ok", "default_account": "work"}],
        "manual_projects": [{"path": {"bad": 1}, "account": "work"}],
        "project_overrides": {"/a": "not-a-dict"},
    }
    p = _write(tmp_path, payload)
    cfg = AppConfig.load(p)
    cfg.kms_root = "/somewhere"  # 模擬「與那些元素無關的一次寫入」
    cfg.save()

    after = json.loads(p.read_text(encoding="utf-8"))
    assert None in after["roots"]
    assert {"path": {"bad": 1}, "account": "work"} in after["manual_projects"]
    assert after["project_overrides"]["/a"] == "not-a-dict"


def test_load_malformed_entry_does_not_crowd_out_valid_duplicate(tmp_path: Path):
    """畸形項目不得佔用去重鍵。

    缺 default_account 但 path 合法的項目若先進 seen_roots，後面同路徑的**合法**項目會被
    去重丟掉；scanner 又會跳過留下的畸形項目——結果是合法專案整個消失，而且無聲無息。"""
    p = _write(tmp_path, {
        "roots": [
            {"path": "/tmp/dup"},                              # 畸形（缺 default_account）
            {"path": "/tmp/dup", "default_account": "work"},   # 合法，同路徑
        ],
    })
    cfg = AppConfig.load(p)
    assert any(r.get("default_account") == "work" for r in cfg.roots), "合法項目不該被畸形項目擠掉"


def test_backup_dir_absent_from_existing_config(tmp_path: Path):
    """既有的 config.json 沒有這個欄位——載入後要是空字串，不是 KeyError。
    這是「新增欄位不得弄壞既有使用者」的最低門檻。"""
    p = _write(tmp_path, {})
    assert AppConfig.load(p).backup_dir == ""


def test_backup_dir_roundtrip_preserves_tilde(tmp_path: Path):
    """存 raw（含 ~），不在寫入時展開——與 kms_root 同構，展開留到 runtime。
    順帶驗證前後空白被 trim（使用者貼路徑時很容易帶到）。"""
    p = _write(tmp_path, {})
    cfg = AppConfig.load(p)
    cfg.set_backup_dir("  ~/backups  ")
    cfg.save()
    assert AppConfig.load(p).backup_dir == "~/backups"


def test_backup_dir_empty_string_clears(tmp_path: Path):
    p = _write(tmp_path, {})
    cfg = AppConfig.load(p)
    cfg.set_backup_dir("~/backups")
    cfg.set_backup_dir("")
    cfg.save()
    assert AppConfig.load(p).backup_dir == ""

from pathlib import Path

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.backup.containment import (
    EXTRA_PATHS_FILENAME,
    check_backup_dir,
    extra_paths_file,
    load_extra_paths,
    source_roots,
)
from fledge_sidecar.backup.script import scripts_root


def _write_extra(scripts_dir: Path, body: str) -> None:
    scripts_dir.mkdir(parents=True, exist_ok=True)
    (scripts_dir / EXTRA_PATHS_FILENAME).write_text(body, encoding="utf-8")


# ── 共用清單檔 ────────────────────────────────────────────────────────────────


def test_load_extra_paths_skips_comments_and_blanks(tmp_path: Path):
    _write_extra(tmp_path, "# 註解\n\n   \n/opt/one\n/opt/two\n")
    assert load_extra_paths(str(tmp_path)) == ["/opt/one", "/opt/two"]


def test_load_extra_paths_expands_tilde(tmp_path: Path):
    _write_extra(tmp_path, "~/agents\n")
    assert load_extra_paths(str(tmp_path)) == [str(Path.home() / "agents")]


def test_load_extra_paths_missing_file_returns_empty(tmp_path: Path):
    """讀不到一律回空清單而非報錯：少一個 root 只會讓防呆變寬鬆，不會造成錯誤的阻擋；
    報錯反而會讓整張卡片壞掉。`~/.agents` 不存在的機器是正常情況。"""
    assert load_extra_paths(str(tmp_path / "nope")) == []


def test_repo_extra_paths_file_is_readable():
    """真正的那份清單檔要讀得到——路徑算錯的話 containment 會靜默少一個 root。"""
    assert Path(extra_paths_file(scripts_root())).is_file()
    assert load_extra_paths(scripts_root()) != []


# ── 來源集合 ──────────────────────────────────────────────────────────────────


def test_source_roots_includes_accounts_and_extra(tmp_path: Path):
    _write_extra(tmp_path, "/opt/agents\n")
    cfg = AppConfig.load(tmp_path / "config.json")
    cfg.accounts = {"a": {"config_dir": "/srv/a"}, "b": {"config_dir": "/srv/b"}}
    assert set(source_roots(cfg, str(tmp_path))) == {"/srv/a", "/srv/b", "/opt/agents"}


def test_source_roots_expands_account_tilde(tmp_path: Path):
    _write_extra(tmp_path, "")
    cfg = AppConfig.load(tmp_path / "config.json")
    cfg.accounts = {"a": {"config_dir": "~/.claude"}}
    assert source_roots(cfg, str(tmp_path)) == [str(Path.home() / ".claude")]


def test_source_roots_tolerates_account_without_config_dir(tmp_path: Path):
    """畸形 config 的帳號元素可能缺欄位（app_config 刻意保留它們）——
    containment 不能因此整個炸掉。"""
    _write_extra(tmp_path, "")
    cfg = AppConfig.load(tmp_path / "config.json")
    cfg.accounts = {"a": {}}
    assert source_roots(cfg, str(tmp_path)) == [str(Path.home() / ".claude")]


# ── 判定 ──────────────────────────────────────────────────────────────────────


def test_ok_when_outside_every_source(tmp_path: Path):
    assert check_backup_dir(str(tmp_path / "out"), ["/srv/a"]) == "ok"


def test_inside_source_rejected(tmp_path: Path):
    src = tmp_path / "claude"
    (src / "projects" / "backups").mkdir(parents=True)
    assert check_backup_dir(str(src / "projects" / "backups"), [str(src)]) == "inside_source"


def test_equal_to_source_rejected(tmp_path: Path):
    src = tmp_path / "claude"
    src.mkdir()
    assert check_backup_dir(str(src), [str(src)]) == "inside_source"


def test_not_yet_existing_dir_inside_source_rejected(tmp_path: Path):
    """使用者可以在選擇器裡建新資料夾；目錄還不存在時仍要判得出巢狀關係
    （字串比對涵蓋這一段，inode 比對對不存在的路徑無效）。"""
    src = tmp_path / "claude"
    src.mkdir()
    assert check_backup_dir(str(src / "not-yet"), [str(src)]) == "inside_source"


def test_symlink_alias_rejected(tmp_path: Path):
    """指向來源的 symlink：字串完全不同，只有 inode 身分看得出來是同一個目錄。"""
    src = tmp_path / "claude"
    src.mkdir()
    link = tmp_path / "link-to-claude"
    link.symlink_to(src)
    assert check_backup_dir(str(link), [str(src)]) == "inside_source"


def test_symlinked_parent_rejected(tmp_path: Path):
    """祖先是 symlink 的情形：`link/sub` 的字串不落在 `src` 底下，要逐層上溯比 inode。"""
    src = tmp_path / "claude"
    (src / "sub").mkdir(parents=True)
    link = tmp_path / "link-to-claude"
    link.symlink_to(src)
    assert check_backup_dir(str(link / "sub"), [str(src)]) == "inside_source"


def test_case_alias_rejected_on_case_insensitive_fs(tmp_path: Path):
    """APFS 預設不分大小寫：`claude` 與 `CLAUDE` 是同一個目錄，但字串不等。
    在區分大小寫的檔案系統上這兩者本來就是不同目錄，該情境不適用。"""
    src = tmp_path / "claude"
    src.mkdir()
    alias = tmp_path / "CLAUDE"
    if not alias.exists():
        return  # 區分大小寫的 FS：沒有這個別名問題
    assert check_backup_dir(str(alias), [str(src)]) == "inside_source"


def test_sibling_with_shared_prefix_is_ok(tmp_path: Path):
    """`/a/claude-backups` 不算落在 `/a/claude` 底下——prefix 偽命中要擋掉。"""
    src = tmp_path / "claude"
    src.mkdir()
    sibling = tmp_path / "claude-backups"
    sibling.mkdir()
    assert check_backup_dir(str(sibling), [str(src)]) == "ok"


def test_home_itself_rejected():
    assert check_backup_dir(str(Path.home()), []) == "is_home"


def test_root_rejected():
    assert check_backup_dir("/", []) == "is_root"


def test_missing_source_does_not_block_everything(tmp_path: Path):
    """來源目錄不存在（例如帳號還沒建）時，不該把無關的位置一起判成 inside_source。"""
    assert check_backup_dir(str(tmp_path / "out"), [str(tmp_path / "never-created")]) == "ok"

import subprocess
from pathlib import Path

from fledge_sidecar.backup.containment import EXTRA_PATHS_FILENAME, extra_paths_file
from fledge_sidecar.backup.script import (
    SCRIPT_FILENAME,
    backup_script_path,
    build_argv,
    python3_available,
    script_available,
    scripts_root,
)


# ── 路徑解析 ──────────────────────────────────────────────────────────────────


def test_scripts_root_env_override(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(tmp_path))
    assert scripts_root() == str(tmp_path)


def test_scripts_root_defaults_to_repo_scripts_dir(monkeypatch):
    """dev（未凍結）時回 repo 的 scripts/，且那裡真的有腳本——路徑算錯會靜默地
    讓卡片永遠顯示「找不到腳本」。"""
    monkeypatch.delenv("FLEDGE_BACKUP_SCRIPTS_DIR", raising=False)
    assert Path(scripts_root(), SCRIPT_FILENAME).is_file()
    assert script_available() is True


def test_script_unavailable_when_missing(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(tmp_path))
    assert script_available() is False


def test_extra_paths_file_lives_next_to_script(monkeypatch):
    """腳本與共用來源清單檔必須同目錄。任一邊改去讀別的地方，「單一權威」就不成立
    ——打包後兩者同在 `_MEIPASS/scripts/` 也靠這個前提。"""
    monkeypatch.delenv("FLEDGE_BACKUP_SCRIPTS_DIR", raising=False)
    assert Path(extra_paths_file(scripts_root())).is_file()
    assert Path(backup_script_path()).parent == Path(extra_paths_file(scripts_root())).parent


# ── argv ──────────────────────────────────────────────────────────────────────


def test_build_argv_runs_via_bash_not_shebang(monkeypatch, tmp_path: Path):
    """顯式帶 /bin/bash：PyInstaller 的 datas 不保證保留執行位元，靠 shebang 會在
    打包版變成 EACCES。"""
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(tmp_path))
    argv = build_argv("/out/dir", "run")
    assert argv[0] == "/bin/bash"
    assert argv[1] == str(tmp_path / SCRIPT_FILENAME)


def test_build_argv_passes_path_as_single_element(monkeypatch, tmp_path: Path):
    """路徑含空白時仍是「一個」argv 元素——不經 shell，所以沒有 quoting 面。"""
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(tmp_path))
    argv = build_argv("/Volumes/My Backups/claude", "run")
    assert "/Volumes/My Backups/claude" in argv


def test_build_argv_never_produces_shell_string(monkeypatch, tmp_path: Path):
    """安全不變式：argv 直傳、不經 `-lc`。任何一個元素都不該是拼好的 shell 命令。"""
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(tmp_path))
    argv = build_argv("/Volumes/It's Mine/backups", "run")
    assert "-lc" not in argv
    assert not any(" -o " in element for element in argv)


def test_build_argv_list_mode_adds_flag(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(tmp_path))
    assert build_argv("/out", "list")[-1] == "--list"
    assert "--list" not in build_argv("/out", "run")


# ── python3 探測 ──────────────────────────────────────────────────────────────


def test_python3_missing_when_which_misses():
    assert python3_available(which=lambda _n: None) is False


def test_python3_missing_when_which_hits_but_exec_raises():
    """macOS 未裝 Command Line Tools 時 /usr/bin/python3 是個 stub：which 命中、
    執行卻失敗。只看 which 會給出錯誤的綠燈。"""

    def _run(*_args, **_kwargs):
        raise OSError("stub")

    assert python3_available(which=lambda _n: "/usr/bin/python3", run=_run) is False


def test_python3_missing_when_exec_times_out():
    def _run(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="python3", timeout=2)

    assert python3_available(which=lambda _n: "/usr/bin/python3", run=_run) is False


def test_python3_missing_when_exit_code_nonzero():
    class _Proc:
        returncode = 1

    assert python3_available(which=lambda _n: "/usr/bin/python3", run=lambda *a, **k: _Proc()) is False


def test_python3_available_when_exec_succeeds():
    class _Proc:
        returncode = 0

    assert python3_available(which=lambda _n: "/usr/bin/python3", run=lambda *a, **k: _Proc()) is True


def test_python3_probe_is_bounded(monkeypatch):
    """探測要有 timeout：status route 每次都會探，不能讓它卡住整張卡片。"""
    seen: dict = {}

    def _run(argv, **kwargs):
        seen.update(kwargs)

        class _Proc:
            returncode = 0

        return _Proc()

    python3_available(which=lambda _n: "/usr/bin/python3", run=_run)
    assert seen.get("timeout") is not None


# ── 打包 ──────────────────────────────────────────────────────────────────────


def test_pyinstaller_spec_bundles_script_and_extra_paths():
    """漏收任一個都會讓打包版的備份卡永遠停用，而 dev 完全看不出來。"""
    spec = Path(__file__).resolve().parents[1] / "fledge-sidecar.spec"
    body = spec.read_text(encoding="utf-8")
    assert SCRIPT_FILENAME in body
    assert EXTRA_PATHS_FILENAME in body

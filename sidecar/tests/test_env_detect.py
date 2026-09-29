import shutil
import subprocess

import pytest

from fledge_sidecar.setup import env_detect as ed
from fledge_sidecar.setup.install_specs import ToolSpec

SPEC = ToolSpec("node", "Node.js", "core", "node", ["node", "--version"],
                "brew install node", "https://nodejs.org")
# 僅手動安裝（install_command=None）：官方指令放在 note，如 Homebrew 本體
MANUAL_SPEC = ToolSpec("homebrew", "Homebrew", "core", "brew", ["brew", "--version"],
                       None, "https://brew.sh", '/bin/bash -c "$(curl -fsSL install.sh)"')


def _fake_run_ok(argv, **kw):
    return subprocess.CompletedProcess(argv, 0, stdout="v25.8.2\n", stderr="")


def test_detect_installed_with_version():
    st = ed.detect_tool(SPEC, which=lambda b: "/opt/homebrew/bin/node", run=_fake_run_ok)
    assert st.installed is True
    assert st.path == "/opt/homebrew/bin/node"
    assert st.version == "v25.8.2"
    assert st.id == "node" and st.tier == "core"


def test_detect_probes_resolved_path_not_bare_name():
    # 版本探測要用 which 解析出的絕對路徑：裸名重查 PATH 可能命中另一個執行檔，
    # 回報「A 的 path、B 的 version」（Codex 審查 finding 4）
    seen: list[list[str]] = []
    def _run(argv, **kw):
        seen.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, stdout="v25.8.2\n", stderr="")
    ed.detect_tool(SPEC, which=lambda b: "/opt/homebrew/bin/node", run=_run)
    assert seen == [["/opt/homebrew/bin/node", "--version"]]


def test_detect_missing_skips_version_probe():
    called = False
    def _run(argv, **kw):
        nonlocal called
        called = True
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
    st = ed.detect_tool(SPEC, which=lambda b: None, run=_run)
    assert st.installed is False
    assert st.path is None and st.version is None
    assert called is False  # 未安裝不探版本（省時）


def test_detect_version_probe_failure_is_tolerated():
    def _run(argv, **kw):
        raise OSError("boom")
    st = ed.detect_tool(SPEC, which=lambda b: "/usr/bin/node", run=_run)
    assert st.installed is True
    assert st.version is None  # 探測失敗不拋、version=None


def test_detect_version_probe_timeout_is_tolerated():
    # 已安裝但 --version 卡住：TimeoutExpired（SubprocessError 子類）應被吞、version=None（plan review #2）
    def _run(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 2)
    st = ed.detect_tool(SPEC, which=lambda b: "/usr/bin/node", run=_run)
    assert st.installed is True and st.version is None


# 前端靠這三欄決定「顯示什麼」：未安裝時列 binary 名（version 為 None）、
# 有 install_command 才給一鍵安裝、只有 manual_command 時給「複製指令」。
# 命令字串一律由後端資料表提供，前端不得自帶（spec §5 allowlist 不變式）。
def test_status_carries_binary_and_install_command():
    st = ed.detect_tool(SPEC, which=lambda b: None, run=_fake_run_ok)
    assert st.binary == "node"
    assert st.install_command == "brew install node"
    assert st.manual_command is None  # 無 note → 不給「複製指令」


def test_manual_only_tool_reports_manual_command():
    st = ed.detect_tool(MANUAL_SPEC, which=lambda b: None, run=_fake_run_ok)
    assert st.install_command is None  # 不能一鍵安裝
    assert st.manual_command == '/bin/bash -c "$(curl -fsSL install.sh)"'


def test_detect_all_returns_one_status_per_spec():
    out = ed.detect_all(which=lambda b: None,
                        run=lambda *a, **k: subprocess.CompletedProcess(a, 0, "", ""))
    from fledge_sidecar.setup.install_specs import TOOL_SPECS
    assert len(out) == len(TOOL_SPECS)
    assert {s.id for s in out} == {s.id for s in TOOL_SPECS}


# --- git 身分（票 32）---
# 三態：有設／沒設／查不到。「查不到」（git 出錯、逾時）絕不能壓成「沒設」——
# 環境頁只對「沒設」顯示提醒，誤判成沒設會叫已經設好的人去覆寫自己的身分。
# 各情況的結束碼與輸出是 2026-09-29 用假家目錄實測 `git config --global --get` 得來。

GIT = "/opt/homebrew/bin/git"


def _git_run(returncode, stdout="", stderr=""):
    def _run(argv, **kw):
        return subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr=stderr)
    return _run


def test_git_identity_set_when_git_prints_a_value():
    gi = ed.detect_git_identity(GIT, run=_git_run(0, "dreamfind1021\n"))
    assert gi.name == "set" and gi.email == "set"


def test_git_identity_missing_when_key_absent():
    # 找不到這項設定：exit 1、完全沒有輸出
    gi = ed.detect_git_identity(GIT, run=_git_run(1))
    assert gi.name == "missing" and gi.email == "missing"


def test_git_identity_empty_value_counts_as_missing():
    # `name =` 設成空字串：exit 0、只印一個換行。commit 一樣拿不到名字，對使用者等於沒設
    gi = ed.detect_git_identity(GIT, run=_git_run(0, "\n"))
    assert gi.name == "missing" and gi.email == "missing"


def test_git_identity_unknown_when_config_file_is_broken():
    # 設定檔語法壞掉：exit 128 ＋ fatal 訊息——是「查不到」，不是「沒設」
    gi = ed.detect_git_identity(GIT, run=_git_run(128, stderr="fatal: bad config line 1\n"))
    assert gi.name == "unknown" and gi.email == "unknown"


def test_git_identity_unknown_when_exit_1_carries_an_error():
    # 「找不到」的 exit 1 完全沒有輸出；exit 1 卻帶錯誤訊息就是別的狀況，不能當成沒設
    gi = ed.detect_git_identity(GIT, run=_git_run(1, stderr="xcrun: error: invalid active developer path\n"))
    assert gi.name == "unknown" and gi.email == "unknown"


def test_git_identity_unknown_when_probe_raises():
    for exc in (OSError("boom"), subprocess.TimeoutExpired([GIT], 2)):
        def _run(argv, _exc=exc, **kw):
            raise _exc
        gi = ed.detect_git_identity(GIT, run=_run)
        assert gi.name == "unknown" and gi.email == "unknown"


def test_git_identity_unknown_without_git_and_skips_probe():
    called = False
    def _run(argv, **kw):
        nonlocal called
        called = True
        return subprocess.CompletedProcess(argv, 1, stdout="", stderr="")
    gi = ed.detect_git_identity(None, run=_run)
    assert gi.name == "unknown" and gi.email == "unknown"
    assert called is False  # git 沒裝就不查


def test_git_identity_reads_global_scope_with_resolved_path():
    # --global 讀 ~/.gitconfig 與 ~/.config/git/config，不受 sidecar 當下 cwd 所在 repo 的本地設定影響；
    # --includes 見下面的真 git 測試；用偵測到的絕對路徑，與版本探測同一支 git
    seen: list[list[str]] = []
    def _run(argv, **kw):
        seen.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, stdout="x\n", stderr="")
    ed.detect_git_identity(GIT, run=_run)
    assert seen == [[GIT, "config", "--global", "--includes", "--get", "user.name"],
                    [GIT, "config", "--global", "--includes", "--get", "user.email"]]


def test_git_identity_fields_are_probed_independently():
    # 名字有設、email 沒設：只有缺的那一項回 missing（環境頁只列缺的那行指令）
    def _run(argv, **kw):
        if argv[-1] == "user.name":
            return subprocess.CompletedProcess(argv, 0, stdout="x\n", stderr="")
        return subprocess.CompletedProcess(argv, 1, stdout="", stderr="")
    gi = ed.detect_git_identity(GIT, run=_run)
    assert gi.name == "set" and gi.email == "missing"


# 以上用假 run 的測試編碼的是「對 git 行為的假設」；以下用真的 git 在假家目錄對一次。
REAL_GIT = shutil.which("git")
needs_git = pytest.mark.skipif(REAL_GIT is None, reason="需要真的 git")


@pytest.fixture
def git_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    for key in ("XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"):
        monkeypatch.delenv(key, raising=False)
    return tmp_path


@needs_git
def test_real_git_identity_in_included_file_counts_as_set(git_home):
    # dotfiles 常見寫法：身分放在 include 進來的檔案。--global 預設不跟 include，
    # 沒加 --includes 會判成沒設，但 git commit 其實用得到這個身分（2026-09-29 實測）
    (git_home / ".gitconfig").write_text("[include]\n\tpath = ~/.gitconfig.local\n")
    (git_home / ".gitconfig.local").write_text("[user]\n\tname = Someone\n\temail = s@x.y\n")
    gi = ed.detect_git_identity(REAL_GIT)
    assert gi.name == "set" and gi.email == "set"


@needs_git
def test_real_git_exit_codes_match_the_assumptions(git_home):
    (git_home / ".gitconfig").write_text("")                         # 找不到
    assert ed.detect_git_identity(REAL_GIT) == ed.GitIdentity(name="missing", email="missing")
    (git_home / ".gitconfig").write_text("[user]\n\tname =\n")     # 設成空字串
    assert ed.detect_git_identity(REAL_GIT).name == "missing"
    (git_home / ".gitconfig").write_text("[user\n\tname = x\n")    # 設定檔壞掉
    assert ed.detect_git_identity(REAL_GIT) == ed.GitIdentity(name="unknown", email="unknown")


@needs_git
def test_real_git_non_utf8_name_counts_as_set(git_home):
    # 舊編碼存的名字（Latin-1 的 José）：git 照樣讀得出來。若把輸出解碼成文字，
    # UnicodeDecodeError 會穿出去讓整個 /api/setup/status 失敗、連工具清單都載不出來（Codex 審查 F1）
    (git_home / ".gitconfig").write_bytes(b"[user]\n\tname = Jos\xe9\n\temail = j@x.y\n")
    gi = ed.detect_git_identity(REAL_GIT)
    assert gi.name == "set" and gi.email == "set"

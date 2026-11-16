"""admin/verify_release.py：發版成品驗收（票 54）。

腳本在 sidecar 套件外，故以 importlib 由路徑載入（同 test_sync_pricing.py）。
不碰真的 .app、網路、/Applications、PyInstaller：只替換最底層——「執行外部指令拿回輸出文字」
（輸出照真實 codesign／vtool 的格式）與「打開 sidecar 拿到 PYZ 讀取物件」。抓 Authority／minos、
把 PYZ 的各種情況分成「不含」或「失敗」的程式都在正式程式裡、這裡照樣跑到（spec §6）。
git 用測試自己建的暫存 repo（真的 commit、打 tag）。
每條負對照從一組全部會過的基準只改一個地方，斷言「恰好預期的那幾行」失敗。
"""
import hashlib
import importlib.util
import json
import os
import plistlib
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("verify_release", _REPO / "admin" / "verify_release.py")
vr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vr)

MAIN = "Contents/MacOS/fledge"
SIDECAR = "Contents/Resources/fledge-sidecar/fledge-sidecar"
SCRIPTS = "Contents/Resources/fledge-sidecar/_internal/scripts"
NAMES = ("backup-claude.sh", "backup-extra-paths.txt", "restore-claude.sh", "expansion_guard.py")

# 基準情境一定要跑到、而且全過的每一行（順序即輸出順序）。少一行＝某一項檢查靜默不見了。
EXPECTED_LABELS = [
    "新版 Info.plist 版本＝1.0.0",
    "對照組不是 1.0.0",
    "codesign Authority 與對照組相同",
    "LSMinimumSystemVersion 與對照組相同",
    f"{MAIN} 的 minos 與對照組相同",
    f"{SIDECAR} 的 minos 與對照組相同",
    "成品的 scripts/backup-claude.sh 與 v1.0.0 相同",
    "成品的 scripts/backup-extra-paths.txt 與 v1.0.0 相同",
    "成品的 scripts/restore-claude.sh 與 v1.0.0 相同",
    "成品的 scripts/expansion_guard.py 與 v1.0.0 相同",
    "成品 scripts/ 沒有清單外的檔",
    "新版的 PYZ 讀得到內容（fledge_sidecar 含 __version__）",
    "對照組的 PYZ 讀得到內容（fledge_sidecar 含 __version__）",
    "指紋 fledge_sidecar.backup.bundles:.tar.xz",
    "指紋 fledge_sidecar:1.0.0",
    "checksums.txt 雜湊相符",
    "Fledge_1.0.0_aarch64.dmg 的雜湊驗過",
    "範本清單 {id: included} 與上一版相同",
]

# 真實 `codesign -dvv`（這幾行在 stderr）與 `vtool -show-build` 的格式，2026-11-17 取自本機 1.18.1。
CODESIGN_OUT = """Executable={app}/Contents/MacOS/fledge
Identifier=dev.fledge.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=54447 flags=0x10000(runtime) hashes=1695+3 location=embedded
Signature size=1640
{authority}Signed Time=Nov 11, 2026 at 10:59:06 PM
Info.plist entries=14
TeamIdentifier=not set
Runtime Version=26.5.0
Sealed Resources version=2 rules=13 files=119
Internal requirements count=1 size=92
"""
VTOOL_OUT = """{binary}:
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform MACOS
    minos {minos}
      sdk 26.5
   ntools 1
     tool LD
  version 1267.0
"""


def _git(repo, *args):
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
         "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
        check=True, capture_output=True,
    )


def _scripts_at(version_of_restore: str) -> dict:
    return {n: f"{n} {version_of_restore if n == 'restore-claude.sh' else 'v1'}\n".encode() for n in NAMES}


@pytest.fixture(scope="module")
def repo(tmp_path_factory):
    """tag 的內容：
    v1.0.0-rc.1 四支腳本＋build_binary.sh 四條宣告；
    v1.0.0-rc.2 ＝ v1.0.0：restore-claude.sh 改成 v2；
    v1.0.0-rc.3：build_binary.sh 拿掉 backup-claude.sh 那條宣告（腳本檔還在）；
    v1.0.0-rc.4：再 git rm scripts/expansion_guard.py。"""
    r = tmp_path_factory.mktemp("repo")
    _git(r, "init", "-q")
    (r / "scripts").mkdir()
    (r / "sidecar").mkdir()
    for n, b in _scripts_at("v1").items():
        (r / "scripts" / n).write_bytes(b)
    decl = [f'  --add-data "../scripts/{n}:scripts" \\\n' for n in NAMES]
    (r / "sidecar" / "build_binary.sh").write_text("pyinstaller \\\n" + "".join(decl) + "  x.py\n")
    _git(r, "add", "-A"); _git(r, "commit", "-qm", "a"); _git(r, "tag", "v1.0.0-rc.1")
    (r / "scripts" / "restore-claude.sh").write_bytes(_scripts_at("v2")["restore-claude.sh"])
    _git(r, "commit", "-qam", "b"); _git(r, "tag", "v1.0.0-rc.2"); _git(r, "tag", "v1.0.0")
    (r / "sidecar" / "build_binary.sh").write_text("pyinstaller \\\n" + "".join(decl[1:]) + "  x.py\n")
    _git(r, "commit", "-qam", "c"); _git(r, "tag", "v1.0.0-rc.3")
    _git(r, "rm", "-q", "scripts/expansion_guard.py"); _git(r, "commit", "-qm", "d"); _git(r, "tag", "v1.0.0-rc.4")
    return r


class FakePyz:
    """照 PyInstaller 6.22.3 ZlibArchiveReader.extract：目錄裡沒有 → KeyError；namespace package → None；
    讀的時候執行檔不見了 → SystemExit（不屬於 Exception）。errors 指定某個模組在 extract 時丟什麼。"""

    def __init__(self, modules):
        self.modules = modules
        self.errors = {}

    def extract(self, name, raw=False):
        assert raw is True, "要用 raw=True（只解壓、不 unmarshal）"
        if name in self.errors:
            raise self.errors[name]
        if name not in self.modules:
            raise KeyError(f"No entry named {name!r} found in the archive!")
        return self.modules[name]


class Env:
    def __init__(self, tmp: Path, repo: Path):
        self.repo = repo
        self.app = self._app(tmp / "new" / "Fledge.app", "1.0.0", _scripts_at("v2"))
        self.control = self._app(tmp / "old" / "Fledge.app", "0.9.0", _scripts_at("v1"))
        self.authority = {self.app: ["Fledge Self-Signed"], self.control: ["Fledge Self-Signed"]}
        self.minos = {os.path.join(a, rel): ["11.0"] for a in (self.app, self.control) for rel in (MAIN, SIDECAR)}
        self.shasum = None  # None＝跑真的 shasum
        self.calls = []  # 每次外部指令的程式名
        self.pyz = {
            os.path.join(self.app, SIDECAR): FakePyz({
                "fledge_sidecar": b'__version__ = "1.0.0"',
                "fledge_sidecar.backup.bundles": b'BUNDLE_SUFFIXES (".tar.xz", ".tar.gz")',
            }),
            os.path.join(self.control, SIDECAR): FakePyz({
                "fledge_sidecar": b'__version__ = "0.9.0"',
                "fledge_sidecar.backup.bundles": b'BUNDLE_SUFFIX ".tar.gz"',
            }),
        }
        self.release = tmp / "release"
        self.release.mkdir()
        self.write_release({"Fledge_aarch64.app.tar.gz": b"tarball", "Fledge_1.0.0_aarch64.dmg": b"dmg"})
        self.manifest = {"templates": [
            {"id": "project-starter", "source_class": "public", "included": True, "files": [], "dirs": []},
            {"id": "dev-methodology", "source_class": "private", "included": False, "files": [], "dirs": []},
        ]}
        self.prev_manifest = tmp / "prev-manifest.json"
        self.write_manifests(self.manifest, self.manifest)
        self.tag = "v1.0.0"
        self.fps = ["fledge_sidecar.backup.bundles:.tar.xz", "fledge_sidecar:1.0.0"]

    @staticmethod
    def _app(path: Path, version, scripts, lsmin="10.13") -> str:
        (path / "Contents" / "MacOS").mkdir(parents=True)
        d = path / SCRIPTS
        d.mkdir(parents=True)
        (path / MAIN).write_bytes(b"")
        (path / SIDECAR).write_bytes(b"")
        for n, b in scripts.items():
            (d / n).write_bytes(b)
        Env.set_plist(str(path), CFBundleShortVersionString=version, LSMinimumSystemVersion=lsmin)
        return str(path)

    @staticmethod
    def set_plist(app, **kv):
        p = Path(app) / "Contents" / "Info.plist"
        d = plistlib.loads(p.read_bytes()) if p.exists() else {}
        for k, v in kv.items():
            if v is None:
                d.pop(k, None)
            else:
                d[k] = v
        p.write_bytes(plistlib.dumps(d))

    def write_release(self, files):
        for f in self.release.iterdir():
            f.unlink()
        lines = []
        for n, b in files.items():
            (self.release / n).write_bytes(b)
            lines.append(f"{hashlib.sha256(b).hexdigest()}  {n}\n")
        (self.release / "checksums.txt").write_text("".join(lines))

    def write_manifests(self, new, old):
        (self.release / "templates-artifact-manifest.json").write_text(json.dumps(new))
        self.prev_manifest.write_text(json.dumps(old))

    def script(self, app, name) -> Path:
        return Path(app) / SCRIPTS / name

    def run(self, cmd, cwd=None):
        self.calls.append(cmd[0])
        if cmd[0] == "codesign":
            auth = "".join(f"Authority={a}\n" for a in self.authority.get(cmd[-1], []))
            return 0, CODESIGN_OUT.format(app=cmd[-1], authority=auth)
        if cmd[0] == "vtool":
            m = self.minos.get(cmd[-1], [])
            return 0, VTOOL_OUT.format(binary=cmd[-1], minos=m[0]) if m else f"{cmd[-1]}:\n"
        if cmd[0] == "shasum" and self.shasum is not None:
            return self.shasum
        return vr.run_cmd(cmd, cwd=cwd)

    def open_pyz(self, sidecar):
        v = self.pyz[sidecar]
        if isinstance(v, BaseException):
            raise v
        return v

    def argv(self):
        a = ["--app", self.app, "--tag", self.tag, "--control", self.control,
             "--release-dir", str(self.release), "--prev-manifest", str(self.prev_manifest)]
        for fp in self.fps:
            a += ["--fp", fp]
        return a

    def rows(self):
        try:
            return vr.verify(vr.parse_args(self.argv()), run=self.run, open_pyz=self.open_pyz, repo=self.repo)
        except (Exception, SystemExit) as exc:  # 中途丟出＝「個別出錯不中斷」壞了，轉成斷言比得到的結果
            return [(False, "中途丟出", repr(exc))]

    def failed(self) -> dict:
        return {label: detail for ok, label, detail in self.rows() if not ok}


@pytest.fixture
def env(tmp_path, repo):
    return Env(tmp_path, repo)


def _exit_code(argv):
    try:
        vr.parse_args(argv)
    except SystemExit as e:
        return e.code
    return None


# ── 基準 ──────────────────────────────────────────────────────────────────────

def test_baseline_runs_every_check_and_all_pass(env):
    rows = env.rows()
    assert [label for _, label, _ in rows] == EXPECTED_LABELS
    assert [label for ok, label, _ in rows if not ok] == []


def test_main_prints_every_row_and_a_summary_and_exits_0(env, capsys):
    code = vr.main(env.argv(), run=env.run, open_pyz=env.open_pyz, repo=env.repo)
    lines = capsys.readouterr().out.splitlines()
    assert code == 0
    assert lines[-1] == "全部通過"
    assert len(lines) == len(EXPECTED_LABELS) + 1
    assert [ln[:len("過    " + lb)] for ln, lb in zip(lines, EXPECTED_LABELS)] == ["過    " + lb for lb in EXPECTED_LABELS]


def test_one_broken_check_does_not_stop_the_others(env, capsys):
    env.tag = "v1.0.0-rc.9"  # tag 不存在：四支腳本的比對出錯，其他項照驗、最後一行照印
    try:
        code = vr.main(env.argv(), run=env.run, open_pyz=env.open_pyz, repo=env.repo)
    except Exception as exc:  # 中途丟例外＝這條要守的東西壞了
        code = f"中途丟出 {exc!r}"
    lines = capsys.readouterr().out.splitlines()
    assert code == 1
    assert len(lines) == len(EXPECTED_LABELS) + 1
    assert lines[-1] == "有 4 項失敗"
    assert [ln for ln in lines if ln.startswith("失敗")] == [
        ln for ln in lines if ln.startswith("失敗  成品的 scripts/") and "出錯：" in ln
    ]


# ── 參數 ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("flag", ["--app", "--tag", "--control", "--fp", "--release-dir", "--prev-manifest"])
def test_every_argument_is_required(env, flag):
    argv = env.argv()
    while flag in argv:
        i = argv.index(flag)
        del argv[i:i + 2]
    assert _exit_code(argv) == 2


@pytest.mark.parametrize("tag", ["1.0.0", "v1.0", "v1.0.0-beta", "v1.0.0-rc.", "v1.0.0-rc.1x"])
def test_a_malformed_tag_is_an_argument_error(env, tag):
    env.tag = tag
    assert _exit_code(env.argv()) == 2


@pytest.mark.parametrize("fp", ["fledge_sidecar", ":1.0.0", "fledge_sidecar:"])
def test_a_malformed_fingerprint_is_an_argument_error(env, fp):
    env.fps = [fp]
    assert _exit_code(env.argv()) == 2


def test_an_rc_tag_is_checked_against_its_base_version(env):
    env.tag = "v1.0.0-rc.2"  # 版號 1.0.0 從 tag 推；rc.2 的腳本內容＝v1.0.0
    assert env.failed() == {}


# ── 4.1 版本 ──────────────────────────────────────────────────────────────────

def test_wrong_app_version_fails(env):
    env.set_plist(env.app, CFBundleShortVersionString="1.0.1")
    assert env.failed() == {"新版 Info.plist 版本＝1.0.0": "1.0.1"}


def test_a_control_of_the_same_version_fails(env):
    env.set_plist(env.control, CFBundleShortVersionString="1.0.0")
    assert env.failed() == {"對照組不是 1.0.0": "1.0.0"}


def test_a_control_without_a_version_fails(env):
    env.set_plist(env.control, CFBundleShortVersionString=None)
    assert list(env.failed()) == ["對照組不是 1.0.0"]


# ── 4.2 簽章與最低系統版本 ────────────────────────────────────────────────────

def test_a_different_authority_fails(env):
    env.authority[env.control] = ["Apple Development: someone"]
    assert list(env.failed()) == ["codesign Authority 與對照組相同"]


def test_authority_empty_on_both_sides_fails(env):
    env.authority = {}
    assert env.failed() == {"codesign Authority 與對照組相同": "空的"}


def test_a_different_minimum_system_version_fails(env):
    env.set_plist(env.app, LSMinimumSystemVersion="12.0")
    assert list(env.failed()) == ["LSMinimumSystemVersion 與對照組相同"]


def test_minimum_system_version_missing_on_both_sides_fails(env):
    env.set_plist(env.app, LSMinimumSystemVersion=None)
    env.set_plist(env.control, LSMinimumSystemVersion=None)
    assert list(env.failed()) == ["LSMinimumSystemVersion 與對照組相同"]


@pytest.mark.parametrize("rel", [MAIN, SIDECAR])
def test_a_different_minos_fails(env, rel):
    env.minos[os.path.join(env.app, rel)] = ["14.0"]
    assert list(env.failed()) == [f"{rel} 的 minos 與對照組相同"]


@pytest.mark.parametrize("rel", [MAIN, SIDECAR])
def test_minos_empty_on_both_sides_fails(env, rel):
    env.minos[os.path.join(env.app, rel)] = []
    env.minos[os.path.join(env.control, rel)] = []
    assert env.failed() == {f"{rel} 的 minos 與對照組相同": "空的"}


# ── 4.3 打包進去的腳本 ────────────────────────────────────────────────────────

def test_an_app_carrying_an_older_rcs_script_fails(env):
    for n, b in _scripts_at("v1").items():  # 成品帶的是 rc.1 的腳本，驗的是 rc.2
        env.script(env.app, n).write_bytes(b)
    env.tag = "v1.0.0-rc.2"
    assert list(env.failed()) == ["成品的 scripts/restore-claude.sh 與 v1.0.0-rc.2 相同"]


def test_a_script_dropped_from_both_the_declaration_and_the_app_still_fails(env):
    # v1.0.0-rc.3 的 build_binary.sh 拿掉了 backup-claude.sh 的宣告；預期不從宣告推，所以照樣要它
    env.script(env.app, "backup-claude.sh").unlink()
    env.tag = "v1.0.0-rc.3"
    assert env.failed() == {"成品的 scripts/backup-claude.sh 與 v1.0.0-rc.3 相同": "不存在"}


def test_a_one_byte_difference_fails(env):
    p = env.script(env.app, "expansion_guard.py")
    p.write_bytes(p.read_bytes() + b" ")
    assert list(env.failed()) == ["成品的 scripts/expansion_guard.py 與 v1.0.0 相同"]


@pytest.mark.parametrize("extra", ["new-tool.sh", "sub/nested.sh"])
def test_a_file_outside_the_list_fails(env, extra):
    p = env.script(env.app, extra)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")
    failed = env.failed()
    assert list(failed) == ["成品 scripts/ 沒有清單外的檔"]
    assert extra in failed["成品 scripts/ 沒有清單外的檔"]


def test_a_missing_scripts_dir_fails_every_script_and_the_extra_check(env):
    for p in (Path(env.app) / SCRIPTS).iterdir():
        p.unlink()
    (Path(env.app) / SCRIPTS).rmdir()
    assert env.failed() == {
        **{f"成品的 scripts/{n} 與 v1.0.0 相同": "不存在" for n in NAMES},
        "成品 scripts/ 沒有清單外的檔": "目錄不存在",
    }


def test_a_listed_script_missing_from_the_tag_fails(env):
    env.tag = "v1.0.0-rc.4"  # 這個 tag 裡沒有 scripts/expansion_guard.py
    failed = env.failed()
    assert list(failed) == ["成品的 scripts/expansion_guard.py 與 v1.0.0-rc.4 相同"]
    assert failed["成品的 scripts/expansion_guard.py 與 v1.0.0-rc.4 相同"].startswith("出錯：")


# ── 4.4 指紋 ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("side", ["新版", "對照組"], ids=["new", "control"])
def test_the_read_check_fails_when_fledge_sidecar_lacks_version(env, side):
    modules = env.pyz[os.path.join(env.app if side == "新版" else env.control, SIDECAR)].modules
    modules["fledge_sidecar"] = modules["fledge_sidecar"].replace(b"__version__", b"VERSION")  # 版號字串留著
    assert list(env.failed()) == [f"{side}的 PYZ 讀得到內容（fledge_sidecar 含 __version__）"]


def test_the_read_check_fails_when_fledge_sidecar_is_missing(env):
    del env.pyz[os.path.join(env.control, SIDECAR)].modules["fledge_sidecar"]
    assert env.failed() == {"對照組的 PYZ 讀得到內容（fledge_sidecar 含 __version__）": "PYZ 裡沒有 fledge_sidecar"}


def test_a_module_missing_from_the_new_app_fails(env):
    del env.pyz[os.path.join(env.app, SIDECAR)].modules["fledge_sidecar.backup.bundles"]
    assert env.failed() == {"指紋 fledge_sidecar.backup.bundles:.tar.xz": "新版抽不出模組（PYZ 裡沒有）"}


def test_a_string_missing_from_the_new_app_fails(env):
    env.pyz[os.path.join(env.app, SIDECAR)].modules["fledge_sidecar.backup.bundles"] = b".tar.gz only"
    assert env.failed() == {"指紋 fledge_sidecar.backup.bundles:.tar.xz": "新版不含"}


def test_a_string_the_control_also_has_fails(env):
    env.fps.append("fledge_sidecar.backup.bundles:.tar.gz")
    assert env.failed() == {"指紋 fledge_sidecar.backup.bundles:.tar.gz": "對照組也有，不是這次才有的東西"}


def test_a_namespace_package_fails(env):
    env.pyz[os.path.join(env.app, SIDECAR)].modules["fledge_sidecar.backup.bundles"] = None
    failed = env.failed()
    assert list(failed) == ["指紋 fledge_sidecar.backup.bundles:.tar.xz"]
    assert "namespace package" in failed["指紋 fledge_sidecar.backup.bundles:.tar.xz"]


def test_an_unreadable_control_fails_its_read_check_and_every_fingerprint(env):
    env.pyz[os.path.join(env.control, SIDECAR)] = OSError("not a PyInstaller archive")
    assert list(env.failed()) == [
        "對照組的 PYZ 讀得到內容（fledge_sidecar 含 __version__）",
        "指紋 fledge_sidecar.backup.bundles:.tar.xz",
        "指紋 fledge_sidecar:1.0.0",
    ]


def test_a_namespace_package_in_the_control_fails(env):
    env.pyz[os.path.join(env.control, SIDECAR)].modules["fledge_sidecar.backup.bundles"] = None
    failed = env.failed()
    assert list(failed) == ["指紋 fledge_sidecar.backup.bundles:.tar.xz"]
    assert "namespace package" in failed["指紋 fledge_sidecar.backup.bundles:.tar.xz"]


def test_an_extract_error_in_the_control_is_not_counted_as_absent(env):
    # 只有「目錄裡沒有」（KeyError）算不含；其他讀取錯誤不能讓「對照組沒有」靜默成立
    env.pyz[os.path.join(env.control, SIDECAR)].errors["fledge_sidecar.backup.bundles"] = OSError("read failed")
    assert list(env.failed()) == ["指紋 fledge_sidecar.backup.bundles:.tar.xz"]


@pytest.mark.parametrize("where", ["extract", "open"])
def test_a_reader_that_aborts_with_systemexit_still_finishes_the_report(env, capsys, where):
    # PyInstaller 讀檔時執行檔被移走會丟 SystemExit（不屬於 Exception）：只能讓用到它的那幾行失敗
    ctl = os.path.join(env.control, SIDECAR)
    abort = SystemExit("ERROR: fledge-sidecar appears to have been moved or deleted")
    if where == "extract":
        env.pyz[ctl].errors["fledge_sidecar.backup.bundles"] = abort
        want = ["失敗  指紋 fledge_sidecar.backup.bundles:.tar.xz"]
    else:
        env.pyz[ctl] = abort
        want = ["失敗  對照組的 PYZ 讀得到內容（fledge_sidecar 含 __version__）",
                "失敗  指紋 fledge_sidecar.backup.bundles:.tar.xz", "失敗  指紋 fledge_sidecar:1.0.0"]
    try:
        code = vr.main(env.argv(), run=env.run, open_pyz=env.open_pyz, repo=env.repo)
    except (Exception, SystemExit) as exc:
        code = f"中途丟出 {exc!r}"
    lines = capsys.readouterr().out.splitlines()
    fails = [ln for ln in lines if ln.startswith("失敗")]
    assert code == 1
    assert len(fails) == len(want)
    assert [f[:len(w)] for f, w in zip(fails, want)] == want
    assert lines[-1] == f"有 {len(want)} 項失敗"


def test_a_module_absent_from_the_control_counts_as_not_containing(env):
    del env.pyz[os.path.join(env.control, SIDECAR)].modules["fledge_sidecar.backup.bundles"]
    rows = {label: (ok, detail) for ok, label, detail in env.rows()}
    assert rows["指紋 fledge_sidecar.backup.bundles:.tar.xz"] == (True, "新版有、對照組沒有這個模組")


# ── 4.5 Release 檔案 ──────────────────────────────────────────────────────────

def test_a_checksum_mismatch_fails(env):
    (env.release / "Fledge_aarch64.app.tar.gz").write_bytes(b"tampered")
    assert list(env.failed()) == ["checksums.txt 雜湊相符"]


def test_checksums_with_no_ok_line_fail(env):
    env.shasum = (0, "")  # 工具行為變了也不能判過；dmg 那一項也是讀同一份輸出，跟著失敗
    assert env.failed() == {"checksums.txt 雜湊相符": "0 個 OK", "Fledge_1.0.0_aarch64.dmg 的雜湊驗過": "沒有任何檔驗過"}


def test_checksums_without_this_versions_dmg_fail(env):
    env.write_release({"Fledge_aarch64.app.tar.gz": b"tarball", "Fledge_0.9.0_aarch64.dmg": b"dmg"})
    env.write_manifests(env.manifest, env.manifest)
    assert list(env.failed()) == ["Fledge_1.0.0_aarch64.dmg 的雜湊驗過"]


def test_both_release_rows_read_one_shasum_run(env):
    env.rows()  # 雜湊與 dmg 兩項看同一次 shasum 的結束碼與輸出（spec §4.5），不會各跑各的、看到兩份不同的結果
    assert env.calls.count("shasum") == 1


def test_a_dmg_that_was_not_downloaded_fails(env):
    (env.release / "Fledge_1.0.0_aarch64.dmg").unlink()  # checksums.txt 照樣列著它，--ignore-missing 會略過
    assert env.failed() == {"Fledge_1.0.0_aarch64.dmg 的雜湊驗過": "Fledge_aarch64.app.tar.gz"}


_DIGEST = hashlib.sha256(b"dmg").hexdigest()


@pytest.mark.parametrize("bogus", [
    "#  Fledge_1.0.0_aarch64.dmg",
    "nothex  Fledge_1.0.0_aarch64.dmg",
    f"{_DIGEST}  Fledge_1.0.0_aarch64.dmg ",
    f"{_DIGEST}  Fledge_1.0.0_aarch64.dmg\t",
], ids=["comment", "bad-digest", "trailing-space", "trailing-tab"])
def test_a_dmg_without_a_line_shasum_verifies_fails(env, bogus):
    # 真的 shasum 會略過註解與格式不對的行、把尾端空白當檔名的一部分（找不到就略過），照樣回 0
    # （2026-11-17 實測）；雜湊那一項判過，只有「dmg 真的被驗過」擋得住
    tar_line = (env.release / "checksums.txt").read_text().splitlines()[0]
    (env.release / "checksums.txt").write_text(f"{tar_line}\n{bogus}\n")
    assert list(env.failed()) == ["Fledge_1.0.0_aarch64.dmg 的雜湊驗過"]


def test_a_changed_template_list_fails_and_names_the_ids(env):
    new = {"templates": env.manifest["templates"][1:] + [
        {"id": "new-template", "source_class": "public", "included": True, "files": [], "dirs": []}]}
    new["templates"][0] = {**new["templates"][0], "included": True}
    env.write_manifests(new, env.manifest)
    assert env.failed() == {
        "範本清單 {id: included} 與上一版相同": "多了 new-template、少了 project-starter、dev-methodology 的 included 變了"}


def test_a_template_list_empty_on_both_sides_fails(env):
    env.write_manifests({"templates": []}, {"templates": []})
    assert env.failed() == {"範本清單 {id: included} 與上一版相同": "兩邊都是空的"}

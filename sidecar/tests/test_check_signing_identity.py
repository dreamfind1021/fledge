"""`scripts/check-signing-identity.sh` 的行為契約（票 22）。

這支只是友善診斷、不是防線（spec §5.3）：真正讓沒憑證時打包失敗的是 tauri.conf.json 的
signingIdentity（codesign 原生失敗）。但它說「找到了」的時候必須真的找到——名稱要連同引號
完全相符、名稱要來自設定檔而不是寫死在腳本裡；它說「放行」的時候必須提醒後果。

全程假的 `security`，不碰真實鑰匙圈。腳本複製進假的 repo 樹，證明它是從自己的位置找設定檔。
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check-signing-identity.sh"
NAME = "Fledge Self-Signed"
ADHOC_HINT = "APPLE_SIGNING_IDENTITY=- npm run tauri build"
CONSEQUENCE = "完整磁碟取用授權失效"
_ABSENT = object()


def _listing(*names: str) -> str:
    """照真實 `security find-identity -p codesigning` 的版面：自建憑證會被標成未受信任，
    出現在 Matching 段、不出現在 Valid 段。"""
    lines = ["", "Policy: Code Signing", "  Matching identities"]
    for i, n in enumerate(names, 1):
        lines.append(f'  {i}) {i:040X} "{n}" (CSSMERR_TP_NOT_TRUSTED)')
    lines.append(f"     {len(names)} identities found")
    lines += ["", "  Valid identities only", "     0 valid identities found"]
    return "\n".join(lines) + "\n"


def _tree(tmp_path: Path, identity=NAME) -> Path:
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy2(SCRIPT, root / "scripts" / SCRIPT.name)
    conf = json.loads((REPO / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    if identity is _ABSENT:
        conf["bundle"]["macOS"].pop("signingIdentity", None)
    else:
        conf["bundle"]["macOS"]["signingIdentity"] = identity
    (root / "src-tauri").mkdir()
    (root / "src-tauri" / "tauri.conf.json").write_text(json.dumps(conf), encoding="utf-8")
    return root


def _run(root: Path, tmp_path: Path, listing: str, *, env_extra: dict | None = None,
         cwd: Path | None = None, security_rc: int = 0):
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir(exist_ok=True)
    (fakebin / "listing.txt").write_text(listing, encoding="utf-8")
    calls = tmp_path / "security-calls.txt"
    stub = fakebin / "security"
    # 照真實行為：加了 -v 只列受信任的身分，自建憑證未受信任、不會出現——
    # 不照做的話，實作誤加 -v 時測試照樣全綠，真機上卻找不到憑證（Codex plan R1）
    stub.write_text(
        f'#!/bin/sh\necho "$*" >> "{calls}"\n'
        f'case " $* " in\n'
        f'  *" -v "*) echo "     0 valid identities found" ;;\n'
        f'  *) cat "{fakebin / "listing.txt"}" ;;\n'
        f'esac\nexit {security_rc}\n',
        encoding="utf-8")
    stub.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k != "APPLE_SIGNING_IDENTITY"}
    env["PATH"] = f"{fakebin}:{env['PATH']}"
    env.update(env_extra or {})
    proc = subprocess.run(["/bin/bash", str(root / "scripts" / SCRIPT.name)],
                          cwd=cwd or root, env=env, capture_output=True, text=True)
    return proc, calls


def test_identity_present_passes(tmp_path: Path):
    proc, _ = _run(_tree(tmp_path), tmp_path, _listing(NAME))
    assert proc.returncode == 0, proc.stderr


def test_missing_identity_fails_with_adhoc_hint(tmp_path: Path):
    proc, _ = _run(_tree(tmp_path), tmp_path, _listing())
    assert proc.returncode != 0
    assert NAME in proc.stderr
    assert ADHOC_HINT in proc.stderr
    assert CONSEQUENCE in proc.stderr


def test_similar_name_is_not_a_match(tmp_path: Path):
    proc, _ = _run(_tree(tmp_path), tmp_path, _listing(f"{NAME} (old)"))
    assert proc.returncode != 0, "名稱相近的憑證被當成找到了——比對必須連同前後引號完全相符"


def test_name_comes_from_config(tmp_path: Path):
    root = _tree(tmp_path, identity="Other Name")
    ok, _ = _run(root, tmp_path, _listing("Other Name"))
    assert ok.returncode == 0, ok.stderr
    wrong, _ = _run(root, tmp_path, _listing(NAME))
    assert wrong.returncode != 0, "設定檔寫 Other Name，鑰匙圈只有 Fledge Self-Signed 卻放行——名稱寫死在腳本裡"


def test_env_override_skips_lookup_and_warns(tmp_path: Path):
    proc, calls = _run(_tree(tmp_path), tmp_path, _listing(),
                       env_extra={"APPLE_SIGNING_IDENTITY": "-"})
    assert proc.returncode == 0, proc.stderr
    assert CONSEQUENCE in proc.stderr
    assert not calls.exists(), "有環境變數覆蓋時不該再查鑰匙圈"


def test_empty_env_override_fails(tmp_path: Path):
    # 鑰匙圈裡刻意放著憑證：若把「設了但空」當成沒設，就會走去查鑰匙圈而放行
    proc, calls = _run(_tree(tmp_path), tmp_path, _listing(NAME),
                       env_extra={"APPLE_SIGNING_IDENTITY": ""})
    assert proc.returncode != 0, "APPLE_SIGNING_IDENTITY 是空字串時必須失敗（Tauri 會把空字串交給 codesign）"
    assert not calls.exists()


def test_adhoc_config_passes_with_warning(tmp_path: Path):
    proc, calls = _run(_tree(tmp_path, identity="-"), tmp_path, _listing())
    assert proc.returncode == 0, proc.stderr
    assert CONSEQUENCE in proc.stderr
    assert not calls.exists()


def test_config_without_signing_identity_is_treated_as_adhoc(tmp_path: Path):
    proc, calls = _run(_tree(tmp_path, identity=_ABSENT), tmp_path, _listing())
    assert proc.returncode == 0, proc.stderr
    assert CONSEQUENCE in proc.stderr
    assert not calls.exists()


def test_runs_from_any_cwd(tmp_path: Path):
    """Tauri 從哪個目錄跑 beforeBuildCommand 都一樣：設定檔要以腳本自身位置找。"""
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    proc, _ = _run(_tree(tmp_path), tmp_path, _listing(NAME), cwd=elsewhere)
    assert proc.returncode == 0, proc.stderr


def test_security_failure_fails(tmp_path: Path):
    proc, _ = _run(_tree(tmp_path), tmp_path, _listing(NAME), security_rc=1)
    assert proc.returncode != 0, "security 本身失敗時不能當成找到"


def test_tauri_config_wires_the_check():
    conf = json.loads((REPO / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    assert conf["build"]["beforeBuildCommand"] == \
        "bash scripts/check-signing-identity.sh && npm run build"
    # 名稱一改，release.yml 的指紋、兩個 secret、維護者筆記都要跟著換（spec §5.1）
    assert conf["bundle"]["macOS"]["signingIdentity"] == NAME


def _devtools_tree(tmp_path: Path, check_rc: int) -> tuple[Path, Path]:
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy2(REPO / "scripts" / "build-app-devtools.sh", root / "scripts" / "build-app-devtools.sh")
    (root / "scripts" / "check-signing-identity.sh").write_text(
        f"#!/bin/sh\nexit {check_rc}\n", encoding="utf-8")
    marker = tmp_path / "sidecar-built"
    (root / "sidecar").mkdir()
    sidecar_build = root / "sidecar" / "build_binary.sh"
    sidecar_build.write_text(f'#!/bin/sh\ntouch "{marker}"\n', encoding="utf-8")
    sidecar_build.chmod(0o755)
    return root, marker


def test_devtools_build_checks_identity_before_building_sidecar(tmp_path: Path):
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    npm = fakebin / "npm"
    npm.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    npm.chmod(0o755)
    env = {**os.environ, "PATH": f"{fakebin}:{os.environ['PATH']}"}

    root, marker = _devtools_tree(tmp_path / "fail", check_rc=1)
    proc = subprocess.run(["/bin/bash", str(root / "scripts" / "build-app-devtools.sh")],
                          cwd=root, env=env, capture_output=True, text=True)
    assert proc.returncode != 0
    assert not marker.exists(), "檢查失敗後還去打包 sidecar——要先檢查、不要先花幾分鐘再失敗"

    root, marker = _devtools_tree(tmp_path / "pass", check_rc=0)
    proc = subprocess.run(["/bin/bash", str(root / "scripts" / "build-app-devtools.sh")],
                          cwd=root, env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert marker.exists(), "檢查通過後必須照常打包 sidecar"

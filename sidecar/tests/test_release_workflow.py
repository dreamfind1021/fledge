"""release workflow 的結構鎖。

這道檢查是「私有內容不得進入釋出版」的最後防線，而 workflow 偵測不到自己被改。
**必須解析 YAML 並只看未被註解的指令**——純字串比對擋不住「把驗證那行註解掉」：
字串還在、順序還在，測試照樣綠，但驗證已經不會執行。
"""
import json
import os
import re
import subprocess
from pathlib import Path

import yaml


def _workflow_path() -> Path:
    return Path(__file__).resolve().parents[2] / ".github" / "workflows" / "release.yml"


def _upload_run_node() -> yaml.ScalarNode:
    """回傳「執行 gh release create 的那個 step」的 run 節點（**保留 scalar style**）。

    票 22 起上傳改成「所有驗證通過後才 `gh release create --draft`」，取代原本 tauri-action 先建
    草稿、這一步再 `gh release upload --clobber` 的做法；「驗證與上傳在同一步」的設計不變。

    用 compose 而非 safe_load，是因為 safe_load 會丟掉 scalar style，而 style 在這裡
    攸關正確性：`run: >`（folded）會把多行折成一行，一個 `#` 就能把後面整串吞成註解，
    純比對字串的測試完全看不出來。下面的 test 因此強制要求 literal style `|`。"""
    root = yaml.compose(_workflow_path().read_text(encoding="utf-8"))
    found: list[yaml.ScalarNode] = []

    def walk(node) -> None:
        if isinstance(node, yaml.MappingNode):
            for key, value in node.value:
                if (isinstance(key, yaml.ScalarNode) and key.value == "run"
                        and isinstance(value, yaml.ScalarNode)
                        and "gh release create" in value.value):
                    found.append(value)
                walk(value)
        elif isinstance(node, yaml.SequenceNode):
            for item in node.value:
                walk(item)

    walk(root)
    assert len(found) == 1, f"預期恰好一個執行 gh release create 的步驟，找到 {len(found)}"
    return found[0]


def _active_lines(script: str) -> str:
    return "\n".join(ln for ln in script.splitlines() if not re.match(r"\s*#", ln))


def _all_active_run_text() -> str:
    workflow = yaml.safe_load(_workflow_path().read_text(encoding="utf-8"))
    assert isinstance(workflow, dict) and isinstance(workflow.get("jobs"), dict), \
        "release.yml 結構不符預期（缺 jobs）"
    lines: list[str] = []
    for job in workflow["jobs"].values():
        for step in (job.get("steps") or []):
            run = step.get("run")
            if isinstance(run, str):
                lines.append(_active_lines(run))
    return "\n".join(lines)


def _shell_setup(script: str) -> str:
    """步驟開頭的 `set -...` 那行（沒有就回空字串——讓測試因行為失敗，而非因抽取失敗）。"""
    return next((ln for ln in script.splitlines() if ln.strip().startswith("set -")), "")


def _python_block(script: str, *, marker: str | None = None, piped: bool = False) -> str:
    """抽出一個 `python3 -c "…"` 區塊。`marker` 依內容挑；`piped` 挑「收尾接了 `|`」的那個
    （並一路含到 pipeline 的 `done`）。

    抽出來**實際執行**，是因為字串比對證明不了指令真的會跑：把
    `python3 scripts/x.py` 換成 `echo scripts/x.py`，關鍵字與順序都還在。
    `marker` 必須挑得出唯一一段——用 `TEMPLATE_SPECS` 之類同時出現在多段的字串，
    會抽到不是 pipeline 的那一段，測試就變成在測別的東西（本檔實際踩過）。"""
    lines = script.splitlines()
    for i, line in enumerate(lines):
        if not line.strip().startswith('python3 -c "'):
            continue
        end = next(j for j in range(i + 1, len(lines)) if lines[j].strip().startswith('"'))
        block = "\n".join(lines[i:end + 1])
        if piped:
            if not lines[end].strip().startswith('" |'):
                continue
            end = next(j for j in range(end, len(lines)) if lines[j].strip() == "done")
            return "\n".join(lines[i:end + 1])
        if marker is not None and marker in block:
            return block
    raise AssertionError(
        f"上傳步驟內找不到符合條件的內嵌 python 區塊（marker={marker!r}, piped={piped}）")


def test_upload_step_uses_literal_block_scalar():
    # folded（`run: >`）會把行折在一起，讓一個 `#` 吞掉後面所有指令，
    # 而任何基於「逐行剝註解」的檢查都會被騙過。直接禁用它。
    node = _upload_run_node()
    assert node.style == "|", "上傳步驟的 run 必須用 literal block scalar（`run: |`）"


def test_verifier_runs_in_the_same_step_that_uploads():
    script = _active_lines(_upload_run_node().value)
    assert "verify_templates_artifact.py" in script, \
        "驗證器必須在產生上傳檔的同一步驟內執行（拿掉驗證等於拿掉打包）"
    assert script.index("verify_templates_artifact.py") < script.index("gh release create"), \
        "驗證必須在上傳之前"
    # 只要求「字串存在」擋不住 `echo scripts/verify_templates_artifact.py` 或
    # `true scripts/...`——關鍵字與順序都還在，驗證卻不會執行。要求該行以 python3 起頭。
    assert re.search(r"^\s*python3\s+scripts/verify_templates_artifact\.py\b",
                     script, re.MULTILINE), \
        "驗證器必須是真正的 python3 呼叫，不能只是印出檔名"


def test_upload_step_constrains_private_template_inputs():
    # 命名刻意不說「保證沒有私有內容」——workflow 只約束得了 private staging 輸入
    # 與頂層分類，內容是不是私有是人的判斷（見 plan Global Constraints）。
    script = _active_lines(_upload_run_node().value)
    assert "FLEDGE_PRIVATE_TEMPLATES_DIR" in script, "少了「私有範本目錄未設」的前提斷言"
    assert "public seed" in script, "少了 repo public seed 的頂層分類檢查"


def test_public_seed_drift_check_runs_before_upload():
    # drift 是「public seed 多一個檔案必須在 PR diff 裡顯形」的唯一機械控制，
    # 必須真的在上傳步驟內、且在上傳之前執行——不能只是某處出現過那串錯誤訊息。
    script = _active_lines(_upload_run_node().value)
    assert "build_manifest_entries" in script, "drift 檢查必須實際呼叫 build_manifest_entries"
    assert "manifest 與內容不符" in script
    assert script.index("build_manifest_entries") < script.index("gh release create")


def test_release_never_builds_with_private_templates():
    assert "--with-private-templates" not in _all_active_run_text(), \
        "release 一律 public-mode，不得帶私有範本 flag"


def test_a_failing_embedded_python_aborts_the_step(tmp_path: Path):
    """內嵌 python 掛掉必須中止整個步驟——GitHub 預設 shell 是 `bash -e {0}`，**沒有
    pipefail**。私有 id 掃描是 `python3 -c ... | while read`：左側 python 語法錯或 import
    失敗會非 0 退出，右側 while 在零筆輸入下回 0，整條 pipeline 就是 0，後面的 tar／
    upload／publish 照樣跑＝驗證缺席卻靜默通過。

    抽出真實片段、在找不到 sidecar 套件的 cwd 下以 `bash -e`（＝GitHub 的 shell）執行，
    證明它仍以非 0 中止。拿掉步驟裡的 `set -euo pipefail` 這支就會紅。"""
    script = _active_lines(_upload_run_node().value)
    snippet = _shell_setup(script) + "\n" + _python_block(script, piped=True)
    result = subprocess.run(["bash", "-e", "-c", snippet], cwd=tmp_path,
                            capture_output=True, text=True,
                            env={**os.environ, "APP": str(tmp_path)})
    assert result.returncode != 0, \
        f"內嵌 python 失敗卻沒有中止步驟（缺 pipefail）：{result.stdout}{result.stderr}"


def test_drift_check_actually_detects_a_drifted_seed(tmp_path: Path):
    """drift 檢查必須真的會偵測到 drift，不是印一段訊息就算。

    做法：把 workflow 裡那段 python 原封抽出來，對著一棵**假的 repo 樹**跑兩次——
    manifest 相符時通過、seed 多一個檔沒同步 manifest 時失敗。換成 `echo` 同樣訊息的
    mutant 會在後半段被殺死（echo 永遠 exit 0）。"""
    block = _python_block(_active_lines(_upload_run_node().value),
                          marker="build_manifest_entries")
    fake_repo = tmp_path / "repo"
    (fake_repo / "sidecar").mkdir(parents=True)
    # 區塊寫死 `sys.path.insert(0, 'sidecar')`，所以假樹裡要有可 import 的 fledge_sidecar
    (fake_repo / "sidecar" / "fledge_sidecar").symlink_to(
        Path(__file__).resolve().parents[1] / "fledge_sidecar")
    seed = fake_repo / "sidecar" / "resources" / "templates-public" / "demo"
    seed.mkdir(parents=True)
    (seed / "a.md").write_text("a", encoding="utf-8")
    (seed / "manifest.json").write_text(
        json.dumps({"entries": [{"path": "a.md", "type": "file"}]}), encoding="utf-8")

    ok = subprocess.run(["bash", "-e", "-c", block], cwd=fake_repo,
                        capture_output=True, text=True)
    assert ok.returncode == 0, f"manifest 相符時不該失敗：{ok.stdout}{ok.stderr}"

    (seed / "sneaked.md").write_text("偷偷加的，沒同步 manifest", encoding="utf-8")
    drifted = subprocess.run(["bash", "-e", "-c", block], cwd=fake_repo,
                             capture_output=True, text=True)
    assert drifted.returncode != 0, "seed 多一個檔沒同步 manifest 時 drift 檢查必須失敗"


# ---- 票 22：發版流程重做——所有驗證通過後才建 Release；workflow 不刪除任何 Release ----

_REFUSE = "Refuse existing release"
_TAURI_BUILD = "Tauri build"
_PUBLISH = "Publish release (rc → prerelease)"
_PACKAGE = "Verify + package (驗證失敗就沒有可上傳的檔案)"
_ENV = {"GITHUB_REF_NAME": "v1.2.3", "GITHUB_REPOSITORY": "owner/repo"}


def _release_steps() -> list[dict]:
    workflow = yaml.safe_load(_workflow_path().read_text(encoding="utf-8"))
    assert isinstance(workflow, dict) and isinstance(workflow.get("jobs"), dict), \
        "release.yml 結構不符預期（缺 jobs）"
    assert list(workflow["jobs"]) == ["release"], f"預期只有 release 一個 job：{list(workflow['jobs'])}"
    return workflow["jobs"]["release"]["steps"]


def _label(step: dict) -> str:
    return step.get("name") or step.get("uses") or str(step.get("run", "")).strip()


def _step(label: str) -> dict:
    found = [s for s in _release_steps() if _label(s) == label]
    assert len(found) == 1, f"預期恰好一個「{label}」步驟，找到 {len(found)}"
    return found[0]


def _named_run_node(label: str) -> yaml.ScalarNode:
    """名為 label 的步驟的 run 節點（保留 scalar style，理由同 _upload_run_node）。"""
    root = yaml.compose(_workflow_path().read_text(encoding="utf-8"))
    found: list[yaml.ScalarNode] = []

    def walk(node) -> None:
        if isinstance(node, yaml.MappingNode):
            keys = {k.value: v for k, v in node.value if isinstance(k, yaml.ScalarNode)}
            name, run = keys.get("name"), keys.get("run")
            if (isinstance(name, yaml.ScalarNode) and name.value == label
                    and isinstance(run, yaml.ScalarNode)):
                found.append(run)
            for _, value in node.value:
                walk(value)
        elif isinstance(node, yaml.SequenceNode):
            for item in node.value:
                walk(item)

    walk(root)
    assert len(found) == 1, f"預期恰好一個名為「{label}」且有 run 的步驟，找到 {len(found)}"
    return found[0]


def _fake_bin(tmp_path: Path, name: str, body: str) -> None:
    d = tmp_path / "fakebin"
    d.mkdir(exist_ok=True)
    f = d / name
    f.write_text(body, encoding="utf-8")
    f.chmod(0o755)


def _gh(tmp_path: Path, stdout: str = "", rc: int = 0) -> Path:
    """假的 gh：把參數一行一筆記下來、印出指定內容、以指定結束碼離開。"""
    calls = tmp_path / "gh-calls.txt"
    out = tmp_path / "gh-stdout.txt"
    out.write_text(stdout, encoding="utf-8")
    _fake_bin(tmp_path, "gh", f'#!/bin/sh\necho "$*" >> "{calls}"\ncat "{out}"\nexit {rc}\n')
    return calls


def _bash(script: str, tmp_path: Path, env: dict, cwd: Path | None = None):
    """用 macOS 內建的 /bin/bash（3.2）跑：比 runner 上的 bash 舊，舊的能跑新的也能跑。
    GitHub 的預設 shell 是 `bash -e {0}`，這裡照樣帶 -e。"""
    full_env = {**os.environ, "PATH": f"{tmp_path / 'fakebin'}:{os.environ['PATH']}", **env}
    return subprocess.run(["/bin/bash", "-e", "-c", script], cwd=cwd or tmp_path,
                          env=full_env, capture_output=True, text=True)


def _run_step(label: str, tmp_path: Path, env: dict, cwd: Path | None = None):
    return _bash(_step(label)["run"], tmp_path, env, cwd)


_EXPECTED_ORDER = [
    "actions/checkout@v4",
    "actions/setup-python@v5",
    "actions/setup-node@v4",
    "dtolnay/rust-toolchain@stable",
    "Version guard (format + tag base == tauri.conf.json)",
    _REFUSE,
    "Build sidecar (onedir + nested codesign)",
    "npm ci",
    _TAURI_BUILD,
    "Verify bundle (codesign + resource path + sidecar runs)",
    _PACKAGE,
    _PUBLISH,
]
_STRICT_STEPS = [_REFUSE, _TAURI_BUILD, _PUBLISH]


def test_release_steps_run_in_the_designed_order():
    assert [_label(s) for s in _release_steps()] == _EXPECTED_ORDER


def test_tauri_action_is_gone():
    # tauri-action 在草稿模式下找既有 Release 只比 tag、不管是不是草稿：重跑已發布的 tag 時，
    # 它會在任何驗證之前就把產物傳進公開 Release（票 22 Codex R1，讀其 create-release.ts 確認）
    assert not [s for s in _release_steps() if str(s.get("uses", "")).startswith("tauri-apps/tauri-action")]
    body = [ln.strip() for ln in _active_lines(_step(_TAURI_BUILD)["run"]).splitlines()
            if ln.strip() and ln.strip() != "set -euo pipefail"]
    assert body == ["npm run tauri build -- --target aarch64-apple-darwin"]


def test_same_tag_runs_are_serialized_not_cancelled():
    workflow = yaml.safe_load(_workflow_path().read_text(encoding="utf-8"))
    conc = workflow.get("concurrency")
    assert isinstance(conc, dict), "缺 concurrency：同一個 tag 的兩次執行會同時跑"
    assert "github.ref_name" in str(conc.get("group", ""))
    assert conc.get("cancel-in-progress") is False


def test_workflow_never_deletes_a_release():
    # 自動刪除被兩輪審查打穿（會刪到人工建的草稿；「確認是草稿」到「刪除」之間被按發布）。
    # workflow 一律不刪，失敗留下的草稿交給人處理。
    assert "gh release delete" not in _all_active_run_text()
    assert not [s for s in _release_steps() if "failure()" in str(s.get("if", ""))]


def test_new_and_changed_steps_are_strict_literal_blocks():
    for label in _STRICT_STEPS:
        node = _named_run_node(label)
        assert node.style == "|", f"「{label}」的 run 必須是 literal block"
        first = next(ln.strip() for ln in node.value.splitlines()
                     if ln.strip() and not ln.strip().startswith("#"))
        assert first == "set -euo pipefail", f"「{label}」的第一個指令必須是 set -euo pipefail"


def test_refuse_passes_when_tag_has_no_release(tmp_path: Path):
    calls = _gh(tmp_path, stdout="")
    r = _run_step(_REFUSE, tmp_path, _ENV)
    assert r.returncode == 0, r.stdout + r.stderr
    args = calls.read_text(encoding="utf-8")
    # 用列表 API 才查得到草稿；用 tag 查的端點看不到
    assert "--paginate" in args and "repos/owner/repo/releases" in args and "v1.2.3" in args


def test_refuse_stops_on_published_release(tmp_path: Path):
    _gh(tmp_path, stdout="false\n")
    r = _run_step(_REFUSE, tmp_path, _ENV)
    assert r.returncode != 0
    assert "升版號" in r.stdout


def test_refuse_stops_on_draft_without_deleting_it(tmp_path: Path):
    calls = _gh(tmp_path, stdout="true\n")
    r = _run_step(_REFUSE, tmp_path, _ENV)
    assert r.returncode != 0
    assert "手動刪除" in r.stdout
    assert "delete" not in calls.read_text(encoding="utf-8"), "草稿可能是人工建的，不能自動刪"


def test_refuse_fails_when_query_fails(tmp_path: Path):
    _gh(tmp_path, stdout="", rc=1)
    r = _run_step(_REFUSE, tmp_path, _ENV)
    assert r.returncode != 0, "查詢失敗被當成「沒有 Release」"


def test_refuse_sees_a_match_after_blank_pages(tmp_path: Path):
    # --paginate 每頁各跑一次 --jq：沒命中的頁面不印東西，命中的那筆可能在後面的頁
    _gh(tmp_path, stdout="\n\nfalse\n")
    r = _run_step(_REFUSE, tmp_path, _ENV)
    assert r.returncode != 0


def _create_snippet() -> str:
    """上傳步驟裡 `gh release create … || { …; }` 那一段（含失敗處理）。"""
    lines = _active_lines(_upload_run_node().value).splitlines()
    i = next(k for k, ln in enumerate(lines) if ln.strip().startswith("gh release create"))
    j = next(k for k in range(i, len(lines)) if lines[k].rstrip().endswith("}"))
    return "\n".join(lines[i:j + 1])


def test_release_is_created_as_draft_with_all_assets(tmp_path: Path):
    calls = _gh(tmp_path)
    env = {**_ENV, "DMG_PATH": "bundle/dmg/Fledge_1.2.3_aarch64.dmg"}
    r = _bash(_create_snippet(), tmp_path, env)
    assert r.returncode == 0, r.stdout + r.stderr
    args = calls.read_text(encoding="utf-8")
    assert args.startswith("release create v1.2.3 ")
    for part in ("bundle/dmg/Fledge_1.2.3_aarch64.dmg", "Fledge_aarch64.app.tar.gz",
                 "templates-artifact-manifest.json", "checksums.txt",
                 "--draft", "--verify-tag", "--title Fledge v1.2.3"):
        assert part in args, f"gh release create 少了 {part}"


def test_failed_create_points_to_manual_cleanup(tmp_path: Path):
    calls = _gh(tmp_path, rc=1)
    env = {**_ENV, "DMG_PATH": "x.dmg"}
    r = _bash(_create_snippet(), tmp_path, env)
    assert r.returncode != 0
    assert "https://github.com/owner/repo/releases" in r.stdout and "手動刪除" in r.stdout
    assert "delete" not in calls.read_text(encoding="utf-8")


def test_publish_marks_rc_as_prerelease(tmp_path: Path):
    calls = _gh(tmp_path)
    r = _run_step(_PUBLISH, tmp_path, {**_ENV, "GITHUB_REF_NAME": "v1.2.3-rc.1"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert calls.read_text(encoding="utf-8").strip() == "release edit v1.2.3-rc.1 --draft=false --prerelease"


def test_publish_final_release_is_not_prerelease(tmp_path: Path):
    calls = _gh(tmp_path)
    r = _run_step(_PUBLISH, tmp_path, _ENV)
    assert r.returncode == 0, r.stdout + r.stderr
    assert calls.read_text(encoding="utf-8").strip() == "release edit v1.2.3 --draft=false"


def test_failed_publish_says_it_may_have_published(tmp_path: Path):
    _gh(tmp_path, rc=1)
    r = _run_step(_PUBLISH, tmp_path, _ENV)
    assert r.returncode != 0
    assert "不代表沒發布" in r.stdout
    assert "https://github.com/owner/repo/releases/tag/v1.2.3" in r.stdout

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
    """回傳「執行 gh release upload 的那個 step」的 run 節點（**保留 scalar style**）。

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
                        and "gh release upload" in value.value):
                    found.append(value)
                walk(value)
        elif isinstance(node, yaml.SequenceNode):
            for item in node.value:
                walk(item)

    walk(root)
    assert len(found) == 1, f"預期恰好一個執行 gh release upload 的步驟，找到 {len(found)}"
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
    assert script.index("verify_templates_artifact.py") < script.index("gh release upload"), \
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
    assert script.index("build_manifest_entries") < script.index("gh release upload")


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

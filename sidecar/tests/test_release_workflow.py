"""release workflow 的結構鎖。

這道檢查是「私有內容不得進入釋出版」的最後防線，而 workflow 偵測不到自己被改。
**必須解析 YAML 並只看未被註解的指令**——純字串比對擋不住「把驗證那行註解掉」：
字串還在、順序還在，測試照樣綠，但驗證已經不會執行。
"""
import re
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

import json
import os
from pathlib import Path

import pytest

from fledge_sidecar.setup import template_manifest as tm
from fledge_sidecar.setup import templates as tp


def _staged(tmp_path: Path, ids: list[str]) -> Path:
    """建一個假的 staged 範本樹：每個 id 一個目錄 + 一個檔案 + manifest。"""
    root = tmp_path / "staged"
    for tid in ids:
        d = root / tid
        d.mkdir(parents=True)
        (d / "a.md").write_text(tid, encoding="utf-8")
        entries = tp.build_manifest_entries(str(d))
        (d / tp.MANIFEST_FILENAME).write_text(
            json.dumps({"entries": [{"path": e.path, "type": e.type} for e in entries]}),
            encoding="utf-8")
    return root


def test_build_artifact_manifest_classifies_from_the_spec_table(tmp_path: Path):
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    by_id = {t["id"]: t for t in manifest["templates"]}
    assert by_id["project-starter"]["source_class"] == "public"
    assert by_id["project-starter"]["included"] is True
    # 未 include 的也要列出來，且標明沒帶進去
    assert by_id["dev-methodology"]["source_class"] == "private"
    assert by_id["dev-methodology"]["included"] is False
    assert by_id["project-starter"]["files"], "included 的範本要列出實際檔案"


def test_verify_passes_on_a_clean_public_artifact(tmp_path: Path):
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    assert tm.verify_artifact(str(root), manifest, allow_private=False) == []


def test_verify_rejects_private_template_in_public_mode(tmp_path: Path):
    root = _staged(tmp_path, ["project-starter", "dev-methodology"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter", "dev-methodology"])
    violations = tm.verify_artifact(str(root), manifest, allow_private=False)
    assert any("dev-methodology" in v for v in violations)
    # 自用 build 明確允許時才放行
    assert tm.verify_artifact(str(root), manifest, allow_private=True) == []


def test_verify_rejects_file_listed_but_absent(tmp_path: Path):
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    (root / "project-starter" / "a.md").unlink()
    violations = tm.verify_artifact(str(root), manifest, allow_private=False)
    assert any("a.md" in v for v in violations)


def test_verify_rejects_file_present_but_unlisted(tmp_path: Path):
    # 反向對帳：有東西被塞進 artifact 卻沒登記，同樣是洩漏面
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    (root / "project-starter" / "secret.md").write_text("私人內容", encoding="utf-8")
    violations = tm.verify_artifact(str(root), manifest, allow_private=False)
    assert any("secret.md" in v for v in violations)


def test_verify_rejects_directory_not_in_the_spec_table(tmp_path: Path):
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    (root / "mystery").mkdir()
    (root / "mystery" / "x.md").write_text("?", encoding="utf-8")
    violations = tm.verify_artifact(str(root), manifest, allow_private=False)
    assert any("mystery" in v for v in violations)


def test_verify_rejects_missing_or_unknown_source_class(tmp_path: Path):
    # 缺標不預設成 public——fail-closed
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    manifest["templates"][0].pop("source_class")
    assert tm.verify_artifact(str(root), manifest, allow_private=False)
    manifest["templates"][0]["source_class"] = "somethingelse"
    assert tm.verify_artifact(str(root), manifest, allow_private=False)


def test_verify_rejects_private_relabelled_as_public(tmp_path: Path):
    # 最關鍵的一條：分類必須與 TEMPLATE_SPECS **相等**，不是「是個合法值」就好。
    # 只驗合法值的話，把 private 改標成 public 就能通過 public-mode 驗證。
    root = _staged(tmp_path, ["project-starter", "dev-methodology"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter", "dev-methodology"])
    private_entry = next(t for t in manifest["templates"] if t["id"] == "dev-methodology")
    private_entry["source_class"] = "public"          # 竄改分類
    violations = tm.verify_artifact(str(root), manifest, allow_private=False)
    assert any("dev-methodology" in v and "allowlist" in v for v in violations)


def test_verify_rejects_duplicate_manifest_records(tmp_path: Path):
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    manifest["templates"].append(dict(manifest["templates"][0]))
    assert any("重複" in v for v in tm.verify_artifact(str(root), manifest, allow_private=False))


def test_verify_rejects_content_swapped_without_renaming(tmp_path: Path):
    # 雜湊產出後從不比對的話，內容被換掉完全看不出來
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    (root / "project-starter" / "a.md").write_text("被換掉的內容", encoding="utf-8")
    violations = tm.verify_artifact(str(root), manifest, allow_private=False)
    assert any("雜湊不符" in v for v in violations)


def test_verify_rejects_stray_objects_at_staged_root(tmp_path: Path):
    # 根層完全沒被掃的話，一個 secret.txt 放在這裡就跟著出貨了
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    (root / "secret.txt").write_text("私人內容", encoding="utf-8")
    assert any("secret.txt" in v
               for v in tm.verify_artifact(str(root), manifest, allow_private=False))
    (root / "secret.txt").unlink()
    (root / ".hidden").write_text("也算", encoding="utf-8")
    assert any(".hidden" in v
               for v in tm.verify_artifact(str(root), manifest, allow_private=False))


def test_verify_validates_schema_of_excluded_records_too(tmp_path: Path):
    # 排除項的欄位若在「目錄不存在就跳過」之前沒被驗，刪掉 files/dirs 或塞成字串
    # 都會靜靜通過——fail-open。schema 必須先驗、再看目錄。
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    for entry in manifest["templates"]:
        if not entry["included"]:
            entry.pop("files")
            entry.pop("dirs")
    assert any("欄位缺漏" in v for v in tm.verify_artifact(str(root), manifest, allow_private=False))

    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    next(t for t in manifest["templates"] if not t["included"])["files"] = [
        {"path": "x", "sha256": "y"}]
    assert any("必須帶空的" in v
               for v in tm.verify_artifact(str(root), manifest, allow_private=False))


def test_verify_rejects_malformed_dirs_entries(tmp_path: Path):
    # dirs 混入非字串會讓 set() 拋 TypeError，破壞「只回違規清單不拋例外」的合約
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    included = next(t for t in manifest["templates"] if t["included"])
    included["dirs"] = [{"not": "a string"}]
    assert any("非字串" in v for v in tm.verify_artifact(str(root), manifest, allow_private=False))
    included["dirs"] = ["docs", "docs"]
    assert any("重複" in v for v in tm.verify_artifact(str(root), manifest, allow_private=False))


def test_verify_rejects_empty_directory_for_an_excluded_template(tmp_path: Path):
    # 空目錄本身就是違規：留一個沒人看管的 dev-methodology/ 在 artifact 裡沒有意義
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    (root / "dev-methodology").mkdir()
    assert any("dev-methodology" in v
               for v in tm.verify_artifact(str(root), manifest, allow_private=False))


def test_verify_requires_the_artifact_manifest_to_be_a_regular_file(tmp_path: Path):
    # 只比名字的話，一個叫 artifact-manifest.json 的 FIFO 也會過
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    os.mkfifo(root / tm.ARTIFACT_MANIFEST_FILENAME)
    assert any("一般檔案" in v
               for v in tm.verify_artifact(str(root), manifest, allow_private=False))


def test_verify_rejects_empty_and_symlinked_directories(tmp_path: Path):
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    (root / "project-starter" / "empty-dir").mkdir()          # 未登記的空目錄
    assert any("empty-dir" in v
               for v in tm.verify_artifact(str(root), manifest, allow_private=False))
    (root / "project-starter" / "empty-dir").rmdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "project-starter" / "linkdir").symlink_to(outside)  # symlink 不得靜默略過
    assert any("linkdir" in v
               for v in tm.verify_artifact(str(root), manifest, allow_private=False))


def test_verify_rejects_a_template_missing_from_the_manifest(tmp_path: Path):
    # 缺席視為違規：manifest 少登記一個 id，那個 id 的目錄就沒有任何一條規則在看它
    # （逐項迴圈只走 manifest 有的記錄），私有範本被整段刪掉反而變成通過。
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    manifest["templates"] = [t for t in manifest["templates"] if t["id"] != "kms-seed"]
    assert any("kms-seed" in v
               for v in tm.verify_artifact(str(root), manifest, allow_private=False))


def test_verify_rejects_a_symlink_even_when_the_manifest_declares_it(tmp_path: Path):
    # symlink 不能只靠「未登記」被抓到：manifest 一旦也把它登記進 dirs，雙向對帳就
    # 對得上，只剩「symlink 一律列為違規物件」這條擋得住。放過的話 PyInstaller
    # --add-data 會沿它把宿主機上的內容打包進 artifact。
    root = _staged(tmp_path, ["project-starter"])
    manifest = tm.build_artifact_manifest(str(root), ["project-starter"])
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "project-starter" / "linkdir").symlink_to(outside)
    included = next(t for t in manifest["templates"] if t["id"] == "project-starter")
    included["dirs"] = ["linkdir"]                     # 連 manifest 都登記了
    violations = tm.verify_artifact(str(root), manifest, allow_private=False)
    assert any("symlink" in v for v in violations)


def test_build_artifact_manifest_refuses_to_describe_a_symlinked_seed(tmp_path: Path):
    # 產生端與載入端各套一份拒絕規則（plan Global Constraints）：產生端不擋的話，
    # manifest 會靜靜漏掉這個物件，整條防線只剩 verify 一道。
    root = _staged(tmp_path, ["project-starter"])
    (root / "project-starter" / "link.md").symlink_to(tmp_path / "outside.md")
    with pytest.raises(ValueError, match="symlink"):
        tm.build_artifact_manifest(str(root), ["project-starter"])


def test_verify_rejects_malformed_manifest(tmp_path: Path):
    root = _staged(tmp_path, ["project-starter"])
    for bad in ({}, {"templates": "nope"}, {"templates": [{"id": "ghost", "included": True}]}):
        assert tm.verify_artifact(str(root), bad, allow_private=False)

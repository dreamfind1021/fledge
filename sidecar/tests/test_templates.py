import json
import os
from pathlib import Path

import pytest

from fledge_sidecar.setup import templates as tp


def _seed(tmp_path: Path, template_id: str = "demo") -> Path:
    """建一個假的範本根目錄並以 env 指向它；回該範本的內容目錄。"""
    root = tmp_path / "templates"
    content = root / template_id
    content.mkdir(parents=True)
    os.environ["FLEDGE_TEMPLATES_DIR"] = str(root)
    # 測試用 id 不進正式 allowlist；由 fixture 還原（load_manifest 會先驗 allowlist）
    tp._SPEC_BY_ID.setdefault(
        template_id, tp.TemplateSpec(template_id, "Demo", "測試用", "public"))
    return content


def _write_manifest(content: Path, entries: list[dict]) -> None:
    (content / tp.MANIFEST_FILENAME).write_text(
        json.dumps({"entries": entries}), encoding="utf-8")


@pytest.fixture(autouse=True)
def _clear_templates_env(monkeypatch):
    # 每支測試各自設定；避免互相污染（_seed 直接寫 os.environ，靠 monkeypatch 還原）
    monkeypatch.delenv("FLEDGE_TEMPLATES_DIR", raising=False)
    original = dict(tp._SPEC_BY_ID)
    yield
    tp._SPEC_BY_ID.clear()
    tp._SPEC_BY_ID.update(original)


def test_template_specs_are_an_allowlist():
    ids = [s.id for s in tp.TEMPLATE_SPECS]
    assert len(ids) == len(set(ids)), "id 必須唯一（allowlist key）"
    for spec in tp.TEMPLATE_SPECS:
        assert spec.source_class in {"public", "private"}
        assert spec.label and spec.description
    with pytest.raises(ValueError, match="unknown_template"):
        tp.get_template_spec("../evil")


def test_templates_root_prefers_env_override(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_TEMPLATES_DIR", str(tmp_path / "elsewhere"))
    assert tp.templates_root() == str(tmp_path / "elsewhere")


def test_build_manifest_lists_files_and_dirs_relative_and_sorted(tmp_path: Path):
    content = _seed(tmp_path)
    (content / "docs").mkdir()
    (content / "docs" / "guide.md").write_text("g", encoding="utf-8")
    (content / "CLAUDE.md").write_text("c", encoding="utf-8")
    entries = tp.build_manifest_entries(str(content))
    assert [(e.path, e.type) for e in entries] == [
        ("CLAUDE.md", "file"), ("docs", "dir"), ("docs/guide.md", "file")]


def test_build_manifest_rejects_symlink_in_seed(tmp_path: Path):
    # 種子內含 symlink＝部署時可能沿它寫出目的 root，整份範本判為不可用
    content = _seed(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("x", encoding="utf-8")
    (content / "link.md").symlink_to(outside)
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.build_manifest_entries(str(content))


def test_build_manifest_rejects_non_regular_entries(tmp_path: Path):
    content = _seed(tmp_path)
    os.mkfifo(content / "pipe")          # 既非 file 也非 dir
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.build_manifest_entries(str(content))


def test_build_manifest_skips_the_manifest_file_itself(tmp_path: Path):
    content = _seed(tmp_path)
    (content / "CLAUDE.md").write_text("c", encoding="utf-8")
    _write_manifest(content, [{"path": "CLAUDE.md", "type": "file"}])
    assert [e.path for e in tp.build_manifest_entries(str(content))] == ["CLAUDE.md"]


def test_load_manifest_reads_the_shipped_file(tmp_path: Path):
    content = _seed(tmp_path)
    (content / "CLAUDE.md").write_text("c", encoding="utf-8")
    _write_manifest(content, [{"path": "CLAUDE.md", "type": "file"}])
    entries = tp.load_manifest("demo")
    assert [(e.path, e.type) for e in entries] == [("CLAUDE.md", "file")]


def test_load_manifest_rejects_escaping_paths(tmp_path: Path):
    # 載入端要獨立套拒絕規則：manifest 是隨 artifact 出貨的資料，不能只信產生端
    content = _seed(tmp_path)
    for bad in ("../evil.md", "/etc/passwd", "docs/../../evil.md"):
        _write_manifest(content, [{"path": bad, "type": "file"}])
        with pytest.raises(ValueError, match="template_unavailable"):
            tp.load_manifest("demo")


def test_load_manifest_rejects_dotdot_even_when_every_ancestor_is_declared(tmp_path: Path):
    # 路徑拒絕規則必須自成一道守衛：`..` 鏈的每一層都宣告成 dir 時，實體對帳（都存在、
    # 型別都相符）與祖先檢查（都宣告了）都會放行，載入端只剩這條規則能擋。放過的話
    # 部署端會沿 `..` 把檔案寫到目的地之外。
    content = _seed(tmp_path)
    (content / "docs").mkdir()
    (content.parent / "evil.md").write_text("x", encoding="utf-8")   # 種子根之外
    _write_manifest(content, [{"path": "docs", "type": "dir"},
                              {"path": "docs/..", "type": "dir"},
                              {"path": "docs/../..", "type": "dir"},
                              {"path": "docs/../../evil.md", "type": "file"}])
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")


def test_load_manifest_rejects_bad_type_and_broken_json(tmp_path: Path):
    content = _seed(tmp_path)
    _write_manifest(content, [{"path": "x", "type": "symlink"}])
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")
    (content / tp.MANIFEST_FILENAME).write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")


def test_load_manifest_rejects_declared_entry_that_is_a_symlink(tmp_path: Path):
    # 關鍵：manifest 把 symlink 宣告成 file，複製時 read_bytes 會跟過去把外部內容
    # 搬進部署結果。載入端必須自己 lstat 實體，不能只信 manifest 的宣告。
    content = _seed(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("HOST SECRET", encoding="utf-8")
    (content / "CLAUDE.md").symlink_to(outside)
    _write_manifest(content, [{"path": "CLAUDE.md", "type": "file"}])
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")


def test_load_manifest_rejects_declared_but_absent_or_mistyped(tmp_path: Path):
    content = _seed(tmp_path)
    (content / "CLAUDE.md").write_text("c", encoding="utf-8")
    _write_manifest(content, [{"path": "ghost.md", "type": "file"}])
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")                       # 宣告了但種子裡沒有
    _write_manifest(content, [{"path": "CLAUDE.md", "type": "dir"}])
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")                       # 宣告型別與實體不符


def test_load_manifest_rejects_duplicates_and_orphan_children(tmp_path: Path):
    content = _seed(tmp_path)
    (content / "docs").mkdir()
    (content / "docs" / "guide.md").write_text("g", encoding="utf-8")
    _write_manifest(content, [{"path": "docs", "type": "dir"},
                              {"path": "docs", "type": "dir"}])
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")                       # 重複 path
    _write_manifest(content, [{"path": "docs/guide.md", "type": "file"}])
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")                       # 子項的目錄祖先沒宣告


def test_load_manifest_normalises_to_parent_before_child(tmp_path: Path):
    # 順序不能靠輸入：child-before-parent 會讓 conflict 停 subtree 失效
    content = _seed(tmp_path)
    (content / "docs").mkdir()
    (content / "docs" / "guide.md").write_text("g", encoding="utf-8")
    (content / "CLAUDE.md").write_text("c", encoding="utf-8")
    _write_manifest(content, [{"path": "docs/guide.md", "type": "file"},
                              {"path": "docs", "type": "dir"},
                              {"path": "CLAUDE.md", "type": "file"}])
    assert [e.path for e in tp.load_manifest("demo")] == [
        "CLAUDE.md", "docs", "docs/guide.md"]


def test_load_manifest_rejects_empty_manifest(tmp_path: Path):
    # 空 manifest 會讓 _aggregate 的 all() 回 True 而報 complete——沒東西可部署
    # 卻宣稱「已完整安裝」。整份視為不可用。
    content = _seed(tmp_path)
    _write_manifest(content, [])
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")


def test_load_manifest_reports_unavailable_when_not_shipped(tmp_path: Path):
    _seed(tmp_path)                      # 建了根目錄但沒有 manifest
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.load_manifest("demo")

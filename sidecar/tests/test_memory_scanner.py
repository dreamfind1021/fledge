from pathlib import Path
from fledge_sidecar.memory.scanner import native_memory_files, kms_files, is_kms_file_allowed


def test_native_three_states(tmp_path, monkeypatch):
    # 造一個 account config_dir，三個 memory 目錄：matched / orphan / ambiguous
    cfg = tmp_path / ".claude"
    projs = cfg / "projects"
    # matched：對應已知專案 /work/fledge
    (projs / "-work-fledge" / "memory").mkdir(parents=True)
    (projs / "-work-fledge" / "memory" / "m.md").write_text("x", encoding="utf-8")
    # orphan：沒有已知專案 encode 命中
    (projs / "-gone-proj" / "memory").mkdir(parents=True)
    (projs / "-gone-proj" / "memory" / "m.md").write_text("x", encoding="utf-8")
    # ambiguous：兩個已知專案 encode 成同名 -work-a-b（/work/a/b 與 /work/a-b）
    (projs / "-work-a-b" / "memory").mkdir(parents=True)
    (projs / "-work-a-b" / "memory" / "m.md").write_text("x", encoding="utf-8")

    known = ["/work/fledge", "/work/a/b", "/work/a-b"]
    refs = native_memory_files(account="work", config_dir=cfg, known_projects=known)
    by_dir = {Path(r.path).parent.parent.name: r for r in refs}
    assert by_dir["-work-fledge"].attribution == "matched"
    assert by_dir["-work-fledge"].project == "/work/fledge"
    assert by_dir["-gone-proj"].attribution == "orphan"
    assert by_dir["-gone-proj"].project is None
    assert by_dir["-work-a-b"].attribution == "ambiguous"
    assert by_dir["-work-a-b"].project is None


def test_native_skips_MEMORY_md(tmp_path):
    cfg = tmp_path / ".claude"
    mem = cfg / "projects" / "-work-fledge" / "memory"
    mem.mkdir(parents=True)
    (mem / "MEMORY.md").write_text("index", encoding="utf-8")
    (mem / "real.md").write_text("x", encoding="utf-8")
    refs = native_memory_files(account="work", config_dir=cfg, known_projects=["/work/fledge"])
    names = {Path(r.path).name for r in refs}
    assert names == {"real.md"}              # MEMORY.md 不當 item


def test_kms_containment_and_symlink_escape(tmp_path):
    root = tmp_path / "kms"
    (root / "library").mkdir(parents=True)
    (root / "library" / "src.md").write_text("x", encoding="utf-8")
    (root / "topics").mkdir()
    (root / "topics" / "t.md").write_text("x", encoding="utf-8")
    (root / "_INDEX.md").write_text("skip", encoding="utf-8")   # 管理檔跳過
    (root / "CLAUDE.md").write_text("skip", encoding="utf-8")
    secret = tmp_path / "secret.md"; secret.write_text("LEAK", encoding="utf-8")
    (root / "escape.md").symlink_to(secret)                     # 逃逸 symlink

    refs = kms_files(str(root))
    names = {Path(r.path).name for r in refs}
    assert "src.md" in names and "t.md" in names
    assert "_INDEX.md" not in names and "CLAUDE.md" not in names
    assert "escape.md" not in names          # 不跟隨逃逸 symlink
    dom = {Path(r.path).name: r.domain for r in refs}
    assert dom["src.md"] == "library" and dom["t.md"] == "topics"


def test_kms_excludes_hidden_and_underscore_dirs_at_any_depth(tmp_path):
    """FIX 2：中間目錄為 hidden/`_前綴` 也要排除（不只 basename）。"""
    root = tmp_path / "kms"
    (root / "topics" / "_private").mkdir(parents=True)
    (root / "topics" / "_private" / "secret.md").write_text("LEAK", encoding="utf-8")
    (root / "library" / ".hidden").mkdir(parents=True)
    (root / "library" / ".hidden" / "x.md").write_text("LEAK", encoding="utf-8")
    (root / "topics" / "realfolder").mkdir(parents=True)
    (root / "topics" / "realfolder" / "x.md").write_text("ok", encoding="utf-8")

    refs = kms_files(str(root))
    paths = {r.path for r in refs}
    assert str(root / "topics" / "realfolder" / "x.md") in paths       # 正常巢狀仍收
    assert str(root / "topics" / "_private" / "secret.md") not in paths  # _ 目錄排除
    assert str(root / "library" / ".hidden" / "x.md") not in paths       # hidden 目錄排除

    # is_kms_file_allowed 直接斷言（route /item 也走同一 predicate）
    rootp = root.resolve()
    assert is_kms_file_allowed(root / "topics" / "realfolder" / "x.md", rootp) is True
    assert is_kms_file_allowed(root / "topics" / "_private" / "secret.md", rootp) is False
    assert is_kms_file_allowed(root / "library" / ".hidden" / "x.md", rootp) is False


def test_kms_none_root_returns_empty():
    assert kms_files(None) == []
    assert kms_files("") == []

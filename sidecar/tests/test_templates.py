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


def _demo_with_content(tmp_path: Path) -> Path:
    """建含 CLAUDE.md + docs/guide.md 的 demo 範本，manifest 由 build_manifest_entries 產生。"""
    content = _seed(tmp_path)
    (content / "docs").mkdir()
    (content / "docs" / "guide.md").write_text("guide", encoding="utf-8")
    (content / "CLAUDE.md").write_text("rules", encoding="utf-8")
    entries = tp.build_manifest_entries(str(content))
    _write_manifest(content, [{"path": e.path, "type": e.type} for e in entries])
    return content


def test_resolve_destination_expands_and_resolves(tmp_path: Path):
    dest = tmp_path / "work"
    dest.mkdir()
    assert tp.resolve_destination(str(dest)) == str(dest.resolve())


def test_resolve_destination_rejects_unusable_and_unsafe(tmp_path: Path, monkeypatch):
    for bad in ("", "   ", "relative/dir"):
        with pytest.raises(ValueError, match="invalid_destination"):
            tp.resolve_destination(bad)
    # 底線防呆（ADR-0001 取向）：目的地是 home 本身／home 祖先／根 → containment 形同不設防
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for bad in (str(home), str(tmp_path), "/"):
        with pytest.raises(ValueError, match="unsafe_destination"):
            tp.resolve_destination(bad)


def test_plan_reports_not_installed_on_empty_destination(tmp_path: Path):
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    p = tp.plan("demo", str(dest))
    assert p.template == "demo"
    assert p.destination == str(dest.resolve())
    assert p.state == "not_installed"
    assert [(o.path, o.state) for o in p.operations] == [
        ("CLAUDE.md", "missing"), ("docs", "missing"), ("docs/guide.md", "missing")]
    assert not any(dest.iterdir()), "預覽不得動檔案系統"


def test_plan_reports_partial_and_complete(tmp_path: Path):
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    (dest / "docs").mkdir(parents=True)
    (dest / "CLAUDE.md").write_text("我自己的版本", encoding="utf-8")
    p = tp.plan("demo", str(dest))
    by_path = {o.path: o.state for o in p.operations}
    assert by_path == {"CLAUDE.md": "present", "docs": "present", "docs/guide.md": "missing"}
    assert p.state == "partial"
    (dest / "docs" / "guide.md").write_text("g", encoding="utf-8")
    assert tp.plan("demo", str(dest)).state == "complete"


def test_plan_marks_type_mismatch_as_conflict_and_stops_subtree(tmp_path: Path):
    # manifest 說 docs 是目錄，目的地卻是檔案 → conflict，其下內容不再續報 missing
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "docs").write_text("其實是檔案", encoding="utf-8")
    p = tp.plan("demo", str(dest))
    by_path = {o.path: o.state for o in p.operations}
    assert by_path["docs"] == "conflict"
    assert by_path["docs/guide.md"] == "conflict"
    assert p.state == "conflict"


def test_plan_marks_symlink_destination_entry_as_conflict(tmp_path: Path):
    # 目的地既有 symlink：即使指向型別正確的東西也不接受——寫下去就是沿它寫出 root
    _demo_with_content(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "docs").symlink_to(outside)
    p = tp.plan("demo", str(dest))
    by_path = {o.path: o.state for o in p.operations}
    assert by_path["docs"] == "conflict"
    assert by_path["docs/guide.md"] == "conflict"


def test_probe_entry_treats_an_escaping_parent_as_conflict(tmp_path: Path):
    # probe_entry 是公開接縫，必須自己守父目錄 containment：plan 的 blocked-subtree
    # 已擋下 symlink 父項，但單獨呼叫（或未來新增呼叫端）時沒有那層保護，
    # 而 lexists/isfile 都會跟過 symlink 判成 present。
    _demo_with_content(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "guide.md").write_text("外面的檔案", encoding="utf-8")
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "docs").symlink_to(outside)
    entry = tp.ManifestEntry("docs/guide.md", "file")
    assert tp.probe_entry(str(dest), entry) == "conflict"


def test_plan_does_not_block_a_sibling_sharing_the_conflicting_dir_prefix(tmp_path: Path):
    # blocked ancestry 要逐元件上溯：字串 prefix 比對會讓 docs2/ 被 docs 誤命中，
    # 整個無關的 subtree 被誤報 conflict 而永遠部署不出來
    content = _seed(tmp_path)
    (content / "docs").mkdir()
    (content / "docs" / "guide.md").write_text("g", encoding="utf-8")
    (content / "docs2").mkdir()
    (content / "docs2" / "note.md").write_text("n", encoding="utf-8")
    entries = tp.build_manifest_entries(str(content))
    _write_manifest(content, [{"path": e.path, "type": e.type} for e in entries])
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "docs").write_text("其實是檔案", encoding="utf-8")
    by_path = {o.path: o.state for o in tp.plan("demo", str(dest)).operations}
    assert by_path["docs"] == "conflict"
    assert by_path["docs/guide.md"] == "conflict"
    assert by_path["docs2"] == "missing"
    assert by_path["docs2/note.md"] == "missing"


def test_plan_rejects_unknown_template_and_unavailable(tmp_path: Path):
    _seed(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    with pytest.raises(ValueError, match="unknown_template"):
        tp.plan("ghost", str(dest))
    with pytest.raises(ValueError, match="template_unavailable"):
        tp.plan("demo", str(dest))       # 根目錄在但沒有 manifest


def test_deploy_creates_dirs_and_files(tmp_path: Path):
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    res = tp.deploy("demo", str(dest))
    assert {r.path: r.outcome for r in res.results} == {
        "CLAUDE.md": "created", "docs": "created", "docs/guide.md": "created"}
    assert (dest / "CLAUDE.md").read_text(encoding="utf-8") == "rules"
    assert (dest / "docs" / "guide.md").read_text(encoding="utf-8") == "guide"
    assert not (dest / "CLAUDE.md").is_symlink()


def test_deploy_never_overwrites_existing_content(tmp_path: Path):
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "CLAUDE.md").write_text("我改過的版本", encoding="utf-8")
    res = tp.deploy("demo", str(dest))
    by_path = {r.path: r.outcome for r in res.results}
    assert by_path["CLAUDE.md"] == "skipped"
    assert (dest / "CLAUDE.md").read_text(encoding="utf-8") == "我改過的版本"
    assert by_path["docs/guide.md"] == "created"     # 其餘照補（partial → complete）


def test_deploy_creates_the_destination_last_level_only(tmp_path: Path):
    # 只建最後一層：父目錄不存在多半是路徑打錯，不遞建一串垃圾目錄
    _demo_with_content(tmp_path)
    ok = tmp_path / "not-yet"
    assert tp.deploy("demo", str(ok)).results[0].outcome == "created"
    assert (ok / "CLAUDE.md").exists()
    bad = tmp_path / "no" / "such" / "parent"
    res = tp.deploy("demo", str(bad))
    assert {r.outcome for r in res.results} == {"failed"}
    assert not bad.exists()


def test_deploy_refuses_conflicting_subtree_and_keeps_going(tmp_path: Path):
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "docs").write_text("其實是檔案", encoding="utf-8")
    res = tp.deploy("demo", str(dest))
    by_path = {r.path: r.outcome for r in res.results}
    assert by_path["docs"] == "conflict"
    assert by_path["docs/guide.md"] == "conflict"
    assert by_path["CLAUDE.md"] == "created"          # 逐項盡力：不相干的項目照做
    assert (dest / "docs").read_text(encoding="utf-8") == "其實是檔案"


def test_deploy_does_not_write_through_a_symlinked_directory(tmp_path: Path):
    # 目的地的 docs 是指向 root 外的 symlink：不得沿它把 guide.md 寫到外面
    _demo_with_content(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "docs").symlink_to(outside)
    res = tp.deploy("demo", str(dest))
    by_path = {r.path: r.outcome for r in res.results}
    assert by_path["docs"] == "conflict"
    assert by_path["docs/guide.md"] == "conflict"
    assert not (outside / "guide.md").exists(), "不得寫出目的地之外"


def test_deploy_recomputes_and_skips_what_appeared_before_it_ran(tmp_path: Path):
    # 呼叫端拿到的預覽可能已過時：deploy 自己重算，看到 present 就跳過（不覆蓋）
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    p = tp.plan("demo", str(dest))
    assert {o.state for o in p.operations} == {"missing"}
    (dest / "CLAUDE.md").write_text("在預覽之後冒出來", encoding="utf-8")
    by_path = {r.path: r.outcome for r in tp.deploy("demo", str(dest)).results}
    assert by_path["CLAUDE.md"] == "skipped"
    assert (dest / "CLAUDE.md").read_text(encoding="utf-8") == "在預覽之後冒出來"


def test_deploy_skips_what_appeared_between_recompute_and_write(tmp_path: Path):
    # 真正的 TOCTOU 窗口在 deploy 內部：重算 plan 之後、寫入前重探之間。
    # 用呼叫次數感知的 monkeypatch 製造——重探當下檔案已冒出來，實作看到 present
    # 就跳過（**不是** stale：present 分支在 state != op.state 之前）。
    # 移除「寫入前重探」的 mutant 必須被這支殺死。
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    real_probe_at = tp._probe_at
    calls = {"n": 0}

    def _probe_then_swap(parent_fd, name, entry_type):
        if name == "CLAUDE.md":
            calls["n"] += 1
            if calls["n"] == 1:      # deploy 寫入前的第一次重探：先讓檔案冒出來
                (dest / "CLAUDE.md").write_text("競態中冒出來", encoding="utf-8")
        return real_probe_at(parent_fd, name, entry_type)

    monkeypatch_target = tp
    original = monkeypatch_target._probe_at
    monkeypatch_target._probe_at = _probe_then_swap
    try:
        by_path = {r.path: r.outcome for r in tp.deploy("demo", str(dest)).results}
    finally:
        monkeypatch_target._probe_at = original
    # 重探看到 present（與重算的 missing 不符）→ 跳過，且絕不覆蓋競態中冒出的內容
    assert by_path["CLAUDE.md"] == "skipped"
    assert (dest / "CLAUDE.md").read_text(encoding="utf-8") == "競態中冒出來"


def test_deploy_treats_every_wrong_destination_type_as_conflict(tmp_path: Path):
    # 既有型別不符的各種形態都必須是 conflict，且原物不得被動到
    _demo_with_content(tmp_path)
    cases = {
        "broken_symlink": lambda p: p.symlink_to(tmp_path / "gone"),
        "symlink_to_file": lambda p: p.symlink_to(_existing_file(tmp_path)),
        "fifo": lambda p: os.mkfifo(p),
        "directory": lambda p: p.mkdir(),
    }
    for name, make in cases.items():
        dest = tmp_path / f"work-{name}"
        dest.mkdir()
        make(dest / "CLAUDE.md")        # manifest 說 CLAUDE.md 是檔案
        by_path = {r.path: r.outcome for r in tp.deploy("demo", str(dest)).results}
        assert by_path["CLAUDE.md"] == "conflict", name
    # 反向：manifest 說 docs 是目錄，目的地放一個檔案
    dest = tmp_path / "work-dir-as-file"
    dest.mkdir()
    (dest / "docs").write_text("其實是檔案", encoding="utf-8")
    by_path = {r.path: r.outcome for r in tp.deploy("demo", str(dest)).results}
    assert by_path["docs"] == "conflict"
    assert by_path["docs/guide.md"] == "conflict"


def _existing_file(tmp_path: Path) -> Path:
    target = tmp_path / "some-real-file.md"
    if not target.exists():
        target.write_text("real", encoding="utf-8")
    return target


def test_deploy_marks_stale_when_a_present_entry_disappears_before_the_write(tmp_path: Path,
                                                                            monkeypatch):
    # `stale` 的可達路徑：plan 看到 present（本來要 skip），使用者在寫入前重探之前
    # 把它刪掉 → 重探回 missing ≠ op.state（present）→ stale，該項不動。
    # 這是 apply-time revalidation 契約裡唯一產生 stale 的轉換，必須有測試釘住。
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "CLAUDE.md").write_text("使用者自己的", encoding="utf-8")
    real_probe_at = tp._probe_at

    def _delete_between(parent_fd, name, entry_type):
        if name == "CLAUDE.md" and (dest / "CLAUDE.md").exists():
            (dest / "CLAUDE.md").unlink()
        return real_probe_at(parent_fd, name, entry_type)

    monkeypatch.setattr(tp, "_probe_at", _delete_between)
    by_path = {r.path: r.outcome for r in tp.deploy("demo", str(dest)).results}
    assert by_path["CLAUDE.md"] == "stale"
    assert not (dest / "CLAUDE.md").exists(), "stale 代表不動，不得順手補建"


def test_deploy_handles_deep_nesting_and_blocks_whole_subtrees(tmp_path: Path):
    # 兩層樹測不出 fd 簿記與 blocked ancestry 在深度下的行為：中層 conflict 時
    # **孫層**也要擋、中層已存在時孫層仍要補齊、兄弟分支都不受影響。
    src = tmp_path / "templates" / "demo"
    for rel in ("docs/guides/advanced/deep.md", "docs/guides/basic.md", "docs/README.md",
                "scripts/tools/helper.sh", "CLAUDE.md"):
        target = src / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"content:{rel}", encoding="utf-8")
    os.environ["FLEDGE_TEMPLATES_DIR"] = str(tmp_path / "templates")
    tp._SPEC_BY_ID.setdefault("demo", tp.TemplateSpec("demo", "Demo", "測試用", "public"))
    entries = tp.build_manifest_entries(str(src))
    (src / tp.MANIFEST_FILENAME).write_text(
        json.dumps({"entries": [{"path": e.path, "type": e.type} for e in entries]}),
        encoding="utf-8")

    # ① 全新目的地：整棵四層樹一次建完
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    assert {r.outcome for r in tp.deploy("demo", str(fresh)).results} == {"created"}
    assert (fresh / "docs/guides/advanced/deep.md").read_text(encoding="utf-8") == \
        "content:docs/guides/advanced/deep.md"

    # ② 中層已存在：該層 skipped，孫層仍補齊，使用者自己的檔案不動
    partial = tmp_path / "partial"
    (partial / "docs" / "guides").mkdir(parents=True)
    (partial / "docs" / "README.md").write_text("我自己的", encoding="utf-8")
    by_path = {r.path: r.outcome for r in tp.deploy("demo", str(partial)).results}
    assert by_path["docs/guides"] == "skipped"
    assert by_path["docs/README.md"] == "skipped"
    assert by_path["docs/guides/advanced/deep.md"] == "created"
    assert (partial / "docs" / "README.md").read_text(encoding="utf-8") == "我自己的"

    # ③ 中層 conflict：整個 subtree（含孫層）擋下，兄弟分支照做
    blocked = tmp_path / "blocked"
    (blocked / "docs").mkdir(parents=True)
    (blocked / "docs" / "guides").write_text("其實是檔案", encoding="utf-8")
    by_path = {r.path: r.outcome for r in tp.deploy("demo", str(blocked)).results}
    for path in ("docs/guides", "docs/guides/basic.md",
                 "docs/guides/advanced", "docs/guides/advanced/deep.md"):
        assert by_path[path] == "conflict", path
    assert by_path["scripts/tools/helper.sh"] == "created"
    assert by_path["CLAUDE.md"] == "created"


def test_deploy_aborts_when_an_ancestor_of_the_destination_is_swapped(tmp_path: Path,
                                                                     monkeypatch):
    # root 取得本身仍會重新解析祖先路徑（O_NOFOLLOW 只保護最後一個元件）。
    # 目的地在 plan 當時已存在時，身分比對擋得住：開到的 root 不是當初核准的那個
    # inode → 全數 failed，兩棵樹都不得被寫入。
    _demo_with_content(tmp_path)
    parent = tmp_path / "safe"
    dest = parent / "work"
    dest.mkdir(parents=True)
    outside = tmp_path / "outside"
    (outside / "work").mkdir(parents=True)
    real_mkdir = Path.mkdir
    fired: list[int] = []

    def _swap_ancestor(self, *args, **kwargs):
        if str(self) == str(dest.resolve()) and not fired:
            fired.append(1)
            parent.rename(tmp_path / "safe-real")
            (tmp_path / "safe").symlink_to(outside)
        return real_mkdir(self, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", _swap_ancestor)
    res = tp.deploy("demo", str(dest))
    assert fired, "測試鉤子沒觸發（注意 tmp_path 與 resolve 後路徑是否一致）"
    assert {r.outcome for r in res.results} == {"failed"}
    assert {r.error for r in res.results} == {"destination_moved"}
    assert not (outside / "work" / "CLAUDE.md").exists(), "不得寫進被掉包的那棵樹"
    assert not (tmp_path / "safe-real" / "work" / "CLAUDE.md").exists()


def test_deploy_fails_safely_when_dir_is_swapped_before_the_fd_is_taken(tmp_path: Path,
                                                                       monkeypatch):
    # 競態 A：docs/ 建好之後、我們拿到它的 fd 之前被換成指向外部的 symlink。
    # 此時 O_DIRECTORY|O_NOFOLLOW 開不起來（macOS 回 ENOTDIR）→ 該項 failed、
    # 其下 conflict。重點是**什麼都不能寫到目的地之外**。
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    real_mkdir = os.mkdir

    def _mkdir_then_swap(name, *args, **kwargs):
        real_mkdir(name, *args, **kwargs)
        if name == "docs":
            (dest / "docs").rename(dest / "docs-real")
            (dest / "docs").symlink_to(outside)

    monkeypatch.setattr(tp.os, "mkdir", _mkdir_then_swap)
    by_path = {r.path: r for r in tp.deploy("demo", str(dest)).results}
    assert by_path["docs"].outcome == "failed"
    assert by_path["docs"].error == "not_a_directory"
    assert by_path["docs/guide.md"].outcome == "conflict"
    assert not (outside / "guide.md").exists(), "不得沿抽換後的 symlink 寫出目的地"


def test_deploy_writes_into_the_pinned_inode_when_dir_is_swapped_after(tmp_path: Path,
                                                                      monkeypatch):
    # 競態 B：我們已經持有 docs/ 的 fd 之後才被抽換。這正是釘住 fd 買到的東西——
    # 後續寫入綁的是 inode 不是路徑，落在原本那個目錄裡，外面依然什麼都沒有。
    # 拿掉 dir_fd 改回路徑寫入的 mutant，必須被這支殺死。
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    real_open_child = tp._open_child_dir

    def _open_then_swap(name, parent_fd):
        fd = real_open_child(name, parent_fd)
        if name == "docs":
            (dest / "docs").rename(dest / "docs-real")
            (dest / "docs").symlink_to(outside)
        return fd

    monkeypatch.setattr(tp, "_open_child_dir", _open_then_swap)
    by_path = {r.path: r.outcome for r in tp.deploy("demo", str(dest)).results}
    assert by_path["docs/guide.md"] == "created"
    assert not (outside / "guide.md").exists(), "不得寫出目的地之外"
    assert (dest / "docs-real" / "guide.md").exists(), "應寫進當初釘住的那個 inode"


def test_deploy_reports_stable_error_codes(tmp_path: Path, monkeypatch):
    import errno as errno_mod
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()

    # 簽名必須吃得下 dir_fd：production 呼叫帶 dir_fd=parent_fd，
    # 少了關鍵字參數會先炸 TypeError，而 deploy 只捕 OSError → 測試直接崩潰而非通過
    def _denied(source, target, **kwargs):
        raise PermissionError(errno_mod.EACCES, "Permission denied")

    monkeypatch.setattr(tp.safe_fs, "copy_file_no_clobber", _denied)
    res = tp.deploy("demo", str(dest))
    claude = next(r for r in res.results if r.path == "CLAUDE.md")
    assert claude.outcome == "failed"
    assert claude.error == "permission_denied"
    assert "/" not in (claude.error or ""), "判別碼不得夾帶路徑"


def test_deploy_logs_outcomes(tmp_path: Path, caplog):
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    dest.mkdir()
    (dest / "docs").write_text("其實是檔案", encoding="utf-8")
    with caplog.at_level("INFO", logger=tp.__name__):
        tp.deploy("demo", str(dest))
    assert any(r.levelname == "INFO" for r in caplog.records)
    assert any(r.levelname == "WARNING" and "conflict" in r.getMessage()
               for r in caplog.records)


def test_repo_public_seed_manifest_matches_its_content():
    # committed manifest 與實際內容脫節時，出貨的範本就會漏檔或多檔——這裡擋住 drift
    import json as _json

    root = Path(tp.templates_root()) / "project-starter"
    assert root.is_dir(), "repo 內的 public seed 必須存在"
    committed = _json.loads((root / tp.MANIFEST_FILENAME).read_text(encoding="utf-8"))
    generated = [{"path": e.path, "type": e.type}
                 for e in tp.build_manifest_entries(str(root))]
    assert committed["entries"] == generated


def test_deploy_blocks_the_subtree_when_an_existing_dir_cannot_be_opened(tmp_path: Path,
                                                                        monkeypatch):
    # 既有目錄被判 skipped，但取 fd 失敗（權限／fd 用盡／抽換）時，其下必須整片停手。
    # 這靠兩層守衛組合：present 分支的 except OSError → blocked，以及後代處理前的
    # `parent_rel not in open_dirs`。原本只有「新建目錄後開 fd 失敗」被測到。
    _demo_with_content(tmp_path)
    dest = tmp_path / "work"
    (dest / "docs").mkdir(parents=True)          # 目的地已有 docs（會走 present→skipped）
    real_open_child = tp._open_child_dir

    def _fail_for_docs(name, parent_fd):
        if name == "docs":
            raise PermissionError(13, "Permission denied")
        return real_open_child(name, parent_fd)

    monkeypatch.setattr(tp, "_open_child_dir", _fail_for_docs)
    by_path = {r.path: r.outcome for r in tp.deploy("demo", str(dest)).results}
    assert by_path["docs"] == "skipped"           # 目錄本來就在，不是失敗
    assert by_path["docs/guide.md"] == "conflict"  # 但其下不得嘗試寫入
    assert not (dest / "docs" / "guide.md").exists()
    assert by_path["CLAUDE.md"] == "created"     # 逐項盡力：不相干的項目照做

from pathlib import Path
from fledge_sidecar.memory.parser import parse_doc, ParsedDoc


def _write(tmp_path, name, text):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def test_parse_frontmatter_and_links(tmp_path):
    p = _write(tmp_path, "a.md", """---
name: fledge-foo
description: 一句話摘要
type: project
tags: [Garden-Planner, 園藝]
---

本文內容，連到 [[other-name]] 與 [[second]]。
""")
    d = parse_doc(p)
    assert isinstance(d, ParsedDoc)
    assert d.title == "fledge-foo"          # name 優先
    assert d.summary == "一句話摘要"          # description→summary
    assert d.type == "project"
    assert d.tags == ("Garden-Planner", "園藝")
    assert d.links == ("other-name", "second")
    assert "本文內容" in d.body


def test_title_fallback_to_filename(tmp_path):
    p = _write(tmp_path, "no-front.md", "純內文，無 frontmatter")
    d = parse_doc(p)
    assert d.title == "no-front"             # 無 name/title → 檔名
    assert d.type == ""
    assert d.links == ()


def test_malformed_never_raises(tmp_path):
    p = _write(tmp_path, "bad.md", "---\n: : broken\ntags: [unclosed\n---\nbody")
    d = parse_doc(p)                          # 不得 raise
    assert d is not None and "body" in d.body


def test_wikilink_alias_drops_display_text(tmp_path):
    p = _write(tmp_path, "alias.md", "見 [[note-name|別名]] 與 [[plain]]。")
    d = parse_doc(p)
    assert d.links == ("note-name", "plain")  # alias 顯示文字捨棄、只留 target


def test_missing_file_returns_none(tmp_path):
    assert parse_doc(tmp_path / "ghost.md") is None  # 缺檔→None（OSError 契約）

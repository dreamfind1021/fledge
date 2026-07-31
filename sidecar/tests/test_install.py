"""`backup/install.py` 的行為契約。

**全程假 HOME + tmp_path，絕不碰真實的 ~/.claude。** 這個模組是唯一有能力寫現役目錄的
還原路徑，測試自己更要守住同一條線。
"""
import os
from pathlib import Path

import pytest
from conftest import make_staging as _staging

from fledge_sidecar.backup import install as inst


def _accounts(target: Path) -> dict[str, dict[str, str]]:
    return {"work": {"config_dir": str(target), "label": ""}}


def test_plan_counts_what_will_be_installed(tmp_path: Path):
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    assert p.targets == {"work": str(tgt.resolve())}
    assert p.will_install == 2          # skills/a.md 與 CLAUDE.md
    assert p.will_skip == []


def test_plan_lists_existing_targets_as_skip(tmp_path: Path):
    """現役已有的不會被覆蓋——plan 階段就要說得出來，不能等 install 才發現。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    (tgt / "CLAUDE.md").write_text("MINE", encoding="utf-8")
    p = inst.plan(str(src), _accounts(tgt))
    assert p.will_skip == ["CLAUDE.md"]
    assert p.will_install == 1


def test_plan_excludes_claude_json(tmp_path: Path):
    """.claude.json 混著真資產、機器身分與快取，一律不碰（spec 決策 3）。"""
    src = _staging(tmp_path)
    (src / "accounts" / "work" / ".claude.json").write_text("{}", encoding="utf-8")
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    assert ".claude.json" in p.excluded
    assert p.will_install == 2          # 沒把它算進去


def test_plan_refuses_source_without_manifest(tmp_path: Path):
    """來源必須是我們展開的目錄，不對任意目錄執行搬移。"""
    bare = tmp_path / "bare"
    bare.mkdir()
    with pytest.raises(ValueError, match="source_not_a_bundle"):
        inst.plan(str(bare), _accounts(tmp_path / "live"))


def test_plan_refuses_config_dir_at_home_or_above(tmp_path: Path, monkeypatch):
    """底線防呆（ADR-0001）：config_dir 是 home 本身或祖先時 containment 形同不設防。"""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    src = _staging(tmp_path)
    for bad in (str(home), str(tmp_path), "/"):
        with pytest.raises(ValueError, match="unsafe_config_dir"):
            inst.plan(str(src), {"work": {"config_dir": bad, "label": ""}})


def test_install_copies_files_into_empty_target(tmp_path: Path):
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert {r.outcome for r in results} == {"installed"}
    assert (tgt / "skills" / "a.md").read_text(encoding="utf-8") == "SKILL"
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"


def test_install_never_overwrites_existing(tmp_path: Path):
    """現役內容必須逐位元組不變——這是整個功能的核心保證。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    (tgt / "CLAUDE.md").write_text("MINE", encoding="utf-8")
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "MINE"
    assert any(r.rel_path == "CLAUDE.md" and r.outcome == "skipped" for r in results)


def test_install_is_idempotent(tmp_path: Path):
    """重跑：已裝的判 skipped，現役目錄零變化。中斷續作完全靠這個性質。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    inst.install(inst.plan(str(src), _accounts(tgt)))
    before = {p: p.read_bytes() for p in tgt.rglob("*") if p.is_file()}
    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert {r.outcome for r in results} == {"skipped"}
    assert {p: p.read_bytes() for p in tgt.rglob("*") if p.is_file()} == before


def test_install_stops_when_source_root_swapped_after_plan(tmp_path: Path):
    """plan 到 install 之間 staging 被換掉 → 整批停手，不是跳過單項。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()
    p = inst.plan(str(src), _accounts(tgt))
    impostor = _staging(tmp_path / "other")
    os.rename(src, tmp_path / "moved-away")
    os.rename(impostor, src)
    with pytest.raises(ValueError, match="source_root_moved"):
        inst.install(p)
    assert list(tgt.iterdir()) == []          # 一個檔案都沒寫


def test_install_does_not_follow_symlinked_subdir_out_of_staging(tmp_path: Path):
    """惡意 bundle：staging 內的子目錄是指向外面的 symlink → 不得跟隨、不得寫出去。"""
    src = _staging(tmp_path)
    outside = tmp_path / "outside"
    (outside / "secret").mkdir(parents=True)
    (outside / "secret" / "x.md").write_text("SECRET", encoding="utf-8")
    (src / "accounts" / "work" / "escaped").symlink_to(outside / "secret")
    tgt = tmp_path / "live"
    tgt.mkdir()
    inst.install(inst.plan(str(src), _accounts(tgt)))
    assert not (tgt / "escaped" / "x.md").exists()

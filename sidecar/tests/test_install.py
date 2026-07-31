"""`backup/install.py` 的行為契約。

**全程假 HOME + tmp_path，絕不碰真實的 ~/.claude。** 這個模組是唯一有能力寫現役目錄的
還原路徑，測試自己更要守住同一條線。
"""
import json
from pathlib import Path

import pytest

from fledge_sidecar.backup import install as inst


def _staging(tmp_path: Path, *, home: str = "/Users/olduser") -> Path:
    """造一份最小的展開目錄（含 manifest），比照 backup-claude.sh 的產出佈局。"""
    root = tmp_path / "staging"
    (root / "accounts" / "work" / "skills").mkdir(parents=True)
    (root / "accounts" / "work" / "skills" / "a.md").write_text("SKILL", encoding="utf-8")
    (root / "accounts" / "work" / "CLAUDE.md").write_text("RULES", encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps({
        "format": 1,
        "created": "20260731-1200",
        "host": "old-mac",
        "home": home,
        "accounts": {"work": f"{home}/.claude"},
        "extra": {},
        "excludes_credentials": True,
    }), encoding="utf-8")
    return root


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

import json
import os
import time
from pathlib import Path

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.usage.scanner import claude_files, codex_files


def _config_with_accounts(tmp_path: Path, dirs: dict[str, str]) -> AppConfig:
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "version": 1, "roots": [], "manual_projects": [], "project_overrides": {},
        "ui": {}, "accounts": {k: {"config_dir": v, "label": k} for k, v in dirs.items()},
    }), encoding="utf-8")
    return AppConfig.load(cfg_path)


def test_claude_files_dedups_symlinked_config_dirs(tmp_path: Path):
    real = tmp_path / "claude-a" / "projects" / "-p-x"
    real.mkdir(parents=True)
    (real / "s1.jsonl").write_text("{}", encoding="utf-8")
    (real / "s1" / "subagents").mkdir(parents=True)
    (real / "s1" / "subagents" / "w.jsonl").write_text("{}", encoding="utf-8")
    link = tmp_path / "claude-b"
    os.symlink(tmp_path / "claude-a", link)  # 兩帳號指向同一實體（~/.claude-tc 情境）
    cfg = _config_with_accounts(tmp_path, {"a": str(tmp_path / "claude-a"), "b": str(link)})
    files = claude_files(cfg)
    assert sorted(p.name for p in files) == ["s1.jsonl", "w.jsonl"]  # 不重複、含 subagents


def test_claude_files_missing_dir_is_empty(tmp_path: Path):
    cfg = _config_with_accounts(tmp_path, {"a": str(tmp_path / "nope")})
    assert claude_files(cfg) == []


def _rollout(dirpath: Path, name: str, session_id: str, n_lines: int, mtime: float):
    dirpath.mkdir(parents=True, exist_ok=True)
    f = dirpath / name
    lines = [json.dumps({"type": "session_meta", "payload": {"id": session_id, "cwd": "/p"}})]
    lines += [json.dumps({"type": "noise"})] * (n_lines - 1)
    f.write_text("\n".join(lines), encoding="utf-8")
    os.utime(f, (mtime, mtime))
    return f


def test_codex_canonical_selection_prefers_active_then_mtime(tmp_path: Path):
    home = tmp_path / ".codex"
    t = time.time()
    f_arch = _rollout(home / "archived_sessions" / "2026/05/01", "rollout-a.jsonl", "S", 5, t)
    f_act = _rollout(home / "sessions" / "2026/05/01", "rollout-b.jsonl", "S", 3, t - 100)
    f_other = _rollout(home / "sessions" / "2026/05/02", "rollout-c.jsonl", "T", 2, t)
    files = codex_files(home)
    names = sorted(p.name for p in files)
    # 同 session S：active 贏（即使 archived 較新、行數較多）；T 正常入列
    assert names == ["rollout-b.jsonl", "rollout-c.jsonl"]


def test_codex_missing_home_is_empty(tmp_path: Path):
    assert codex_files(tmp_path / "no-codex") == []


def test_codex_same_bucket_mtime_then_size_tiers(tmp_path: Path):
    home = tmp_path / ".codex"
    t = time.time()
    # 同在 sessions/：mtime 新者勝
    _rollout(home / "sessions" / "a", "rollout-old.jsonl", "M", 5, t - 50)
    f_new = _rollout(home / "sessions" / "b", "rollout-new.jsonl", "M", 2, t)
    # 同 mtime：size 大者勝
    f_big = _rollout(home / "sessions" / "c", "rollout-big.jsonl", "Z", 9, t)
    f_small = _rollout(home / "sessions" / "d", "rollout-small.jsonl", "Z", 2, t)
    os.utime(f_big, (t, t)); os.utime(f_small, (t, t))
    names = sorted(p.name for p in codex_files(home))
    assert "rollout-new.jsonl" in names and "rollout-old.jsonl" not in names
    assert "rollout-big.jsonl" in names and "rollout-small.jsonl" not in names


def test_codex_unreadable_meta_still_listed_as_own_group(tmp_path: Path):
    home = tmp_path / ".codex"
    d = home / "sessions" / "x"
    d.mkdir(parents=True)
    f = d / "rollout-broken.jsonl"
    f.write_text("not-json-first-line\n", encoding="utf-8")  # 無 session_meta → realpath 自成一組
    assert [p.name for p in codex_files(home)] == ["rollout-broken.jsonl"]


def test_claude_account_map_maps_realpath_to_account_key(tmp_path):
    from fledge_sidecar.app_config import AppConfig
    from fledge_sidecar.usage.scanner import claude_account_map, claude_files
    work = tmp_path / "work" / "projects" / "p"
    personal = tmp_path / "personal" / "projects" / "p"
    work.mkdir(parents=True); personal.mkdir(parents=True)
    (work / "a.jsonl").write_text("{}\n")
    (personal / "b.jsonl").write_text("{}\n")
    cfg = AppConfig(path=tmp_path / "config.json", accounts={
        "work": {"config_dir": str(tmp_path / "work"), "label": "工作"},
        "personal": {"config_dir": str(tmp_path / "personal"), "label": "私人"},
    })
    m = claude_account_map(cfg)
    assert m[str((work / "a.jsonl").resolve())] == "work"
    assert m[str((personal / "b.jsonl").resolve())] == "personal"
    # claude_files 仍回 sorted 去重清單
    assert claude_files(cfg) == sorted([(work / "a.jsonl").resolve(),
                                        (personal / "b.jsonl").resolve()])


def test_claude_account_map_prefers_canonical_real_dir_over_symlink_alias(tmp_path):
    # z_acct 的 config_dir 是真實目錄、a_acct 是 symlink alias → 同一 realpath。
    # 歸屬須給「正規擁有者」z_acct（真實目錄），即使 a_acct 字母序較小。
    from fledge_sidecar.app_config import AppConfig
    from fledge_sidecar.usage.scanner import claude_account_map
    real = tmp_path / "real" / "projects" / "p"
    real.mkdir(parents=True)
    (real / "x.jsonl").write_text("{}\n")
    alias = tmp_path / "alias"
    alias.symlink_to(tmp_path / "real")
    cfg = AppConfig(path=tmp_path / "config.json", accounts={
        "z_acct": {"config_dir": str(tmp_path / "real"), "label": "Z"},
        "a_acct": {"config_dir": str(alias), "label": "A"},
    })
    m = claude_account_map(cfg)
    assert m[str((real / "x.jsonl").resolve())] == "z_acct"   # 真實目錄帳號勝


def test_claude_account_map_subdir_projects_symlink_attributes_to_real_dir(tmp_path):
    # 重現使用者情境：work=~/.claude（真實目錄），personal=~/.claude-tc（真實目錄，但其
    # projects/ 是 symlink → work 的 projects/，為了切帳號 resume 共用對話歷史）。
    # 共享同一份 jsonl，歸屬須給真實目錄帳號 work，不是字母序較小的 personal。
    from fledge_sidecar.app_config import AppConfig
    from fledge_sidecar.usage.scanner import claude_account_map
    work_cfg = tmp_path / "claude"
    work_proj = work_cfg / "projects" / "-p"
    work_proj.mkdir(parents=True)
    (work_proj / "s.jsonl").write_text("{}\n")
    personal_cfg = tmp_path / "claude-tc"
    personal_cfg.mkdir()
    (personal_cfg / "projects").symlink_to(work_cfg / "projects")   # 子目錄 symlink
    cfg = AppConfig(path=tmp_path / "config.json", accounts={
        "work": {"config_dir": str(work_cfg), "label": "工作"},
        "personal": {"config_dir": str(personal_cfg), "label": "私人"},
    })
    m = claude_account_map(cfg)
    assert m[str((work_proj / "s.jsonl").resolve())] == "work"   # 真實目錄帳號勝（修正前會錯給 personal）


def test_claude_account_map_tiebreak_by_key_when_no_canonical_owner(tmp_path):
    # 兩帳號的 config_dir 都是 symlink alias 指向同一真實目錄（無人正規擁有）
    # → 退回 account_key 排序取第一（deterministic、不依 dict 序），a_acct 勝。
    from fledge_sidecar.app_config import AppConfig
    from fledge_sidecar.usage.scanner import claude_account_map
    real = tmp_path / "real" / "projects" / "p"
    real.mkdir(parents=True)
    (real / "x.jsonl").write_text("{}\n")
    alias_a = tmp_path / "alias_a"
    alias_b = tmp_path / "alias_b"
    alias_a.symlink_to(tmp_path / "real")
    alias_b.symlink_to(tmp_path / "real")
    cfg = AppConfig(path=tmp_path / "config.json", accounts={
        "z_acct": {"config_dir": str(alias_b), "label": "Z"},
        "a_acct": {"config_dir": str(alias_a), "label": "A"},
    })
    m = claude_account_map(cfg)
    assert m[str((real / "x.jsonl").resolve())] == "a_acct"   # 皆 alias → key 最小勝

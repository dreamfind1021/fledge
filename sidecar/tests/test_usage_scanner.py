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

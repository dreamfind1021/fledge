import json
import os
import time
from pathlib import Path

import pytest

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.usage.scanner import (claude_files, codex_config_model, codex_files, pi_files, pi_home,
                                          pi_session_header)


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


def test_claude_account_map_canonical_robust_to_ancestor_symlink(tmp_path):
    # 祖先路徑含 symlink（如 macOS /var→/private/var、symlinked HOME）不應讓真實目錄帳號
    # 被誤判成 alias。canonical 判定須在 config_dir/projects 層比較（吸收祖先 symlink）。
    from fledge_sidecar.app_config import AppConfig
    from fledge_sidecar.usage.scanner import claude_account_map
    real_root = tmp_path / "realroot"
    work_proj = real_root / "claude" / "projects" / "-p"
    work_proj.mkdir(parents=True)
    (work_proj / "s.jsonl").write_text("{}\n")
    personal_cfg = real_root / "claude-tc"
    personal_cfg.mkdir()
    (personal_cfg / "projects").symlink_to(real_root / "claude" / "projects")
    # 透過 symlink 祖先存取 config_dir（模擬 /var symlink）
    link_root = tmp_path / "linkroot"
    link_root.symlink_to(real_root)
    cfg = AppConfig(path=tmp_path / "config.json", accounts={
        "work": {"config_dir": str(link_root / "claude"), "label": "工作"},
        "personal": {"config_dir": str(link_root / "claude-tc"), "label": "私人"},
    })
    m = claude_account_map(cfg)
    rp = str((work_proj / "s.jsonl").resolve())
    assert m[rp] == "work"   # 祖先 symlink 不影響：work（真實 projects）仍勝


@pytest.mark.parametrize("content, expected", [
    (None, None),
    (b'model = "gpt-6-astra"\n', "gpt-6-astra"),
    (b'[profiles.fast]\nmodel = "gpt-6.1-luna"\n', None),
    (b'model = 5\n', None),
    (b'model = ""\n', None),
    (b'model = "gpt-6-astra\n', None),
    (b'model = "\xff"\n', None),
], ids=["no-file", "top-level", "profile-only", "not-str", "empty", "bad-toml", "bad-utf8"])
def test_codex_config_model(tmp_path: Path, content, expected):
    """估價模型先看 config.toml 頂層 model；profile 覆寫不處理（spec 5.3-5、§7）。"""
    if content is not None:
        (tmp_path / "config.toml").write_bytes(content)
    assert codex_config_model(tmp_path) == expected


# ── Pi（Pi spec §6.1 #8／#9）──
def _pi_session(dirpath, name: str, first_line: str) -> "Path":
    dirpath.mkdir(parents=True, exist_ok=True)
    f = dirpath / name
    f.write_text(first_line + "\n" + json.dumps({"type": "message", "message": {"role": "user"}}) + "\n", encoding="utf-8")
    return f


def test_pi_files_only_session_files_recursive_realpath_dedup(tmp_path):
    """`sessions/**/*.jsonl` 遞迴；第一行不是 `{"type":"session"}`（別的 type、壞 JSON、空檔）跳過；symlink 去重；回 realpath 排序。"""
    home = tmp_path / "pi"
    a = _pi_session(home / "sessions" / "--p-a--", "a.jsonl", json.dumps({"type": "session", "version": 3, "id": "a", "cwd": "/p/a"}))
    b = _pi_session(home / "sessions" / "deep" / "er", "b.jsonl", json.dumps({"type": "session", "version": 3, "id": "b", "cwd": "/p/b"}))
    _pi_session(home / "sessions" / "x", "notsession.jsonl", json.dumps({"type": "message", "message": {"role": "user"}}))
    _pi_session(home / "sessions" / "x", "bad.jsonl", "not json {")
    (home / "sessions" / "x" / "empty.jsonl").write_text("", encoding="utf-8")
    (home / "sessions" / "x" / "notes.txt").write_text(json.dumps({"type": "session"}), encoding="utf-8")   # 副檔名不對
    os.symlink(a, home / "sessions" / "x" / "alias.jsonl")                                                    # 同一檔的 symlink
    assert pi_files(home) == sorted([Path(str(a.resolve())), Path(str(b.resolve()))])


def test_pi_files_missing_home_is_empty(tmp_path):
    assert pi_files(tmp_path / "nope") == []
    (tmp_path / "pi").mkdir()
    assert pi_files(tmp_path / "pi") == []        # 有 home 沒有 sessions/


def test_pi_home_env_override_else_default(monkeypatch):
    monkeypatch.setenv("FLEDGE_PI_HOME", "/tmp/pi-x")
    assert pi_home() == Path("/tmp/pi-x")
    monkeypatch.delenv("FLEDGE_PI_HOME")
    assert pi_home() == Path.home() / ".pi" / "agent"


def test_pi_files_and_header_reader_skip_unreadable_file(tmp_path):
    """拒讀（macOS TCC）：掃描層 best-effort——`pi_files` 略過那一檔不拋、`pi_session_header` 回 None（跟壞 JSON 同語義）。"""
    home = tmp_path / "pi"
    a = _pi_session(home / "sessions" / "x", "a.jsonl", json.dumps({"type": "session", "version": 3, "id": "a", "cwd": "/p/a"}))
    locked = _pi_session(home / "sessions" / "x", "locked.jsonl", json.dumps({"type": "session", "version": 3, "id": "l", "cwd": "/p/l"}))
    locked.chmod(0)
    try:
        assert pi_files(home) == [Path(str(a.resolve()))]
        assert pi_session_header(locked) is None
    finally:
        locked.chmod(0o600)

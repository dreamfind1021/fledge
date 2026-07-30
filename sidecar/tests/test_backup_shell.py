"""`scripts/backup-claude.sh` 的行為契約。

一律用假的 HOME 與假的 config——**絕不碰真實的 Claude 目錄**。腳本的核心安全不變式是
「來源全程唯讀」，但測試自己也必須守同一條線：只在 tmp_path 底下建東西。
"""
import json
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "backup-claude.sh"


def _fake_home(tmp_path: Path) -> tuple[Path, Path]:
    """建一個假 HOME：一個帳號目錄 + 一份 Fledge config。回 (home, config_dir)。"""
    home = tmp_path / "home"
    config_dir = home / ".claude"
    (config_dir / "skills").mkdir(parents=True)
    (config_dir / "skills" / "demo.md").write_text("x", encoding="utf-8")
    (config_dir / "settings.json").write_text("{}", encoding="utf-8")
    fledge = home / ".fledge"
    fledge.mkdir()
    (fledge / "config.json").write_text(
        json.dumps(
            {
                "version": 1,
                "roots": [],
                "accounts": {"default": {"config_dir": str(config_dir), "label": ""}},
            }
        ),
        encoding="utf-8",
    )
    return home, config_dir


def _run(args: list[str], home: Path, extra_env: dict | None = None):
    env = {**os.environ, "HOME": str(home)}
    env.pop("FLEDGE_BACKUP_DIR", None)
    env.update(extra_env or {})
    return subprocess.run(
        ["/bin/bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )


# ── 輸出目錄必填 ──────────────────────────────────────────────────────────────


def test_fails_without_output_dir(tmp_path: Path):
    """移除硬編碼預設值後，缺 -o 與 FLEDGE_BACKUP_DIR 一律報錯——不能默默寫到某個
    對這台機器以外沒有意義的路徑。"""
    home, _ = _fake_home(tmp_path)
    proc = _run(["--list"], home)
    assert proc.returncode != 0


def test_env_var_still_works(tmp_path: Path):
    home, _ = _fake_home(tmp_path)
    proc = _run(["--list"], home, extra_env={"FLEDGE_BACKUP_DIR": str(tmp_path / "out")})
    assert proc.returncode == 0, proc.stderr


def test_no_personal_path_left_in_script():
    """公開 repo 不能留開發者的個人路徑。"""
    assert "/Users/tc" not in SCRIPT.read_text(encoding="utf-8")


# ── ASSET_GLOBS ───────────────────────────────────────────────────────────────


def test_settings_bak_is_collected(tmp_path: Path):
    """`settings.json.bak.*` 是共通設置把 settings.json 換成 symlink 前，那份使用者手寫
    設定的唯一副本——按可再生性判準它是資產。"""
    home, config_dir = _fake_home(tmp_path)
    (config_dir / "settings.json.bak.20260727-1432").write_text("{}", encoding="utf-8")
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert "settings.json.bak.20260727-1432" in proc.stdout


def test_settings_bak_no_longer_flagged_unknown(tmp_path: Path):
    """判成資產之後就不該再觸發未分類警示——否則使用者會學會無視那個警示，
    而它是我們唯一能察覺「Claude Code 又加了新東西」的機制。"""
    home, config_dir = _fake_home(tmp_path)
    (config_dir / "settings.json.bak.20260727-1432").write_text("{}", encoding="utf-8")
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert "清單上沒有" not in proc.stdout


def test_glob_with_no_match_leaves_no_literal_pattern(tmp_path: Path):
    """零匹配時不能留下字面 pattern（沒開 nullglob 就會）。"""
    home, _ = _fake_home(tmp_path)
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert "settings.json.bak.*" not in proc.stdout


def test_glob_handles_filename_with_space(tmp_path: Path):
    home, config_dir = _fake_home(tmp_path)
    (config_dir / "settings.json.bak.2026 07 27").write_text("{}", encoding="utf-8")
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert "settings.json.bak.2026 07 27" in proc.stdout


def test_multiple_glob_matches_all_collected(tmp_path: Path):
    home, config_dir = _fake_home(tmp_path)
    for stamp in ("20260727-1432", "20260728-0900", "20260729-1015"):
        (config_dir / f"settings.json.bak.{stamp}").write_text("{}", encoding="utf-8")
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    for stamp in ("20260727-1432", "20260728-0900", "20260729-1015"):
        assert f"settings.json.bak.{stamp}" in proc.stdout


def test_glob_matches_are_actually_packed(tmp_path: Path):
    """掃描列出來不等於真的收進去——三處（掃描／複製／未分類判定）要共用同一份展開結果。"""
    home, config_dir = _fake_home(tmp_path)
    (config_dir / "settings.json.bak.20260727-1432").write_text('{"real":1}', encoding="utf-8")
    out = tmp_path / "out"
    proc = _run(["-o", str(out)], home)
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    listing = subprocess.run(
        ["tar", "tzf", str(bundle)], capture_output=True, text=True, timeout=60
    ).stdout
    assert "settings.json.bak.20260727-1432" in listing


# ── 共用來源清單檔 ────────────────────────────────────────────────────────────


def test_extra_paths_come_from_shared_file(tmp_path: Path):
    """腳本必須讀共用清單檔而不是硬編碼——否則與 sidecar 的 containment 會漂移。"""
    home, _ = _fake_home(tmp_path)
    (home / ".agents").mkdir()
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert ".agents" in proc.stdout


def test_script_reads_the_shared_list_file():
    """對帳哨兵：腳本原始碼裡必須出現共用清單檔的檔名。只改 Python 端不改 bash
    （或反過來）就會漂移，而漂移的後果是 containment 不知道新來源。"""
    from fledge_sidecar.backup.containment import EXTRA_PATHS_FILENAME

    assert EXTRA_PATHS_FILENAME in SCRIPT.read_text(encoding="utf-8")


def test_missing_shared_list_file_is_not_fatal(tmp_path: Path):
    """清單檔讀不到時腳本仍要能跑（比照 sidecar 端：少一個來源不是錯誤）。
    以複製一份腳本到沒有清單檔的目錄來模擬。"""
    home, _ = _fake_home(tmp_path)
    lonely = tmp_path / "lonely"
    lonely.mkdir()
    copy = lonely / "backup-claude.sh"
    copy.write_text(SCRIPT.read_text(encoding="utf-8"), encoding="utf-8")
    proc = subprocess.run(
        ["/bin/bash", str(copy), "--list", "-o", str(tmp_path / "out")],
        capture_output=True,
        text=True,
        env={**os.environ, "HOME": str(home)},
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr


def test_backup_succeeds_when_no_extra_paths_exist(tmp_path: Path):
    """回歸：`~/.agents` 之類的額外來源全都不存在時，備份仍要成功。

    原本的 `[ -e "$p" ] && echo …` 會讓迴圈以非零狀態結束 → command substitution 非零
    → `set -e` 在**做完所有工作之後**把腳本殺掉。有 `~/.agents` 的機器永遠踩不到，
    沒有的機器（＝多數使用者）每次備份都在最後一刻失敗，而且失敗得毫無訊息。"""
    home, _ = _fake_home(tmp_path)
    assert not (home / ".agents").exists()
    out = tmp_path / "out"
    proc = _run(["-o", str(out)], home)
    assert proc.returncode == 0, proc.stderr
    assert list(out.glob("claude-backup-*.tar.gz"))

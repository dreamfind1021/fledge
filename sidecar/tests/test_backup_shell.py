"""`scripts/backup-claude.sh` 的行為契約。

一律用假的 HOME 與假的 config——**絕不碰真實的 Claude 目錄**。腳本的核心安全不變式是
「來源全程唯讀」，但測試自己也必須守同一條線：只在 tmp_path 底下建東西。
"""
import json
import os
import subprocess
import tarfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "backup-claude.sh"


def _fake_home(tmp_path: Path, name: str = "home") -> tuple[Path, Path]:
    """建一個假 HOME：一個帳號目錄 + 一份 Fledge config。回 (home, config_dir)。

    `name` 讓需要特殊字元的測試（含單引號的路徑）換掉目錄名，其餘結構完全相同。"""
    home = tmp_path / name
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


# ── HOME 含特殊字元（票 11）──────────────────────────────────────────────────


def test_home_with_a_quote_still_backs_up(tmp_path: Path):
    """`/Users/o'brien` 這種姓氏在 macOS 上完全合法。設定檔路徑若被插值進內嵌的 Python
    程式碼字串，那段程式會變成 SyntaxError——備份整個跑不起來，而使用者看到的是一段
    看不懂的 traceback。路徑必須走 argv。"""
    home, _ = _fake_home(tmp_path, name="ho'me")
    out = tmp_path / "out"
    proc = _run(["-o", str(out)], home)
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    listing = subprocess.run(
        ["tar", "tzf", str(bundle)], capture_output=True, text=True, timeout=60
    ).stdout
    assert "accounts/default/skills/demo.md" in listing


def test_no_shell_interpolation_into_python():
    """對帳哨兵：`python3 -c "…"`（雙引號）是唯一會把 shell 變數插進程式碼的形式。
    單引號的 `-c` 與 quoted heredoc（`<<'PY'`）都不插值，路徑一律走 argv。"""
    assert 'python3 -c "' not in SCRIPT.read_text(encoding="utf-8")


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


# ── 原子發布與殘骸回收（票 06）──────────────────────────────────────────────


def _fake_bin(tmp_path: Path, name: str, body: str) -> Path:
    """造一個假的外部命令，用 PATH 前置注入。"""
    d = tmp_path / "fakebin"
    d.mkdir(exist_ok=True)
    f = d / name
    f.write_text(body, encoding="utf-8")
    f.chmod(0o755)
    return d


def _dying_tar(tmp_path: Path) -> Path:
    """假的 tar：**先把輸出檔建出來再失敗**——模擬磁碟滿／被 signal 中斷這種
    「已經開始寫才死」的情境。直接 exit 1 的假 tar 不會產生檔案，那樣測到的是
    假綠：它證明不了原子發布，只證明了「沒寫就沒有殘骸」。"""
    return _fake_bin(
        tmp_path, "tar", '#!/bin/sh\ncase "$1" in *c*) echo garbage > "$2" ;; esac\nexit 1\n'
    )


def test_no_bundle_name_when_tar_fails(tmp_path: Path):
    """原子發布的核心：打包失敗時，輸出目錄不得出現任何看起來像完整備份包的檔案。

    腳本 `set -e` 之下 `tar czf` 自己失敗就直接退出，**到不了**後面的 `tar tzf` 驗證與
    刪除分支；trap 又只清 staging。留下的殘骸檔名完全合法，卡片會顯示成「0 天前」配
    正常色——正是整份設計要防的假安全感。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    proc = _run(["-o", str(out)], home, extra_env={"PATH": f"{_dying_tar(tmp_path)}:{os.environ['PATH']}"})
    assert proc.returncode != 0
    assert list(out.glob("claude-backup-*.tar.gz")) == []


def test_partial_is_cleaned_when_tar_fails(tmp_path: Path):
    """trap 也要清掉半成品，否則每次失敗都在備份碟留一份。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    _run(["-o", str(out)], home, extra_env={"PATH": f"{_dying_tar(tmp_path)}:{os.environ['PATH']}"})
    assert list(out.glob(".claude-backup-*.partial")) == []


def test_bundle_appears_only_after_verification(tmp_path: Path):
    """成功路徑：最終檔名一出現就代表內容已通過 `tar tzf` 驗證。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    proc = _run(["-o", str(out)], home)
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    assert subprocess.run(["tar", "tzf", str(bundle)], capture_output=True).returncode == 0
    assert list(out.glob(".claude-backup-*.partial")) == []


def test_stale_partial_is_reclaimed(tmp_path: Path):
    """SIGKILL／斷電時 trap 不會執行，殘骸會累積並吃掉備份碟的空間。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    stale = out / ".claude-backup-20200101-0000-12345-678.tar.gz.partial"
    stale.write_bytes(b"x")
    old = os.path.getmtime(stale) - 48 * 3600
    os.utime(stale, (old, old))
    _run(["-o", str(out)], home)
    assert not stale.exists()


def test_fresh_partial_is_kept(tmp_path: Path):
    """未超齡的不能刪：可能是另一個正在跑的實例。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    fresh = out / ".claude-backup-20260730-0900-12345-678.tar.gz.partial"
    fresh.write_bytes(b"x")
    _run(["-o", str(out)], home)
    assert fresh.exists()


def test_unrelated_files_are_never_deleted(tmp_path: Path):
    """只刪自己產生的格式。命名不符的一律不動，即使它很舊——破壞性操作的基本原則。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    keepers = [
        out / "important.tar.gz.partial",
        out / "claude-backup-20200101-0000.tar.gz",       # 完整備份包，不是殘骸
        out / ".claude-backup-nonsense.tar.gz.partial",   # 時間戳形狀不符
    ]
    for f in keepers:
        f.write_bytes(b"x")
        old = os.path.getmtime(f) - 48 * 3600
        os.utime(f, (old, old))
    _run(["-o", str(out)], home)
    for f in keepers:
        assert f.exists(), f.name


def test_no_match_does_not_add_empty_item(tmp_path: Path):
    """回歸：零匹配時 matched 不得多出一個空元素。

    `printf '%s\\0' ${pat}` 在沒有引數時仍會輸出一次空字串，於是 `"${dir}/${item}"`
    變成 `"${dir}/"`——掃描對整個帳號目錄 du，打包則 `cp -Rc` 整棵帳號目錄，把
    ADR-0004 判定不收的 sessions/、cache/ 全收進備份包。原本的測試只檢查「有沒有留下
    字面 pattern」，抓不到這個。"""
    home, config_dir = _fake_home(tmp_path)
    (config_dir / "cache").mkdir()
    (config_dir / "cache" / "junk.bin").write_bytes(b"x" * 4096)
    out = tmp_path / "out"
    proc = _run(["-o", str(out)], home)
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    listing = subprocess.run(
        ["tar", "tzf", str(bundle)], capture_output=True, text=True, timeout=60
    ).stdout
    assert "cache/junk.bin" not in listing, "零匹配的空項目讓整個帳號目錄被收進去了"


def test_scan_output_has_no_blank_item_row(tmp_path: Path):
    """同一個 bug 在掃描階段的樣子：一行「收」後面接空白項目名。"""
    home, _ = _fake_home(tmp_path)
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    blank_rows = [ln for ln in proc.stdout.splitlines() if ln.strip().startswith("收") and len(ln.split()) < 3]
    assert blank_rows == [], blank_rows


def test_concurrent_runs_do_not_share_partial(tmp_path: Path):
    """兩個同分鐘啟動的備份不得互相破壞。

    `stamp` 只有分鐘精度。若 partial 名只由 stamp 決定，兩個程序會寫同一個檔案；更糟的是
    A 驗證通過、rename 成最終名之後，B 的 open fd 仍指向同一個 inode——B 繼續寫，把一個
    **已經驗證過**的備份包寫壞。原子發布必須在併行這一側也成立。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    # 假 HOME 很小，兩個程序不做任何事就會先後跑完、根本不重疊——那樣的測試是假綠，
    # 它證明的是「沒有併行」而不是「併行安全」。用會拖慢的 tar 造出真正的重疊窗口。
    slow_tar = _fake_bin(
        tmp_path, "tar",
        '#!/bin/sh\ncase "$1" in *c*) sleep 1 ;; esac\nexec /usr/bin/tar "$@"\n',
    )
    env = {**os.environ, "HOME": str(home), "PATH": f"{slow_tar}:{os.environ['PATH']}"}
    env.pop("FLEDGE_BACKUP_DIR", None)
    procs = [
        subprocess.Popen(
            ["/bin/bash", str(SCRIPT), "-o", str(out)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        for _ in range(2)
    ]
    for p in procs:
        p.wait(timeout=180)

    bundles = list(out.glob("claude-backup-*.tar.gz"))
    assert len(bundles) == 1, f"同分鐘併行應只發布一份，實得 {[b.name for b in bundles]}"
    # 發布出來的那份必須完整：被另一個程序寫壞的話這裡會失敗
    assert subprocess.run(["tar", "tzf", str(bundles[0])], capture_output=True).returncode == 0
    assert list(out.glob(".claude-backup-*.partial")) == [], "半成品沒被清乾淨"
    assert sum(1 for p in procs if p.returncode == 0) == 1, "應恰有一個成功、一個讓位"


def test_partial_name_is_per_process(tmp_path: Path):
    """確定性地驗證「不共用 partial」這個構造性質，不依賴贏得競爭。

    上面那條併行測試會受時序影響（兩個程序可能根本沒重疊），單靠它證明不了原子性。
    這裡直接攔截 tar 拿到的 partial 路徑：兩次不同的執行必須拿到不同的檔名。"""
    home, _ = _fake_home(tmp_path)
    seen = tmp_path / "seen.txt"
    recorder = _fake_bin(
        tmp_path, "tar",
        f'#!/bin/sh\ncase "$1" in *c*) echo "$2" >> {seen} ;; esac\nexec /usr/bin/tar "$@"\n',
    )
    env = {"PATH": f"{recorder}:{os.environ['PATH']}"}
    _run(["-o", str(tmp_path / "out1")], home, extra_env=env)
    _run(["-o", str(tmp_path / "out2")], home, extra_env=env)
    names = [Path(line).name for line in seen.read_text(encoding="utf-8").split()]
    assert len(names) == 2
    assert names[0] != names[1], f"兩次執行拿到同一個 partial：{names}"
    for n in names:
        assert n.startswith(".claude-backup-") and n.endswith(".tar.gz.partial")


def test_publish_never_clobbers_existing_bundle(tmp_path: Path):
    """發布是 no-clobber 的：最終名已存在時不得覆寫，也不得留下半成品。

    這是併行安全的另一半——`[ -e ]` 只是 check-then-act，真正的保證來自用 `ln`
    發布（遇既有目標直接 EEXIST 失敗）。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    # 先跑一次拿到真實的檔名，再用它預先佔位
    _run(["-o", str(out)], home)
    (existing,) = list(out.glob("claude-backup-*.tar.gz"))
    original = existing.read_bytes()

    proc = _run(["-o", str(out)], home)   # 同一分鐘內再跑一次 → 撞同名
    if proc.returncode == 0:
        return  # 跨過了分鐘邊界，這次沒撞名，不適用
    assert existing.read_bytes() == original, "既有備份包被覆寫了"
    assert list(out.glob(".claude-backup-*.partial")) == [], "失敗後留下半成品"


def test_reclaim_only_deletes_our_exact_naming(tmp_path: Path):
    """回收只刪本腳本自己產生的命名——**這條真的執行 shell 的回收路徑**。

    先前那條同名主張寫在 `test_partial_without_pid_segment_is_not_our_residue` 的 docstring
    裡，但它只呼叫了 Python 的 `last_attempt_failed()`，從來沒跑過腳本，是假綠（Codex 抓到）。
    兩邊的命名認定必須等價：sidecar 的 `_PARTIAL_RE` 只認 `-<數字>-<數字>`，
    find 的 glob `-*` 卻會匹配 `-`、`-imported`。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    out.mkdir()

    ours = out / ".claude-backup-20200101-0000-12345-678.tar.gz.partial"
    theirs = [
        out / ".claude-backup-20200101-0000-.tar.gz.partial",          # 空 PID 段
        out / ".claude-backup-20200101-0000-imported.tar.gz.partial",  # 字母 PID 段
        out / ".claude-backup-20200101-0000-12345.tar.gz.partial",     # 舊格式（缺隨機段）
        out / ".claude-backup-nonsense.tar.gz.partial",                # 時間戳形狀不符
        out / "important.tar.gz.partial",
    ]
    for f in [ours, *theirs]:
        f.write_bytes(b"x")
        old = os.path.getmtime(f) - 48 * 3600
        os.utime(f, (old, old))

    _run(["-o", str(out)], home)
    assert not ours.exists(), "自己的超齡殘骸應該被回收"
    for f in theirs:
        assert f.exists(), f"{f.name} 不是本腳本產生的格式，不該被刪"


def test_publish_falls_back_when_hard_link_unsupported(tmp_path: Path):
    """hard link 不可用的檔案系統（exFAT、部分 SMB 掛載）仍要能發布。

    不能把所有 `ln` 失敗都報成「輸出檔已存在」——那會讓使用者朝完全錯誤的方向排查，
    而真正的原因是 Operation not supported／權限／quota。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    broken_ln = _fake_bin(
        tmp_path, "ln", '#!/bin/sh\necho "ln: Operation not supported" >&2\nexit 1\n'
    )
    proc = _run(["-o", str(out)], home, extra_env={"PATH": f"{broken_ln}:{os.environ['PATH']}"})
    assert proc.returncode == 0, proc.stderr
    assert len(list(out.glob("claude-backup-*.tar.gz"))) == 1
    assert "Operation not supported" in proc.stderr, "退回 rename 時要把真正的原因說出來"
    assert list(out.glob(".claude-backup-*.partial")) == []


def test_publish_still_refuses_to_clobber_when_ln_unsupported(tmp_path: Path):
    """退回 rename 之後仍不得覆寫既有備份包——rename 沒有 no-clobber 語意，
    所以那條路徑必須先確認目標不存在。"""
    home, _ = _fake_home(tmp_path)
    out = tmp_path / "out"
    broken_ln = _fake_bin(
        tmp_path, "ln", '#!/bin/sh\necho "ln: Operation not supported" >&2\nexit 1\n'
    )
    env = {"PATH": f"{broken_ln}:{os.environ['PATH']}"}
    _run(["-o", str(out)], home, extra_env=env)
    (existing,) = list(out.glob("claude-backup-*.tar.gz"))
    original = existing.read_bytes()

    proc = _run(["-o", str(out)], home, extra_env=env)   # 同分鐘再跑一次
    if proc.returncode == 0:
        return  # 跨過分鐘邊界，沒撞名
    assert existing.read_bytes() == original, "既有備份包被覆寫了"


# ── extra 本身是 symlink 的合約（票 17）─────────────────────────────────────
#
# 合約：**extra 的語意是「解一層參照後的真實目錄樹」**。`~/.agents` 本身是連結（skill
# 真身放第三個位置的常見設置）時，備份收的是它指向的內容，名字沿用連結本身的 basename。
#
# 改這條之前，`cp -R` 不跟隨最外層，包裡的 `extra/.agents` 是一條指向**舊機絕對路徑**的
# 連結——install 端的 fd-relative `O_NOFOLLOW` 必然 `not_a_directory`，而腳本 rc = 0。
# 使用者拿到一個看起來成功、裡面有一項永遠搬不回去的包，失敗要到移機最後一步才看得到。


def _symlinked_agents(tmp_path: Path, home: Path) -> Path:
    """把 `~/.agents` 做成指向第三處的 symlink，回**真身目錄**。

    這是本節所有測試的前提形狀；手工造備份包複製不出真腳本的產出（票 13 的教訓），
    所以每條測試都跑真的 `backup-claude.sh`。"""
    real = tmp_path / "real-agents"
    (real / "skills").mkdir(parents=True)
    (real / "skills" / "s.md").write_text("REAL", encoding="utf-8")
    (home / ".agents").symlink_to(real, target_is_directory=True)
    return real


def _pack(tmp_path: Path, home: Path, name: str = "out") -> Path:
    """跑真腳本，回產出的備份包路徑。"""
    out = tmp_path / f"out-{name}"
    proc = _run(["-o", str(out)], home)
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    return bundle


def _pack_and_unpack(tmp_path: Path, home: Path, name: str = "unpacked") -> Path:
    """跑真腳本、解開產出的備份包，回解開後的根目錄。

    **解開後的檔案系統驗不了「包裡有什麼」**：`extra/.agents` 若是一條指向包外的連結，
    同機測試下它會解析成功，`iterdir()`／`exists()` 看到的全是包外的真身。要驗包的
    內容形狀請改用 `_pack()` ＋ `tarfile.getmembers()`。"""
    bundle = _pack(tmp_path, home, name)
    dest = tmp_path / name
    with tarfile.open(bundle) as tf:
        tf.extractall(dest, filter="tar")
    return dest


def test_symlinked_extra_is_packed_as_a_real_directory(tmp_path: Path):
    """核心合約：連結的 extra 要收成**真目錄＋真內容**，不是一條連結。

    一條指向舊機絕對路徑的連結在新機上什麼都不是，而在舊機上更糟——它讓
    「備份包」與「包外的現役資料」看起來一樣，於是預覽會數到包裡根本沒有的東西。"""
    home, _ = _fake_home(tmp_path)
    _symlinked_agents(tmp_path, home)
    src = _pack_and_unpack(tmp_path, home)
    agents = src / "extra" / ".agents"
    assert not agents.is_symlink(), "extra 仍是一條連結＝這個包裝不回去"
    assert agents.is_dir()
    assert (agents / "skills" / "s.md").read_text(encoding="utf-8") == "REAL"


def test_only_the_outermost_link_is_dereferenced(tmp_path: Path):
    """**界線**：只解最外層那一層，內容裡的連結仍原樣存連結。

    這條守的是「解一層」與「整棵跟隨」的分界。改成 `cp -RL` 同樣能讓上一條測試變綠，
    但那會把連結指向的任何東西（可能是整個家目錄）拖進備份包。

    **驗的是 tar 成員不是解開後的檔案系統**：`extra/.agents` 若還是一條指向包外的連結，
    同機下解開後的路徑會解析到包外的真身，`iterdir()` 剛好看到正確的形狀而測試假綠。"""
    home, _ = _fake_home(tmp_path)
    real = _symlinked_agents(tmp_path, home)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "big.md").write_text("OUTSIDE", encoding="utf-8")
    (real / "skills" / "linked").symlink_to(outside, target_is_directory=True)

    with tarfile.open(_pack(tmp_path, home)) as tf:
        members = {m.name: m for m in tf.getmembers()}
    assert members["extra/.agents"].isdir(), "最外層沒解參照"
    inner = members["extra/.agents/skills/linked"]
    assert inner.issym(), "內容裡的連結被解開了＝整棵跟隨"
    assert inner.linkname == str(outside)
    assert "extra/.agents/skills/linked/big.md" not in members, "連結目標的內容被收進包裡了"


def test_extra_name_comes_from_the_link_not_its_target(tmp_path: Path):
    """名字沿用**連結本身**的 basename（`.agents`），不是 target 的（`real-agents`）。

    manifest 的 key、`_safe_extra_name`（票 13）、落點對應三處都靠這個名字；用了 target
    的名字，還原端會拿一個本機 config 查不到的 key，整項被略過。"""
    home, _ = _fake_home(tmp_path)
    _symlinked_agents(tmp_path, home)
    src = _pack_and_unpack(tmp_path, home)
    # `.exists()` 對連結為真（同機解析得到包外的真身）——要一併釘住形狀才驗得到名字
    assert (src / "extra" / ".agents").is_dir() and not (src / "extra" / ".agents").is_symlink()
    assert not (src / "extra" / "real-agents").exists()
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    assert list(manifest["extra"]) == [".agents"]
    # manifest 存**連結本身**的路徑：那是使用者在舊機認得的位置。還原端只用 key 查本機
    # config（`local_live_paths` 明確不退回 manifest 的路徑），這個值純粹是舊機資訊。
    assert manifest["extra"][".agents"] == str(home / ".agents")


def test_scan_reports_the_real_size_of_a_symlinked_extra(tmp_path: Path):
    """掃描的大小要跟隨連結算。`du -sk` 對 symlink 參數回 0——使用者會看到
    「[帳號外] ~/.agents  0 KB」然後備份包比預估大好幾 GB。"""
    home, _ = _fake_home(tmp_path)
    real = _symlinked_agents(tmp_path, home)
    (real / "skills" / "big.md").write_text("x" * 200_000, encoding="utf-8")
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert proc.returncode == 0, proc.stderr
    rows = [ln for ln in proc.stdout.splitlines() if "[帳號外]" in ln and ".agents" in ln]
    assert len(rows) == 1, proc.stdout
    kb = int(rows[0].split()[-2])
    assert kb >= 190, f"連結的 extra 大小沒跟隨算：{rows[0]!r}"


def test_scan_size_uses_the_same_boundary_as_packing(tmp_path: Path):
    """估算與打包必須用**同一條界線**：只解最外層。

    `du -L` 是整棵跟隨，會把內容裡的連結指向的東西也算進來——而打包不跟隨那些，於是
    預估比實收大好幾十倍（實測 5100 KB vs 實收 100 KB）。修「最外層不算大小」時很容易
    順手用 `-L`，那是把一個「一邊有一邊沒有」換成另一個。"""
    home, _ = _fake_home(tmp_path)
    real = _symlinked_agents(tmp_path, home)
    (real / "skills" / "own.bin").write_bytes(b"x" * 100_000)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "huge.bin").write_bytes(b"x" * 3_000_000)
    (real / "skills" / "linked").symlink_to(elsewhere, target_is_directory=True)

    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert proc.returncode == 0, proc.stderr
    rows = [ln for ln in proc.stdout.splitlines() if "[帳號外]" in ln and ".agents" in ln]
    assert len(rows) == 1, proc.stdout
    kb = int(rows[0].split()[-2])
    assert kb >= 90, f"最外層沒解參照，估算又變回 0：{rows[0]!r}"
    assert kb < 1000, f"估算跟隨了內容裡的連結（實收不含那些）：{kb} KB"


def test_scan_says_where_a_symlinked_extra_really_points(tmp_path: Path):
    """收的東西與使用者寫在清單裡的路徑不是同一個位置時，備份前就要看得到。"""
    home, _ = _fake_home(tmp_path)
    real = _symlinked_agents(tmp_path, home)
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert proc.returncode == 0, proc.stderr
    assert str(real) in proc.stdout, "掃描沒說這一項實際會收哪個目錄的內容"


def test_plain_directory_extra_is_unchanged(tmp_path: Path):
    """回歸：普通目錄的 extra 形狀不變（多數機器走的是這條）。"""
    home, _ = _fake_home(tmp_path)
    (home / ".agents" / "skills").mkdir(parents=True)
    (home / ".agents" / "skills" / "s.md").write_text("PLAIN", encoding="utf-8")
    src = _pack_and_unpack(tmp_path, home)
    agents = src / "extra" / ".agents"
    assert not agents.is_symlink()
    assert (agents / "skills" / "s.md").read_text(encoding="utf-8") == "PLAIN"


def test_a_non_directory_extra_is_skipped_and_says_so(tmp_path: Path):
    """extra 一律當**目錄樹**處理。是普通檔案時明確跳過並出聲，不留半套形狀。

    收窄合約的理由：現行對「指向檔案的連結」同樣是壞的（包裡存一條斷鏈），與其支援
    兩種形狀，不如讓不符的當場說出來。"""
    home, _ = _fake_home(tmp_path)
    (home / ".agents").write_text("not a directory", encoding="utf-8")
    proc = _run(["--list", "-o", str(tmp_path / "out-list")], home)
    assert proc.returncode == 0, proc.stderr
    assert "不是目錄" in proc.stdout, "靜靜跳過等於讓使用者以為收了"
    src = _pack_and_unpack(tmp_path, home)
    assert not (src / "extra").exists(), "非目錄的 extra 不該進包"
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    # manifest 與包內容必須一致：說有卻沒收，還原端會拿一個空 key 對帳
    assert manifest["extra"] == {}


def _script_with_extra_list(tmp_path: Path, lines: str) -> Path:
    """把腳本複製到自帶 extra 清單檔的目錄，用來測 repo 那份清單以外的路徑形狀。
    （腳本以 `SCRIPT_DIR` 找清單檔，比照 `test_missing_shared_list_file_is_not_fatal`。）"""
    d = tmp_path / "scriptdir"
    d.mkdir(exist_ok=True)
    copy = d / "backup-claude.sh"
    copy.write_text(SCRIPT.read_text(encoding="utf-8"), encoding="utf-8")
    copy.chmod(0o755)
    (d / "backup-extra-paths.txt").write_text(lines, encoding="utf-8")
    return copy


def _refusal_run(tmp_path: Path, home: Path, out: Path,
                 script: Path | None = None, tag: str = "cp", cwd: Path | None = None):
    """跑備份、期望被輸出目錄的前置檢查擋下。回 `(proc, sentinel)`。

    假 `cp` 寫哨兵檔是為了驗**一個位元組都沒被複製**——只斷言「失敗了」會被壞掉的路徑
    滿足：`cp` 自己遞迴爆炸同樣 rc≠0、同樣有錯誤訊息、trap 同樣會清乾淨（票 17 實踩）。

    `tag` 讓同一個 `tmp_path` 裡的多次呼叫各有自己的哨兵（對帳測試會連跑好幾格）。"""
    sentinel = tmp_path / f"{tag}-was-called"
    fake = _fake_bin(tmp_path, "cp", (
        "#!/bin/sh\n"
        f"echo called >> '{sentinel}'\n"
        "exec /bin/cp \"$@\"\n"
    ))
    env = {**os.environ, "HOME": str(home), "PATH": f"{fake}:{os.environ['PATH']}"}
    env.pop("FLEDGE_BACKUP_DIR", None)
    proc = subprocess.run(["/bin/bash", str(script or SCRIPT), "-o", str(out)],
                          capture_output=True, text=True, env=env, timeout=120,
                          cwd=str(cwd) if cwd else None)
    return proc, sentinel


def test_extra_path_containing_a_tab_keeps_its_name(tmp_path: Path):
    """路徑含 tab 時，manifest 的 key 與包裡的目錄名必須一致（Codex 票 17 R2 F1）。

    tab 在 Unix 路徑裡合法。用 tab 把兩個不受限的檔案系統字串串成一筆記錄，再從第一個
    tab 切開，路徑自己的 tab 就會把切割點帶偏——manifest 的 key 被截短，還原端拿著一個
    對不上包內容的名字，那一項就選不出來。"""
    home, _ = _fake_home(tmp_path)
    weird = home / "we\tird"
    (weird / "skills").mkdir(parents=True)
    (weird / "skills" / "s.md").write_text("T", encoding="utf-8")
    script = _script_with_extra_list(tmp_path, "~/we\tird\n")

    out = tmp_path / "out"
    env = {**os.environ, "HOME": str(home)}
    env.pop("FLEDGE_BACKUP_DIR", None)
    proc = subprocess.run(["/bin/bash", str(script), "-o", str(out)],
                          capture_output=True, text=True, env=env, timeout=120)
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    dest = tmp_path / "unpacked"
    with tarfile.open(bundle) as tf:
        tf.extractall(dest, filter="tar")

    assert (dest / "extra" / "we\tird" / "skills" / "s.md").is_file(), \
        "包裡的目錄名不是完整的 basename"
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    assert list(manifest["extra"]) == ["we\tird"], \
        f"manifest 的 key 與包內容對不上：{list(manifest['extra'])!r}"


def test_tab_in_extra_path_does_not_bypass_the_output_dir_check(tmp_path: Path):
    """含 tab 的來源路徑不得讓輸出目錄的 containment 檢查失準（Codex 票 17 R2 F1）。

    切割點被帶偏時，比對用的 root 會是路徑的一段殘餘，於是真正落在來源樹裡的輸出
    目錄反而通過檢查——備份照樣把 staging 收進自己。

    **tab 要在清單那一側**：記錄是「清單寫法 TAB 解參照根」，只有前半含 tab 才會讓
    「切第一個 tab」取到錯的後半。第一版把 tab 放在 target 上，切割點恰好還是對的，
    測試就綠著——fixture 不觸發要測的情境。"""
    home, _ = _fake_home(tmp_path)
    real = home / "we\tird"
    (real / "skills").mkdir(parents=True)
    (real / "skills" / "s.md").write_text("T", encoding="utf-8")
    script = _script_with_extra_list(tmp_path, "~/we\tird\n")

    proc, sentinel = _refusal_run(tmp_path, home, real / "backups", script=script)
    assert proc.returncode != 0, "含 tab 的來源讓 containment 檢查被繞過"
    assert not sentinel.exists(), "已經開始複製才擋"
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]


def test_glob_chars_in_extra_path_do_not_break_the_output_dir_check(tmp_path: Path):
    """來源路徑含 glob 特殊字元時 containment 仍要正確。

    `case` 的 pattern 會把 `[bc]` 當「b 或 c 其中一個字元」，於是 `/home/a[bc]/*` 匹配的是
    `/home/ab/…`，真正落在 `/home/a[bc]/` 裡的輸出目錄反而**漏擋**。比對必須是純字串，
    不能經過任何 pattern 展開。含中括號的目錄名並不罕見。"""
    home, _ = _fake_home(tmp_path)
    weird = home / "a[bc]"
    (weird / "skills").mkdir(parents=True)
    (weird / "skills" / "s.md").write_text("G", encoding="utf-8")
    script = _script_with_extra_list(tmp_path, "~/a[bc]\n")

    proc, sentinel = _refusal_run(tmp_path, home, weird / "backups", script=script)
    assert proc.returncode != 0, "glob 字元讓 containment 檢查漏擋"
    assert not sentinel.exists(), "已經開始複製才擋"
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]


def test_refuses_when_output_dir_sits_inside_a_symlinked_extra(tmp_path: Path):
    """輸出目錄落在 extra 解參照後的樹裡面時，在寫任何東西之前就拒絕（Codex 票 17 R1 F2）。

    解一層參照之後 `cp -R "${p}/."` 複製的是連結指向的整棵樹，而 staging 就建在 OUT_DIR
    底下——實測會遞迴吸入自己，路徑一路長到 `cp` 失敗，訊息是一長串看不懂的路徑，而且
    失敗前已經寫了大量資料。**改之前只存一條連結，這個情境意外免疫**，所以這是回歸。

    **驗的是「一個位元組都沒複製」而不只是「失敗了」**：第一版斷言（rc≠0＋stderr 含
    `.agents`＋沒出包）在 `cp` 爆炸的情況下全部成立——爆炸的訊息裡本來就有一長串含
    `.agents` 的路徑，trap 也會把 staging 清掉。那樣測到的是「它會壞」，不是「它擋住」。"""
    home, _ = _fake_home(tmp_path)
    real = _symlinked_agents(tmp_path, home)
    out = real / "backups"
    proc, sentinel = _refusal_run(tmp_path, home, out)
    assert proc.returncode != 0, "備份把自己收進去了，卻沒有擋"
    assert not sentinel.exists(), "已經開始複製才擋＝擋得太晚"
    assert "輸出目錄在備份來源裡" in proc.stderr, \
        f"失敗了但沒說原因，使用者不知道該怎麼辦：{proc.stderr[:300]!r}"
    assert ".agents" in proc.stderr, f"沒說是哪一項來源害的：{proc.stderr[:300]!r}"
    assert list(out.glob("*.tar.gz")) == []


def test_refuses_when_output_dir_is_the_extra_root_itself(tmp_path: Path):
    """輸出目錄**恰好等於**來源根時同樣要擋。比對字串少一個尾斜線就會漏掉這一格，
    而那正是最直接的誤用（把備份直接倒進 `~/.agents`）。"""
    home, _ = _fake_home(tmp_path)
    real = _symlinked_agents(tmp_path, home)
    proc = _run(["-o", str(real)], home)
    assert proc.returncode != 0, "輸出目錄就是來源根本身，卻沒有擋"
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]


def test_output_dir_outside_the_extra_tree_still_works(tmp_path: Path):
    """回歸：擋的是「落在來源樹裡」，不是「有 symlink 的 extra 就不能備份」。"""
    home, _ = _fake_home(tmp_path)
    _symlinked_agents(tmp_path, home)
    src = _pack_and_unpack(tmp_path, home)
    assert (src / "extra" / ".agents" / "skills" / "s.md").is_file()


# ── 帳號側的來源根也要擋（票 18）──────────────────────────────────────────
#
# 票 17 只為 extra 加了這個檢查（解一層參照是那張票引入的回歸）。帳號側是既有缺口，
# **而且行為與 extra 完全不同**：`cp -R "${dir}/${item}"` 複製的是開始當下的樹、不會追
# 自己新寫的內容，所以**不會爆炸也不會失敗**——它靜靜地把 staging 連同輸出目錄裡既有的
# 備份包一起收進新包。實測：新包 3004 KB 含著舊包 3000 KB，每次備份吞掉之前所有的包，
# 體積指數成長到磁碟滿，而每一次的 `rc` 都是 0。
#
# 粒度用**粗判**（落在 `config_dir` 之下即擋，不細到 `ASSET_DIRS`），與 sidecar 的
# `check_backup_dir` 逐字一致——實測它對 `<config_dir>/backups` 也回 `inside_source`。


def test_refuses_when_output_dir_is_inside_an_account_config_dir(tmp_path: Path):
    """帳號側最直接的一格：輸出目錄落在會被複製的資產目錄底下。"""
    home, config_dir = _fake_home(tmp_path)
    proc, sentinel = _refusal_run(tmp_path, home, config_dir / "skills" / "backups")
    assert proc.returncode != 0, "備份會把 staging 與舊備份包收進新包，卻沒有擋"
    assert not sentinel.exists(), "已經開始複製才擋"
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]
    assert "default" in proc.stderr, f"沒說是哪個帳號：{proc.stderr[:300]!r}"


def test_account_containment_is_coarse_not_per_asset_dir(tmp_path: Path):
    """粒度是「落在 `config_dir` 之下」，不是「落在 `ASSET_DIRS` 之下」。

    `<config_dir>/backups` 技術上不會被複製（`backups` 不在清單裡），但仍要擋：細判會讓
    判準**隨 `ASSET_DIRS` 清單漂移**——哪天把某個目錄加進清單，本來放行的落點就變成不
    安全，而使用者不會知道。sidecar 對這一格也回 `inside_source`，兩邊要一致。"""
    home, config_dir = _fake_home(tmp_path)
    proc, sentinel = _refusal_run(tmp_path, home, config_dir / "backups")
    assert proc.returncode != 0, "粗判沒生效——這一格 sidecar 會擋而腳本放行"
    assert not sentinel.exists()
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]


def test_refuses_when_output_dir_is_the_config_dir_itself(tmp_path: Path):
    """輸出目錄恰好等於 `config_dir`。比對少一個尾斜線就會漏掉這一格。"""
    home, config_dir = _fake_home(tmp_path)
    proc, sentinel = _refusal_run(tmp_path, home, config_dir)
    assert proc.returncode != 0
    assert not sentinel.exists()
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]


def test_account_containment_follows_a_symlinked_config_dir(tmp_path: Path):
    """`config_dir` 本身是 symlink 時，比對要用解參照後的真實位置。

    sidecar 那側走 `os.stat`（跟隨連結）判身分，腳本用字串比對就必須先 `pwd -P`，否則
    使用者用真實路徑指定輸出目錄時腳本放行、GUI 卻擋——兩份實作對同一件事給不同答案。"""
    home = tmp_path / "home"
    real_claude = tmp_path / "elsewhere" / "claude"
    (real_claude / "skills").mkdir(parents=True)
    (real_claude / "skills" / "a.md").write_text("x", encoding="utf-8")
    home.mkdir()
    (home / ".claude").symlink_to(real_claude, target_is_directory=True)
    fledge = home / ".fledge"
    fledge.mkdir()
    (fledge / "config.json").write_text(json.dumps({
        "version": 1, "roots": [],
        "accounts": {"default": {"config_dir": str(home / ".claude"), "label": ""}},
    }), encoding="utf-8")

    # 用**真實路徑**指定輸出目錄——字串上與 config_dir 的寫法完全不同
    proc, sentinel = _refusal_run(tmp_path, home, real_claude / "skills" / "backups")
    assert proc.returncode != 0, "config_dir 是連結時漏擋了"
    assert not sentinel.exists()
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]


def test_refuses_for_any_account_not_just_the_first(tmp_path: Path):
    """多帳號時每一個 `config_dir` 都是來源根，不能只檢查第一個。"""
    home, first = _fake_home(tmp_path)
    second = home / ".claude-work"
    (second / "skills").mkdir(parents=True)
    (second / "skills" / "b.md").write_text("y", encoding="utf-8")
    cfg = json.loads((home / ".fledge" / "config.json").read_text(encoding="utf-8"))
    cfg["accounts"]["work"] = {"config_dir": str(second), "label": ""}
    (home / ".fledge" / "config.json").write_text(json.dumps(cfg), encoding="utf-8")

    proc, sentinel = _refusal_run(tmp_path, home, second / "skills" / "backups")
    assert proc.returncode != 0, "只檢查了第一個帳號"
    assert not sentinel.exists()
    assert "work" in proc.stderr, f"沒說是哪個帳號：{proc.stderr[:300]!r}"


def test_refuses_when_the_source_root_does_not_exist_yet(tmp_path: Path):
    """來源根**目前不存在**時也要擋——`mkdir -p "${OUT_DIR}"` 會把它建出來。

    掃描階段對不存在的 `config_dir` 是「略過整個帳號」，但那之後 OUT_DIR 一建，祖先就
    連帶存在了；打包迴圈重新判斷時它已經是目錄，於是照樣被複製，而裡面只有 staging。
    sidecar 那側不管來源存不存在都列進 `source_roots`，這裡要一致。"""
    home, _ = _fake_home(tmp_path)
    ghost = home / ".claude-ghost"
    cfg = json.loads((home / ".fledge" / "config.json").read_text(encoding="utf-8"))
    cfg["accounts"]["ghost"] = {"config_dir": str(ghost), "label": ""}
    (home / ".fledge" / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    assert not ghost.exists()

    proc, sentinel = _refusal_run(tmp_path, home, ghost / "backups")
    assert proc.returncode != 0, "來源根還不存在就放行——OUT_DIR 一建它就存在了"
    assert not sentinel.exists()


def test_refusal_writes_nothing_to_the_filesystem(tmp_path: Path):
    """拒絕的路徑上不得對來源樹寫任何東西（Codex 票 18 R1 F2）。

    `mkdir -p "${OUT_DIR}"` 若排在 containment 之前，腳本會先在使用者的資料裡建出整段
    目錄再說「不行」——直接違反檔頭宣告的**來源全程唯讀**。

    `_refusal_run` 的哨兵只監測 `cp`，抓不到 `mkdir` 的副作用：那是我的測試盲點，
    「一個位元組都沒複製」不等於「什麼都沒寫」。"""
    home, config_dir = _fake_home(tmp_path)
    out = config_dir / "skills" / "deep" / "backups"
    proc, _ = _refusal_run(tmp_path, home, out)
    assert proc.returncode != 0
    assert not (config_dir / "skills" / "deep").exists(), \
        "拒絕之前就在來源樹裡建了目錄——來源不再是唯讀的"


def test_relative_config_dir_is_normalised_before_comparison(tmp_path: Path):
    """`config_dir` 是相對路徑時要先轉成絕對路徑再比對（Codex 票 18 R1 F1）。

    否則登記的 root 是 `ghost` 而 `out_real` 是絕對路徑，兩者永遠不匹配＝繞過。"""
    home, _ = _fake_home(tmp_path)
    workdir = tmp_path / "wd"
    workdir.mkdir()
    ghost = workdir / "ghost"      # 相對於腳本的 CWD 就是 `ghost`
    cfg = json.loads((home / ".fledge" / "config.json").read_text(encoding="utf-8"))
    cfg["accounts"]["rel"] = {"config_dir": "ghost", "label": ""}
    (home / ".fledge" / "config.json").write_text(json.dumps(cfg), encoding="utf-8")

    proc, _ = _refusal_run(tmp_path, home, ghost / "backups", cwd=workdir)
    assert proc.returncode != 0, "相對路徑的來源根沒被正規化，containment 被繞過"
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]


def test_nonexistent_source_root_under_a_symlinked_ancestor_still_blocks(tmp_path: Path):
    """尚不存在的來源根位於 **symlink 祖先**底下時也要擋（Codex 票 18 R1 F1）。

    `alias -> real` 而 `config_dir` 是 `alias/ghost`（還不存在）：`out_real` 走 `pwd -P`
    會得到 `<real>/ghost/backups`，與登記的字串 `<alias>/ghost` 對不上——繞過。

    我實作時的推論「不存在的目錄沒有 inode，也就不會有別名問題」是錯的：**別名可以在
    祖先上**。正規化要對最深的既存祖先做 `pwd -P`，再把缺的尾段接回去。"""
    home, _ = _fake_home(tmp_path)
    real = tmp_path / "real"
    real.mkdir()
    alias = home / "alias"
    alias.symlink_to(real, target_is_directory=True)
    ghost = alias / "ghost"        # 尚不存在，且祖先是連結
    cfg = json.loads((home / ".fledge" / "config.json").read_text(encoding="utf-8"))
    cfg["accounts"]["ghost"] = {"config_dir": str(ghost), "label": ""}
    (home / ".fledge" / "config.json").write_text(json.dumps(cfg), encoding="utf-8")

    proc, _ = _refusal_run(tmp_path, home, ghost / "backups")
    assert proc.returncode != 0, "symlink 祖先讓不存在的來源根繞過了 containment"
    assert "輸出目錄在備份來源裡" in proc.stderr, proc.stderr[:300]


def test_a_blank_source_root_never_matches_everything(tmp_path: Path):
    """空字串不得被登記成來源根——`case` 的 pattern 會變成 `/*`，**任何**輸出目錄都判成
    落在來源裡，備份完全不能用。

    含換行的 `config_dir` 會真的走到這一格：`accounts` 那份逐行資料被換行拆成兩行，
    第二行沒有 tab，`read -r key raw_dir` 讀到的 `raw_dir` 就是空的。這個回歸是**跑全套
    測試**才抓到的（`test_restore_shell` 用真腳本產包），單獨跑 backup 那一檔看不到。"""
    home = tmp_path / "home"
    weird = home / "we\nird"
    (weird / "skills").mkdir(parents=True)
    (weird / "skills" / "demo.md").write_text("x", encoding="utf-8")
    fledge = home / ".fledge"
    fledge.mkdir()
    (fledge / "config.json").write_text(json.dumps({
        "version": 1, "roots": [],
        "accounts": {"default": {"config_dir": str(weird), "label": ""}},
    }), encoding="utf-8")

    out = tmp_path / "out"     # 明顯不在任何來源樹裡
    env = {**os.environ, "HOME": str(home)}
    env.pop("FLEDGE_BACKUP_DIR", None)
    # **CWD 刻意設在 `tmp_path`**：空字串經過 `resolve_path` 會變成 CWD 而不是留著空——
    # 登記它一樣是錯的（把跑腳本的目錄當成備份來源）。CWD 若與 `out` 無關，這條測試就
    # 只是「空的來源根沒有變成 `/*`」而驗不到「根本不該登記」，是假綠。
    proc = subprocess.run(["/bin/bash", str(SCRIPT), "-o", str(out)],
                          capture_output=True, text=True, env=env, timeout=120,
                          cwd=str(tmp_path))
    assert proc.returncode == 0, f"空的來源根把一切都擋掉了：{proc.stderr[:300]!r}"
    assert list(out.glob("claude-backup-*.tar.gz"))


def test_script_and_sidecar_agree_on_containment(tmp_path: Path):
    """**對帳**：腳本與 sidecar 這兩份實作對同一組落點要給相同結論。

    腳本裡有一份是刻意的——它必須能獨立執行、拿不到 sidecar 的 Python——但兩邊漂移的話
    就會出現「GUI 擋、CLI 放行」（或反過來），而使用者不知道自己走的是哪一條。這正是
    票 08／09 被連抓三輪的那一族：規則寫兩份必然漂移，除非有東西釘住。"""
    from fledge_sidecar.app_config import AppConfig
    from fledge_sidecar.backup.containment import check_backup_dir, source_roots

    home, config_dir = _fake_home(tmp_path)
    cfg = AppConfig(path=tmp_path / "cfg.json",
                    accounts={"default": {"config_dir": str(config_dir), "label": ""}})
    roots = source_roots(cfg, str(REPO / "scripts"))

    cases = {
        "asset": config_dir / "skills" / "backups",
        "coarse": config_dir / "backups",
        "itself": config_dir,
        "outside": tmp_path / "elsewhere",
    }
    for tag, out in cases.items():
        sidecar_blocks = check_backup_dir(str(out), roots) != "ok"
        proc, _ = _refusal_run(tmp_path, home, out, tag=tag)
        script_blocks = proc.returncode != 0
        assert script_blocks == sidecar_blocks, (
            f"[{tag}] {out}：腳本擋={script_blocks} 但 sidecar 擋={sidecar_blocks}"
        )
    # 前提哨兵：這組案例必須真的涵蓋兩種結論，否則「全擋」或「全放行」也會讓上面全綠
    verdicts = {check_backup_dir(str(o), roots) != "ok" for o in cases.values()}
    assert verdicts == {True, False}, "案例沒有涵蓋擋與不擋兩種結論"


def test_manifest_lists_exactly_what_was_packed(tmp_path: Path):
    """manifest 必須由**打包結果**產生，不是打包完再對現役來源問一次（Codex 票 17 R1 F1）。

    兩段各自探測時，中間的變化會讓 manifest 與包內容對不上：來源在打包後消失，包裡有
    `extra/.agents` 而 manifest 沒有那個 key——還原端靠 manifest 列出可搬的項目，於是
    **已經備份到的資料選不出來**。反向變化則讓 manifest 宣稱一個包裡沒有的項目。

    判準逐字一致（三處都是 `-d`）只解決了「判準不同」那一半，沒解決「觀測時機不同」。

    造法：假的 `cp` 在處理到 `config.json` 那一步（extra 已複製完、manifest 尚未產生）
    抽掉來源。這是唯一能精準落在兩段之間的 hook。"""
    home, _ = _fake_home(tmp_path)
    _symlinked_agents(tmp_path, home)
    fake = _fake_bin(tmp_path, "cp", (
        "#!/bin/sh\n"
        "for a in \"$@\"; do\n"
        f"  case \"$a\" in *config.json) rm -f '{home}/.agents' ;; esac\n"
        "done\n"
        "exec /bin/cp \"$@\"\n"
    ))
    out = tmp_path / "out"
    proc = _run(["-o", str(out)], home,
                extra_env={"PATH": f"{fake}:{os.environ['PATH']}"})
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    dest = tmp_path / "unpacked"
    with tarfile.open(bundle) as tf:
        tf.extractall(dest, filter="tar")

    packed = (dest / "extra" / ".agents").is_dir()
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    assert packed, "前提變了：extra 根本沒被打包，這條測試證明不了東西"
    assert ".agents" in manifest["extra"], "包裡有，manifest 卻沒有——還原端選不到它"


def test_a_link_to_a_file_is_skipped_too(tmp_path: Path):
    """`-d` 是**跟隨**判定：指向檔案的連結同樣不是目錄樹，走同一條跳過路徑。"""
    home, _ = _fake_home(tmp_path)
    lone = tmp_path / "lone.txt"
    lone.write_text("x", encoding="utf-8")
    (home / ".agents").symlink_to(lone)
    proc = _run(["--list", "-o", str(tmp_path / "out")], home)
    assert proc.returncode == 0, proc.stderr
    assert "不是目錄" in proc.stdout

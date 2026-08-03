"""`scripts/restore-claude.sh` 的行為契約。

一律用假的 HOME 與自己造的備份包——**絕不碰真實的 Claude 目錄，也不對真實備份目錄寫入**
（票 09 的硬性要求）。還原的核心不變式是「不寫任何現役目錄」，測試自己也守同一條線：
所有路徑都在 tmp_path 底下，連「現役目錄」都是造出來的。
"""
import json
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "restore-claude.sh"
BACKUP_SCRIPT = REPO / "scripts" / "backup-claude.sh"


def _fake_home(tmp_path: Path, name: str = "home") -> tuple[Path, Path]:
    """假 HOME：一個帳號目錄（＝待比對的「現役目錄」）+ 一份 Fledge config。

    `name` 讓需要特殊字元的測試（含單引號的路徑）換掉目錄名，其餘結構完全相同。"""
    home = tmp_path / name
    config_dir = home / ".claude"
    (config_dir / "skills").mkdir(parents=True)
    (config_dir / "skills" / "demo.md").write_text("live", encoding="utf-8")
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


def _make_bundle(tmp_path: Path, home: Path) -> Path:
    """用**真正的備份腳本**產一份備份包。手工造 tar 只能證明「restore 讀得懂我造的東西」，
    跑真的產生端才連兩支腳本的相容性（`accounts/<key>/` 佈局、manifest 欄位）一起鎖住。"""
    out = tmp_path / "bundles"
    env = {**os.environ, "HOME": str(home)}
    env.pop("FLEDGE_BACKUP_DIR", None)
    proc = subprocess.run(
        ["/bin/bash", str(BACKUP_SCRIPT), "-o", str(out)],
        capture_output=True, text=True, env=env, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    return bundle


def _run(args: list[str], home: Path, extra_env: dict | None = None):
    env = {**os.environ, "HOME": str(home)}
    env.pop("FLEDGE_BACKUP_DIR", None)
    env.update(extra_env or {})
    return subprocess.run(
        ["/bin/bash", str(SCRIPT), *args],
        capture_output=True, text=True, env=env, timeout=120,
    )


def _snapshot(root: Path) -> dict[str, bytes | str]:
    """現役目錄的內容快照，用來證明還原沒寫進去。"""
    out: dict[str, bytes | str] = {}
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        if p.is_symlink():
            out[rel] = f"link:{os.readlink(p)}"
        elif p.is_file():
            out[rel] = p.read_bytes()
        else:
            out[rel] = "dir"
    return out


def _fake_bin(tmp_path: Path, name: str, body: str) -> Path:
    d = tmp_path / "fakebin"
    d.mkdir(exist_ok=True)
    f = d / name
    f.write_text(body, encoding="utf-8")
    f.chmod(0o755)
    return d


# ── 備份包來源必須明確 ────────────────────────────────────────────────────────


def test_no_personal_path_left_in_script():
    """公開 repo 不能留開發者的個人路徑（原本第 19 行寫死了一個備份目錄）。"""
    assert "/Users/tc" not in SCRIPT.read_text(encoding="utf-8")


def test_fails_without_bundle_or_backup_dir(tmp_path: Path):
    """既沒給備份包、也沒給 FLEDGE_BACKUP_DIR → 明確報錯。

    移除硬編碼預設值後不能默默去某個對這台機器以外沒有意義的路徑找包；`backup-claude.sh`
    的輸出目錄早已改成必填，兩支腳本要一致。"""
    home, _ = _fake_home(tmp_path)
    proc = _run([], home)
    assert proc.returncode != 0
    assert proc.stderr.strip() != ""


def test_picks_newest_bundle_from_env_dir(tmp_path: Path):
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    proc = _run(["-o", str(dest)], home,
                extra_env={"FLEDGE_BACKUP_DIR": str(bundle.parent)})
    assert proc.returncode == 0, proc.stderr
    assert (dest / "manifest.json").is_file()


# ── 展開的原子性（驗收 #4）────────────────────────────────────────────────────


def _dying_tar(tmp_path: Path) -> Path:
    """假的 tar：**先在解壓目標裡寫東西再失敗**——模擬壞包／磁碟滿／被中斷這種「已經開始
    解才死」的情境。直接 exit 1 的假 tar 不會產生任何檔案，那樣測到的是假綠：它證明不了
    原子性，只證明了「沒寫就沒有殘骸」。`tar xzf <包> -C <目錄>` → $4 是目標目錄。"""
    return _fake_bin(
        tmp_path, "tar",
        '#!/bin/sh\ncase "$1" in *x*) mkdir -p "$4" 2>/dev/null;'
        ' echo garbage > "$4/half-extracted" ;; esac\nexit 1\n',
    )


def test_dest_is_not_created_when_extraction_fails(tmp_path: Path):
    """解壓失敗時 DEST 必須根本不存在——留一棵解到一半的樹，使用者會拿它當還原結果，
    而它缺的正是他要找的那些檔案。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    proc = _run([str(bundle), "-o", str(dest)], home,
                extra_env={"PATH": f"{_dying_tar(tmp_path)}:{os.environ['PATH']}"})
    assert proc.returncode != 0
    assert not dest.exists()
    # 驗收 #4 要的是「明確說明」：tar 的原文只說解壓失敗，說不出那代表備份包壞了
    assert "損壞" in proc.stderr


def test_no_staging_residue_when_extraction_fails(tmp_path: Path):
    """半套目錄也不能留在 DEST 旁邊：每次失敗都留一份會慢慢吃掉磁碟。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "sub" / "restored"
    _run([str(bundle), "-o", str(dest)], home,
         extra_env={"PATH": f"{_dying_tar(tmp_path)}:{os.environ['PATH']}"})
    leftovers = [p.name for p in (tmp_path / "sub").iterdir()] if (tmp_path / "sub").exists() else []
    assert leftovers == [], leftovers


def test_bundle_without_manifest_is_rejected_and_leaves_nothing(tmp_path: Path):
    """不完整的備份包（缺 manifest.json）要明確說明，且不留下半套目錄。

    manifest 是差異報告的唯一依據；缺了它，比對根本無從進行——與其解出一棵沒用的樹再
    報錯，不如在發布前就擋下。"""
    home, _ = _fake_home(tmp_path)
    junk = tmp_path / "junk"
    (junk / "accounts" / "default").mkdir(parents=True)
    (junk / "accounts" / "default" / "x.md").write_text("x", encoding="utf-8")
    bundle = tmp_path / "claude-backup-20260101-1200.tar.gz"
    subprocess.run(["tar", "czf", str(bundle), "-C", str(junk), "."], check=True, timeout=60)

    dest = tmp_path / "restored"
    proc = _run([str(bundle), "-o", str(dest)], home)
    assert proc.returncode != 0
    assert "manifest" in (proc.stderr + proc.stdout)
    assert not dest.exists()


def test_refuses_non_empty_dest_without_touching_it(tmp_path: Path):
    """展開目標非空一律拒絕——絕不往既有內容上疊。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    dest.mkdir()
    (dest / "mine.txt").write_text("MINE", encoding="utf-8")

    proc = _run([str(bundle), "-o", str(dest)], home)
    assert proc.returncode != 0
    assert (dest / "mine.txt").read_text(encoding="utf-8") == "MINE"
    assert list(dest.iterdir()) == [dest / "mine.txt"]


def test_empty_existing_dest_is_usable(tmp_path: Path):
    """使用者用系統選擇器挑位置時，挑到的必然是**已存在**的目錄；空的就該能用，
    否則整個「選一個位置」的動作在 GUI 裡不可能成功。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    dest.mkdir()
    proc = _run([str(bundle), "-o", str(dest)], home)
    assert proc.returncode == 0, proc.stderr
    assert (dest / "manifest.json").is_file()


# ── 展開 + 差異報告（驗收 #1／#2）────────────────────────────────────────────


def test_extracts_and_reports_three_kinds_of_difference(tmp_path: Path):
    home, live = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    # 備份之後動現役目錄，造出三類差異各一
    (live / "skills" / "demo.md").write_text("changed after backup", encoding="utf-8")
    (live / "skills" / "added-later.md").write_text("new", encoding="utf-8")
    (live / "settings.json").unlink()

    dest = tmp_path / "restored"
    proc = _run([str(bundle), "-o", str(dest)], home)
    assert proc.returncode == 0, proc.stderr

    assert (dest / "accounts" / "default" / "skills" / "demo.md").is_file()
    out = proc.stdout
    assert "只在備份裡有" in out          # settings.json 被刪掉了
    assert "只在現役有" in out            # added-later.md
    assert "兩邊都有但不同" in out        # demo.md 大小變了
    assert "settings.json" in out


def test_live_directory_is_never_written(tmp_path: Path):
    """驗收 #1／#6：現役目錄完全未被寫入。內容快照逐項比對，不只看「還在不在」。"""
    home, live = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    (live / "skills" / "demo.md").write_text("changed after backup", encoding="utf-8")
    before = _snapshot(live)

    proc = _run([str(bundle), "-o", str(tmp_path / "restored")], home)
    assert proc.returncode == 0, proc.stderr
    assert _snapshot(live) == before


def test_diff_only_reuses_an_existing_extraction(tmp_path: Path):
    """--diff-only 不重解：大包重解一次要十幾秒，而使用者常常只是想再看一次差異。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    assert _run([str(bundle), "-o", str(dest)], home).returncode == 0
    marker = dest / "accounts" / "default" / "skills" / "demo.md"
    marker.write_text("touched", encoding="utf-8")   # 重解的話這個記號會被蓋掉

    proc = _run(["--diff-only", "-o", str(dest)], home)
    assert proc.returncode == 0, proc.stderr
    assert marker.read_text(encoding="utf-8") == "touched"
    assert "兩邊都有但不同" in proc.stdout


# ── 展開位置的 containment（Codex 對抗式審查 finding 1）──────────────────────
# 票 09 驗收 #6 的措辭是「根本沒有那條路」而不是「預設不寫」：GUI 那層擋得住不代表
# 直接跑腳本的人擋得住，所以同一組規則在腳本裡也要有一份。


def test_refuses_dest_inside_a_live_account_dir(tmp_path: Path):
    """展開到現役帳號目錄裡面＝把一份完整副本折回備份來源，下次備份會再收一遍。"""
    home, live = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    before = _snapshot(live)

    dest = live / "restored"
    proc = _run([str(bundle), "-o", str(dest)], home)
    assert proc.returncode != 0
    assert not dest.exists()
    assert _snapshot(live) == before          # 現役目錄一個位元都沒動


def test_refuses_dest_that_is_a_live_account_dir_itself(tmp_path: Path):
    home, live = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    before = _snapshot(live)
    proc = _run([str(bundle), "-o", str(live)], home)
    assert proc.returncode != 0
    assert _snapshot(live) == before


def test_refuses_home_and_root(tmp_path: Path):
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    for dest in (str(home), "/"):
        proc = _run([str(bundle), "-o", dest], home)
        assert proc.returncode != 0, dest


def test_refuses_dest_inside_an_extra_source_path(tmp_path: Path):
    """`~/.agents` 這類帳號目錄外的來源同樣是備份來源——判定要讀共用清單檔，
    不能只看帳號目錄（否則兩邊的 containment 認定會漂移）。"""
    home, _ = _fake_home(tmp_path)
    agents = home / ".agents"
    agents.mkdir()
    bundle = _make_bundle(tmp_path, home)
    proc = _run([str(bundle), "-o", str(agents / "restored")], home)
    assert proc.returncode != 0
    assert not (agents / "restored").exists()


def test_still_allows_a_normal_location_outside_the_source_tree(tmp_path: Path):
    """防呆不能寬到把正常位置也擋掉。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    proc = _run([str(bundle), "-o", str(dest)], home)
    assert proc.returncode == 0, proc.stderr
    assert (dest / "manifest.json").is_file()


def test_missing_shared_list_file_is_not_fatal(tmp_path: Path):
    """共用清單檔讀不到時仍要能跑（比照備份腳本）。`live_roots` 最後一個 `[ -f ]` 為假時
    函式回非零——process substitution 會吞掉它，但這條測試把「吞得掉」變成有人守著的事實。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    lonely = tmp_path / "lonely"
    lonely.mkdir()
    copy = lonely / "restore-claude.sh"
    copy.write_text(SCRIPT.read_text(encoding="utf-8"), encoding="utf-8")
    proc = subprocess.run(
        ["/bin/bash", str(copy), str(bundle), "-o", str(tmp_path / "restored")],
        capture_output=True, text=True,
        env={**os.environ, "HOME": str(home)}, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr


def _config_with_account(home: Path, config_dir: Path) -> None:
    (home / ".fledge" / "config.json").write_text(
        json.dumps({"version": 1, "roots": [],
                    "accounts": {"work": {"config_dir": str(config_dir), "label": ""}}}),
        encoding="utf-8")


def test_root_set_matches_the_sidecar_when_config_is_readable(tmp_path: Path):
    """腳本的來源認定要**等於** sidecar 的 `source_roots`（登記的帳號 ∪ 共用清單），
    不能無條件多守一個 `~/.claude`——那會讓「帳號都不在 ~/.claude 的使用者選了
    ~/.claude/x」變成 GUI 說可以、按下去卻被腳本擋。兩層規則不一致比少守一個預設目錄更糟。"""
    home, _ = _fake_home(tmp_path)
    other = home / ".claude-work"
    other.mkdir()
    _config_with_account(home, other)
    bundle = _make_bundle(tmp_path, home)

    proc = _run([str(bundle), "-o", str(home / ".claude" / "restored")], home)
    assert proc.returncode == 0, proc.stderr          # 未登記＝不在來源集合裡
    proc = _run([str(bundle), "-o", str(other / "restored")], home)
    assert proc.returncode != 0                       # 登記的那個仍然擋


def test_falls_back_to_default_dir_when_config_is_unreadable(tmp_path: Path):
    """設定檔缺席（移機到新機還沒設定 Fledge，最常見的還原情境）時仍守住 `~/.claude`。
    **這不是 fail-open**：判斷不出來時不是放行，而是退回一個必然成立的預設。"""
    home, live = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    (home / ".fledge" / "config.json").unlink()

    before = _snapshot(live)
    proc = _run([str(bundle), "-o", str(live / "restored")], home)
    assert proc.returncode != 0
    assert _snapshot(live) == before


def test_refuses_when_config_exists_but_cannot_be_understood(tmp_path: Path):
    """設定檔存在卻讀不懂就整個停手，不退回預設值（Codex R2 finding 1）。

    退回 `~/.claude` 等於在「使用者有自訂帳號目錄、但我們讀不到是哪些」時只守一個目錄、
    其餘來源全裸——判斷不出來時一律不動手，而不是照做。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    cfg = home / ".fledge" / "config.json"
    dest = tmp_path / "restored"

    for payload in ('{"accounts": ', '{"accounts": []}', 'not json at all'):
        cfg.write_text(payload, encoding="utf-8")
        proc = _run([str(bundle), "-o", str(dest)], home)
        assert proc.returncode != 0, payload
        assert not dest.exists(), payload


def test_refuses_when_config_is_unreadable(tmp_path: Path):
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    cfg = home / ".fledge" / "config.json"
    cfg.chmod(0o000)
    try:
        proc = _run([str(bundle), "-o", str(tmp_path / "restored")], home)
        assert proc.returncode != 0
    finally:
        cfg.chmod(0o600)   # 還原否則 tmp_path 清不掉


def test_home_with_a_quote_still_reads_the_accounts(tmp_path: Path):
    """HOME 含單引號時，設定檔路徑若被插值進 Python 程式碼會變成語法錯誤，而那個錯誤
    會被當成「沒有帳號」——防呆最不該有的失敗方向。路徑必須走 argv。

    備份包也在同一個含單引號的 HOME 下產生。票 11 把 `backup-claude.sh` 一併改成 argv
    寫法之前這裡做不到（產生端自己會 SyntaxError），得先在正常 HOME 下產包再換過來。"""
    home, live = _fake_home(tmp_path, name="ho'me")
    bundle = _make_bundle(tmp_path, home)

    proc = _run([str(bundle), "-o", str(live / "restored")], home)
    assert proc.returncode != 0, "帳號讀得到就該擋下來源樹內的位置"
    assert not (live / "restored").exists()
    # 正常位置仍可用（證明不是因為整個腳本壞掉才失敗）
    ok = _run([str(bundle), "-o", str(home / "restored")], home)
    assert ok.returncode == 0, ok.stderr


# ── 與 sidecar 的規則等價（Codex R3）────────────────────────────────────────
# 規則寫兩份必然漂移，而漂移的具體樣態就是「GUI 擋、腳本放行」或反過來。


def test_malformed_account_falls_back_like_the_sidecar(tmp_path: Path):
    """缺 `config_dir` 的畸形 account，`source_roots` 會把它當成 `~/.claude`。腳本若改成
    「略過」，就會出現「GUI 判 inside_source 擋下、直接跑腳本卻放行」。"""
    home, live = _fake_home(tmp_path)
    custom = home / ".claude-work"
    custom.mkdir()
    (home / ".fledge" / "config.json").write_text(
        json.dumps({"version": 1, "roots": [], "accounts": {
            "work": {"config_dir": str(custom), "label": ""},
            "broken": {"label": "缺 config_dir"},
        }}), encoding="utf-8")
    bundle = _make_bundle(tmp_path, home)

    before = _snapshot(live)
    proc = _run([str(bundle), "-o", str(live / "restored")], home)
    assert proc.returncode != 0, "畸形 account 退回的 ~/.claude 必須照樣守住"
    assert _snapshot(live) == before
    assert _run([str(bundle), "-o", str(custom / "restored")], home).returncode != 0


def test_path_with_a_newline_is_not_split_into_two_roots(tmp_path: Path):
    """含換行的 `config_dir`：前一版把 root 清單以換行序列化再逐行切割，會把一個路徑拆成
    兩個 root，其內的 DEST 因此匹配不到任何一個——資料與分隔符混用的典型繞過。"""
    home = tmp_path / "home"
    live = home / "live\nname"
    (live / "skills").mkdir(parents=True)
    (live / "skills" / "demo.md").write_text("live", encoding="utf-8")
    (home / ".fledge").mkdir()
    _config_with_account(home, live)
    bundle = _make_bundle(tmp_path, home)

    proc = _run([str(bundle), "-o", str(live / "restored")], home)
    assert proc.returncode != 0
    assert not (live / "restored").exists()


def test_refuses_when_config_is_not_a_regular_file(tmp_path: Path):
    """目錄、壞掉的 symlink 這類「存在但讀不懂」的狀態，不能因為 `-f` 為假就退回預設。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    cfg = home / ".fledge" / "config.json"
    dest = tmp_path / "restored"

    cfg.unlink()
    cfg.mkdir()
    assert _run([str(bundle), "-o", str(dest)], home).returncode != 0, "目錄"
    cfg.rmdir()

    cfg.symlink_to(tmp_path / "nowhere")
    assert _run([str(bundle), "-o", str(dest)], home).returncode != 0, "壞掉的 symlink"
    assert not dest.exists()


def test_root_source_blocks_everything_like_the_sidecar(tmp_path: Path):
    """`config_dir` 是 `/` 時（帳號 API 只拒空白與相對路徑，這個值收得下），整個檔案系統
    都算現役來源。`root + os.sep` 不先 rstrip 會組出 `//`，任何絕對路徑都不以它開頭——
    等於那個 root 完全沒守，而 sidecar 的 `is_within_root` 先 rstrip 所以會擋。

    這條同時是**跨層對帳**：同一組輸入，腳本與 `check_dest()` 必須給同一個答案。"""
    from fledge_sidecar.backup import restore as restore_mod

    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)      # 先用正常設定產包，再把 config 改成 "/"
    (home / ".fledge" / "config.json").write_text(
        json.dumps({"version": 1, "roots": [],
                    "accounts": {"work": {"config_dir": "/", "label": ""}}}),
        encoding="utf-8")

    dest = tmp_path / "restored"
    proc = _run([str(bundle), "-o", str(dest)], home)
    assert proc.returncode != 0
    assert not dest.exists()
    assert restore_mod.check_dest(str(dest), ["/"]) == "inside_source"   # 兩層同一個答案


def test_case_alias_is_recognised_by_identity_not_by_case_folding(tmp_path: Path):
    """兩層對大小寫的處理必須一致：無條件轉小寫會在 case-sensitive volume 上過嚴（GUI 說
    可以、腳本卻拒絕），所以改走 inode 身分。

    **刻意用空的別名目錄，並斷言擋下的理由**：拿 home 的別名去測會過，但那是「非空即拒絕」
    先擋下的，與身分判定無關——斷言通過的理由與它宣稱的不同，就是假綠（這條原本就是這樣
    寫的，靠 mutant 才發現）。"""
    import pytest

    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    work = home / ".claude-work"
    work.mkdir()                       # 空目錄：非空檢查不會搶先擋下
    _config_with_account(home, work)
    alias = home / ".CLAUDE-WORK"
    if not alias.is_dir():
        pytest.skip("此卷區分大小寫，沒有大小寫別名可測")

    proc = _run([str(bundle), "-o", str(alias)], home)
    assert proc.returncode != 0
    assert "現役的 Claude 資料" in proc.stderr, proc.stderr


def test_case_alias_of_home_itself_is_refused_as_home(tmp_path: Path):
    """`same_dir` 的 inode 那半。同樣要斷言理由——只看 returncode 的話，「非空即拒絕」
    會讓這條在身分判定壞掉時照樣通過。"""
    import pytest

    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    alias = str(home).replace("home", "HOME")
    if not Path(alias).is_dir():
        pytest.skip("此卷區分大小寫，沒有大小寫別名可測")

    proc = _run([str(bundle), "-o", alias], home)
    assert proc.returncode != 0
    assert "家目錄" in proc.stderr, proc.stderr


def test_publish_refuses_when_dest_appeared_during_extraction(tmp_path: Path):
    """**發布必須是 no-replace 的**：`mv A B` 在 B 是既有目錄時會把 A 移**進去**，於是
    另一個程序在我們解壓期間搶先發布時，我們會把整棵樹藏進它裡面——而且因為 DEST 底下
    有（別人的）manifest.json，腳本還會照樣印出成功的差異報告。整套設計最反對的假成功。

    競態窗口在「檢查 DEST 空不空」與「發布」之間，只有微秒——**單靠併行跑兩個程序碰不到
    它**（下面那條就是這樣，退回 mv 也照樣綠）。這裡用假 tar 在解壓期間把 DEST 建出來，
    確定性地重現那一刻。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    rival = _fake_bin(
        tmp_path, "tar",
        '#!/bin/sh\ncase "$1" in *x*) mkdir -p "$RIVAL_DEST";'
        ' echo other > "$RIVAL_DEST/manifest.json" ;; esac\nexec /usr/bin/tar "$@"\n',
    )
    proc = _run([str(bundle), "-o", str(dest)], home,
                extra_env={"PATH": f"{rival}:{os.environ['PATH']}", "RIVAL_DEST": str(dest)})

    assert proc.returncode != 0
    assert (dest / "manifest.json").read_text(encoding="utf-8").strip() == "other"  # 別人的沒被動
    assert [p.name for p in dest.iterdir()] == ["manifest.json"], "我們的樹被藏進去了"


def test_concurrent_restores_to_the_same_dest(tmp_path: Path):
    """端到端：兩個還原同時解到同一個 DEST，恰有一個成功。

    **這條碰不到發布那一刻的競態**（上面那條才是），它守的是整條路徑不會兩個都成功。
    假 HOME 很小，兩個程序不做事就會先後跑完、根本不重疊——用會拖慢的 tar 造出重疊窗口
    （比照 test_backup_shell）。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    slow_tar = _fake_bin(
        tmp_path, "tar",
        '#!/bin/sh\ncase "$1" in *x*) sleep 1 ;; esac\nexec /usr/bin/tar "$@"\n',
    )
    env = {**os.environ, "HOME": str(home), "PATH": f"{slow_tar}:{os.environ['PATH']}"}
    env.pop("FLEDGE_BACKUP_DIR", None)
    procs = [
        subprocess.Popen(
            ["/bin/bash", str(SCRIPT), str(bundle), "-o", str(dest)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        for _ in range(2)
    ]
    for proc in procs:
        proc.wait(timeout=180)

    assert sum(1 for p in procs if p.returncode == 0) == 1, "應恰有一個成功、一個讓位"
    assert (dest / "manifest.json").is_file()
    # 第二份不得藏在第一份裡面，殘骸也不該留在旁邊
    nested = [p.name for p in dest.iterdir() if p.name.startswith(".")]
    assert nested == [], nested
    assert list(tmp_path.glob(".*fledge-restore*")) == []


# ── 中斷後不留殘骸（真機驗收 B7）──────────────────────────────────────────────
# 關掉設定頁時 sidecar 收掉 PTY，ptyprocess 依序送 SIGHUP→SIGCONT→SIGINT，**0.3 秒後升到
# SIGKILL**。EXIT trap 在掛斷時確實會跑（下面第一條測的就是這個），但 `rm -rf` 幾百 MB 要
# 好幾秒——真機驗收就是這樣在家目錄留下 525MB 的隱藏 staging：清到一半被 SIGKILL 砍掉。
# 所以真正的保證是「下一次還原順手回收超齡殘骸」，trap 只負責清得完的那些。


def test_hangup_during_extraction_leaves_nothing(tmp_path: Path):
    """掛斷時 EXIT trap 會執行——staging 還小的時候清得完，DEST 也不會被建出來。"""
    import signal

    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dest = tmp_path / "restored"
    slow = _fake_bin(
        tmp_path, "tar",
        '#!/bin/sh\ncase "$1" in *x*) sleep 3 ;; esac\nexec /usr/bin/tar "$@"\n',
    )
    env = {**os.environ, "HOME": str(home), "PATH": f"{slow}:{os.environ['PATH']}"}
    env.pop("FLEDGE_BACKUP_DIR", None)
    proc = subprocess.Popen(
        ["/bin/bash", str(SCRIPT), str(bundle), "-o", str(dest)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
    )
    # 等 staging 建出來、tar 開始跑，再模擬掛斷
    for _ in range(50):
        if list(tmp_path.glob(".*fledge-restore*")):
            break
        subprocess.run(["sleep", "0.1"], check=False)
    proc.send_signal(signal.SIGHUP)
    proc.wait(timeout=30)

    assert proc.returncode != 0
    assert not dest.exists(), "中斷不得留下半套的展開結果"
    assert list(tmp_path.glob(".*fledge-restore*")) == [], "staging 殘骸沒被清掉"


def _stale(path: Path) -> Path:
    path.mkdir(parents=True)
    (path / "junk").write_bytes(b"x")
    old = os.path.getmtime(path) - 3 * 3600
    os.utime(path, (old, old))
    return path


def test_stale_staging_is_reclaimed_on_the_next_run(tmp_path: Path):
    """SIGKILL／斷電時 trap 不會執行（rm -rf 幾百 MB 要好幾秒，而 SIGKILL 在 0.3 秒後就到），
    殘骸會留在家目錄。下一次還原順手回收——比照 backup-claude.sh 對 .partial 的做法。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    ours = _stale(tmp_path / "..old-restore.fledge-restore-12345-678.partial")

    assert _run([str(bundle), "-o", str(tmp_path / "restored")], home).returncode == 0
    assert not ours.exists()


def test_staging_of_a_live_process_is_kept(tmp_path: Path):
    """產生它的程序還活著就不能刪：那多半是另一個正在跑的還原。用**測試自己的 PID**
    ——`kill -0` 對 root 的 PID 回 EPERM（存在但簽不到），那代表「不是我們的程序」，
    拿系統 PID 來測會測到相反的分支。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    fresh = tmp_path / f"..other.fledge-restore-{os.getpid()}-111.partial"
    fresh.mkdir()

    assert _run([str(bundle), "-o", str(tmp_path / "restored")], home).returncode == 0
    assert fresh.exists()


def test_reclaim_only_deletes_our_exact_naming(tmp_path: Path):
    """只刪本腳本自己產生的命名（含 PID 與隨機段）。這是在**使用者的家目錄**裡遞迴刪除，
    命名認定寬一格的代價是刪掉別人的東西。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    keepers = [
        _stale(tmp_path / "..x.fledge-restore-.partial"),          # 空 PID 段
        _stale(tmp_path / "..x.fledge-restore-abc-def.partial"),   # 非數字
        _stale(tmp_path / "..x.fledge-restore-12345.partial"),     # 缺隨機段
        _stale(tmp_path / "important.partial"),
        _stale(tmp_path / ".fledge-restore-12345-678"),            # 缺 .partial 後綴
    ]

    assert _run([str(bundle), "-o", str(tmp_path / "restored")], home).returncode == 0
    for k in keepers:
        assert k.exists(), k.name


def test_abandoned_staging_is_reclaimed_immediately(tmp_path: Path):
    """產生它的程序已經不在＝確定棄置，不必等年齡閘。「中斷 → 立刻重跑」是最自然的反應，
    只靠 60 分鐘閘的話那份殘骸（可能幾百 MB）要在家目錄留一小時（真機驗收 B7）。"""
    home, _ = _fake_home(tmp_path)
    bundle = _make_bundle(tmp_path, home)
    dead = tmp_path / "..abandoned.fledge-restore-999999-42.partial"   # macOS PID 上限 99998
    dead.mkdir()
    (dead / "junk").write_bytes(b"x")

    assert _run([str(bundle), "-o", str(tmp_path / "restored")], home).returncode == 0
    assert not dead.exists()


# ── 惡意備份包：內容是不可信輸入（票 12）──────────────────────────────────────
#
# 威脅情境是**社交工程**——使用者從網路下載一份假的「備份包」。這在名字模式下就成立
# （把它放進 backup_dir 即可），不是票 11 的路徑模式新增的。

SENTINEL = "SHELL-LEAK-SENTINEL-4711"


def _evil_bundle(where: Path, members) -> Path:
    """手工造包。`members` 是 (name, kind, payload) 的序列：
    kind="file" → payload 是內容字串；kind="link" → payload 是 symlink 目標。

    這裡**不能**用 `_make_bundle`（真的備份腳本）——它產不出惡意成員。"""
    import io
    import tarfile

    where.mkdir(parents=True, exist_ok=True)
    bundle = where / "claude-backup-20260101-1200.tar.gz"
    with tarfile.open(bundle, "w:gz") as tf:
        for name, kind, payload in members:
            if kind == "file":
                raw = payload.encode()
                ti = tarfile.TarInfo(name)
                ti.size = len(raw)
                tf.addfile(ti, io.BytesIO(raw))
            else:
                ti = tarfile.TarInfo(name)
                ti.type = tarfile.SYMTYPE
                ti.linkname = payload
                tf.addfile(ti)
    return bundle


def test_manifest_that_is_a_symlink_is_refused_and_never_read(tmp_path: Path):
    """**這是本票的核心**：`[ -f ]` 與 `json.load(open(...))` 都跟隨 symlink，所以一份把
    `manifest.json` 做成 symlink 的包，會讓腳本解析包外的檔案並把欄位印在 PTY 上。

    哨兵斷言比「回非零」重要得多——擋下來卻還是把內容印出去，等於沒擋。"""
    home, _ = _fake_home(tmp_path)
    secret = tmp_path / "secret.json"
    secret.write_text(json.dumps({"created": SENTINEL, "host": SENTINEL}), encoding="utf-8")
    bundle = _evil_bundle(tmp_path / "evil", [
        ("accounts/default/settings.json", "file", "{}"),
        ("manifest.json", "link", str(secret)),
    ])
    dest = tmp_path / "unpacked"

    proc = _run([str(bundle), "-o", str(dest)], home)

    assert proc.returncode != 0, proc.stdout
    assert SENTINEL not in proc.stdout
    assert SENTINEL not in proc.stderr
    assert not dest.exists()          # 不完整的包不留半套目錄


def test_diff_only_also_refuses_a_symlinked_manifest(tmp_path: Path):
    """`--diff-only` 跳過解壓、直接讀既有展開目錄的 manifest——那條路上原本沒有任何驗證。"""
    home, _ = _fake_home(tmp_path)
    secret = tmp_path / "secret.json"
    secret.write_text(json.dumps({"created": SENTINEL, "host": SENTINEL}), encoding="utf-8")
    dest = tmp_path / "already-unpacked"
    (dest / "accounts").mkdir(parents=True)
    (dest / "manifest.json").symlink_to(secret)

    proc = _run(["--diff-only", "-o", str(dest)], home)

    assert proc.returncode != 0, proc.stdout
    assert SENTINEL not in proc.stdout
    assert SENTINEL not in proc.stderr


def _escape_bundle(tmp_path: Path, name: str, extra_members) -> Path:
    """一份**正常**的包（manifest + 一個帳號檔）再加上一個逃逸成員。

    正常成員是必要的：沒有它就無法分辨「逃逸被擋下」與「整個包根本沒被解開」。"""
    return _evil_bundle(tmp_path / name, [
        ("manifest.json", "file", json.dumps({"created": "x", "accounts": {}})),
        ("accounts/default/ok.txt", "file", "fine"),
        *extra_members,
    ])


def test_absolute_member_lands_inside_the_container_not_outside(tmp_path: Path):
    """釘住 libarchive 的預設：絕對路徑成員被剝掉前導 `/`，內容落在展開目錄**裡面**。

    實測 tar 對這一種**回 0**（只是警告），所以整個還原會正常走完——斷言的重點是
    「那個成員確實被處理了、而且落在容器內」，不是「腳本失敗」。"""
    home, _ = _fake_home(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    bundle = _escape_bundle(tmp_path, "b-abs", [(str(outside / "pwned.txt"), "file", "ABS")])
    dest = tmp_path / "unpacked"

    proc = _run([str(bundle), "-o", str(dest)], home)

    assert proc.returncode == 0, proc.stderr
    assert list(outside.iterdir()) == []                       # 沒逃出去
    assert (dest / "accounts" / "default" / "ok.txt").exists()  # 解壓確實發生了
    # 被剝成相對路徑之後落在展開目錄內——證明該成員被處理而不是被略過
    assert list(dest.rglob("pwned.txt")) != []


def test_dotdot_member_is_rejected_by_the_extractor(tmp_path: Path):
    """釘住 libarchive 的預設：含 `..` 的成員被拒，且 tar 以非零結束。

    腳本因此走「備份包解不開」那條路——DEST 不存在、包外沒東西。斷言腳本自己的文案
    （而不是 tar 的英文訊息）是為了不被 libarchive 的措辭變動誤傷。"""
    home, _ = _fake_home(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    bundle = _escape_bundle(tmp_path, "b-dd", [("../outside/pwned.txt", "file", "DD")])
    dest = tmp_path / "unpacked"

    proc = _run([str(bundle), "-o", str(dest)], home)

    assert proc.returncode != 0
    assert "備份包解不開" in proc.stderr, proc.stderr   # 確實是解壓失敗那條路，不是別的
    # **刻意綁在 libarchive 的訊息上**：只斷言「腳本失敗了」的話，tar 對任何包都失敗時
    # 這條也會綠（那正是 Codex 抓到的假綠形狀）。訊息變了就代表我們依賴的行為可能也變了，
    # 該回頭重新確認，不是把斷言放寬。
    assert "Path contains" in proc.stderr, proc.stderr
    assert list(outside.iterdir()) == []
    assert not dest.exists()


def test_member_writing_through_a_symlink_is_rejected_by_the_extractor(tmp_path: Path):
    """釘住 libarchive 的預設：包內先放一個指向包外的 symlink、再放一個寫進它的成員，
    extractor 拒絕「穿過 symlink 寫入」。這三條合起來就是我們**不自己寫受控 extractor**
    的理由——libarchive 已經做對了，重寫一份只會多一份要維護的安全程式碼。

    哪天有人給 tar 加上保留絕對路徑的旗標、換成 GNU tar、或 libarchive 改預設，這三條會紅。"""
    home, _ = _fake_home(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    bundle = _escape_bundle(tmp_path, "b-link", [
        ("escape_link", "link", str(outside)),
        ("escape_link/pwned.txt", "file", "LK"),
    ])
    dest = tmp_path / "unpacked"

    proc = _run([str(bundle), "-o", str(dest)], home)

    assert proc.returncode != 0
    assert "備份包解不開" in proc.stderr, proc.stderr
    assert "through symlink" in proc.stderr, proc.stderr   # 理由同上一條
    assert list(outside.iterdir()) == []
    assert not dest.exists()

def test_absurd_expansion_ratio_is_refused_and_leaves_nothing(tmp_path: Path):
    """tar bomb：壓縮後幾 KB、展開後爆量。判準用**壓縮比**而不是絕對大小——後者會誤擋
    「真的有很多資產」的誠實大包，而壓縮比正是 tar bomb 的特徵。

    宣稱等級：這**不是**「防止磁碟耗盡」。解壓當下的空間已經被佔掉了（磁碟真的滿的話是
    tar 自己失敗，由既有的 cleanup 處理）；這一層擋的是「不讓一個離譜的展開目錄留在磁碟上」。"""
    import io
    import tarfile

    home, _ = _fake_home(tmp_path)
    d = tmp_path / "bomb"
    d.mkdir()
    bundle = d / "claude-backup-20260101-1200.tar.gz"
    zeros = b"\0" * (9 << 20)          # 9 MiB 的零：壓縮後幾 KB，比例上千倍
    with tarfile.open(bundle, "w:gz") as tf:
        manifest = json.dumps({"created": "x", "accounts": {}}).encode()
        ti = tarfile.TarInfo("manifest.json")
        ti.size = len(manifest)
        tf.addfile(ti, io.BytesIO(manifest))
        ti = tarfile.TarInfo("accounts/default/huge.bin")
        ti.size = len(zeros)
        tf.addfile(ti, io.BytesIO(zeros))
    dest = tmp_path / "unpacked"

    proc = _run([str(bundle), "-o", str(dest)], home)

    assert proc.returncode != 0, proc.stdout
    assert not dest.exists()                                   # 沒有發布
    residue = list(dest.parent.glob(".*fledge-restore-*.partial"))
    assert residue == [], residue                              # staging 也清掉了


def test_an_honest_large_bundle_is_not_refused(tmp_path: Path):
    """**誠實的大包不能被誤擋**：內容不可壓縮（隨機位元組）時比例接近 1，遠低於門檻。
    只用絕對大小當判準的話這一條會紅——那正是不該做的事。"""
    import io
    import os as _os
    import tarfile

    home, _ = _fake_home(tmp_path)
    d = tmp_path / "big"
    d.mkdir()
    bundle = d / "claude-backup-20260101-1200.tar.gz"
    payload = _os.urandom(9 << 20)     # 9 MiB 隨機：壓不掉，比例 ≈ 1
    with tarfile.open(bundle, "w:gz") as tf:
        manifest = json.dumps({"created": "x", "accounts": {}}).encode()
        ti = tarfile.TarInfo("manifest.json")
        ti.size = len(manifest)
        tf.addfile(ti, io.BytesIO(manifest))
        ti = tarfile.TarInfo("accounts/default/big.bin")
        ti.size = len(payload)
        tf.addfile(ti, io.BytesIO(payload))
    dest = tmp_path / "unpacked"

    proc = _run([str(bundle), "-o", str(dest)], home)

    assert proc.returncode == 0, proc.stderr
    assert (dest / "accounts" / "default" / "big.bin").exists()


def test_huge_entry_count_is_refused_even_when_the_bytes_are_zero(tmp_path: Path):
    """**大小配額擋不住「多」**：symlink、目錄與零大小檔案的 `st_size` 全是 0，所以幾十萬個
    這種成員可以讓 `total` 停在 0 而完全繞過比例判準——留下的正是一個「離譜的展開目錄」
    （inode 耗用、清理極慢）。這是 Codex 票 12 審查抓到的，我原本的宣稱等級因此過寬。

    上限用環境變數覆寫是**測試接縫**（比照既有的 `FLEDGE_BACKUP_SCRIPTS_DIR`）：真實門檻是
    20 萬，造那麼多成員的測試會慢到不可接受。"""
    import io
    import tarfile

    home, _ = _fake_home(tmp_path)
    d = tmp_path / "many"
    d.mkdir()
    bundle = d / "claude-backup-20260101-1200.tar.gz"
    with tarfile.open(bundle, "w:gz") as tf:
        manifest = json.dumps({"created": "x", "accounts": {}}).encode()
        ti = tarfile.TarInfo("manifest.json")
        ti.size = len(manifest)
        tf.addfile(ti, io.BytesIO(manifest))
        for i in range(60):
            tf.addfile(tarfile.TarInfo(f"accounts/default/empty-{i}"), io.BytesIO(b""))
    dest = tmp_path / "unpacked"

    proc = _run([str(bundle), "-o", str(dest)], home, {"FLEDGE_MAX_ENTRIES": "50"})

    assert proc.returncode != 0, proc.stdout
    assert not dest.exists()
    assert list(dest.parent.glob(".*fledge-restore-*.partial")) == []


def test_hardlinked_names_are_not_counted_twice(tmp_path: Path):
    """hardlink 的每個名字都 lstat 得到相同的 `st_size`，逐名加總會把一份內容算 N 次——
    誤擋方向（安全的那一邊），但仍然是誤擋。以 `(st_dev, st_ino)` 去重。"""
    import io
    import tarfile

    home, _ = _fake_home(tmp_path)
    d = tmp_path / "hard"
    d.mkdir()
    bundle = d / "claude-backup-20260101-1200.tar.gz"
    payload = os.urandom(1 << 20)      # 1 MiB 不可壓縮
    with tarfile.open(bundle, "w:gz") as tf:
        manifest = json.dumps({"created": "x", "accounts": {}}).encode()
        ti = tarfile.TarInfo("manifest.json")
        ti.size = len(manifest)
        tf.addfile(ti, io.BytesIO(manifest))
        ti = tarfile.TarInfo("accounts/default/real.bin")
        ti.size = len(payload)
        tf.addfile(ti, io.BytesIO(payload))
        for i in range(300):           # 300 條 hardlink 指向同一份 1 MiB
            li = tarfile.TarInfo(f"accounts/default/link-{i}.bin")
            li.type = tarfile.LNKTYPE
            li.linkname = "accounts/default/real.bin"
            tf.addfile(li)
    dest = tmp_path / "unpacked"

    # 去重後 total ≈ 1 MiB（在 8 MiB 門檻以下，連比例都不看）；逐名加總則是 301 MiB
    # 配上 1 MiB 的包＝約 300 倍，遠超過 200 倍門檻而被拒。**數字是實測挑的**：先寫的
    # 「3 MiB × 4 條」版本兩種實作都會放行——它對「有沒有去重」根本不敏感，是假綠。
    proc = _run([str(bundle), "-o", str(dest)], home)

    assert proc.returncode == 0, proc.stderr
    assert (dest / "accounts" / "default" / "real.bin").exists()


def test_manifest_cannot_point_the_diff_at_an_arbitrary_local_directory(tmp_path: Path):
    """**manifest 的 accounts／extra value 是不可信輸入**：差異報告原本直接拿它當「現役側」
    去 `expanduser` + 遞迴 `snapshot`，於是一份惡意包可以指定掃描本機任意目錄，並把檔名
    印在畫面上（Codex 票 12 審查，已實測可利用——指向 `/` 就是掃整個檔案系統）。

    只驗 manifest 是真檔案且是合法 JSON **不夠**——那驗的是 inode、大小與語法，不是語意。

    攻擊要成立還需要包內有同名的頂層目錄（差異報告對「只在現役有」有個過濾條件），所以
    這裡一併造出來——否則測到的是過濾條件而不是路徑信任邊界。"""
    home, _ = _fake_home(tmp_path)
    victim = tmp_path / "victim"
    (victim / "private-notes").mkdir(parents=True)
    (victim / "private-notes" / f"{SENTINEL}.txt").write_text("x", encoding="utf-8")
    bundle = _evil_bundle(tmp_path / "evil-scan", [
        ("manifest.json", "file", json.dumps({
            "created": "20260101-1200", "host": "evil", "home": "/old",
            "accounts": {"x": str(victim)}})),
        ("accounts/x/private-notes/decoy", "file", "y"),
    ])
    dest = tmp_path / "unpacked"

    proc = _run([str(bundle), "-o", str(dest)], home)

    # 核心斷言：**受害目錄的檔名沒有被列舉出來**。
    assert SENTINEL not in proc.stdout, proc.stdout
    assert SENTINEL not in proc.stderr
    # 而且是被這道邊界擋下的，不是碰巧（例如流程更早就失敗）。
    assert "不在本機登記的範圍內" in proc.stdout, proc.stdout

    # 刻意**不**斷言「那個路徑字串完全不出現」：「備份包資訊」那一段會照實顯示 manifest
    # 宣稱的舊機路徑，那是「這包來自哪裡」的合法資訊，而且那個字串本來就是攻擊者自己寫的
    # ——他不會從中得知任何新東西。要防的是掃描本機目錄並洩漏**其內容**。

"""競態與硬中斷之後的恢復契約（票 08 驗收關卡，plan Task 11）。

**不能用 monkeypatch 拋例外代替 SIGKILL**：例外走得到 Python 的清理邏輯，硬中斷走不到，
而後者正是要防的失敗模式。所以三條 SIGKILL 用**真的子行程＋真的 SIGKILL**。

**而且必須有 deterministic barrier**：靠 sleep 或輪詢檔名會有排程競態，可能在寫入前或
發布後才殺掉，斷言照樣通過卻完全沒覆蓋恢復路徑——那正是這組要防的假綠形狀。做法是子
行程走到指定窗口時經 FIFO 通知父行程並停住，父行程確認狀態之後才送出 SIGKILL。

barrier 刻意**不放進 production code**（plan 原本寫的是讀環境變數的 `_barrier()`）：
子行程腳本是我們自己寫的，在裡面臨時替換 `os.link`／`_publish_links` 就能達到同樣的
精準停頓，出貨的程式裡不必留只為測試存在的分支。SIGKILL 仍然是真的。
子行程腳本與 barrier 等待邏輯住在 `conftest`（票 06 起 route 的殘骸端到端也用同一份）。

**全程假 HOME + tmp_path，絕不碰真實的 ~/.claude。**
"""
import logging
import os
import shutil
from pathlib import Path

import pytest
from conftest import make_staging as _staging
from conftest import spawn_install_until_barrier as _spawn_until_barrier

from fledge_sidecar.backup import install as inst


@pytest.fixture(autouse=True)
def _fake_home(tmp_path: Path, monkeypatch):
    """install() 會寫 provenance journal 到 ~/.fledge——沒有這層，本檔任何一條都會寫
    進真實家目錄。子行程繼承同一個 HOME，重跑才接得上前一輪的 journal。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))


def _accounts(target: Path) -> dict[str, dict[str, str]]:
    return {"work": {"config_dir": str(target), "label": ""}}


def _temp_leftovers(root: Path) -> list[str]:
    """落點裡殘留的暫存檔（`.fledge-install-<pid>-<hex>`）。"""
    return sorted(str(p.relative_to(root))
                  for p in root.rglob(".fledge-install-*"))


def test_source_node_swapped_between_type_check_and_read(tmp_path: Path, monkeypatch):
    """判型到讀取之間來源節點被換成 symlink → fd 已釘住原物件，絕不讀到展開目錄外。

    這是 `_read_file_pinned` 存在的唯一理由：判型與讀取之間若還經過一次名稱解析，
    那一刻被換成 symlink 就會把 staging 外的檔案內容寫進使用者的現役目錄。
    """
    src = _staging(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("SECRET", encoding="utf-8")
    tgt = tmp_path / "live"
    tgt.mkdir()

    real_open = inst.os.open
    swapped: list[bool] = []

    def _open_then_swap(path, flags, *args, **kwargs):
        fd = real_open(path, flags, *args, **kwargs)
        if path == "CLAUDE.md" and not swapped:
            swapped.append(True)
            # fd 已經開好了——這個抽換不該影響接下來讀到的內容
            victim = src / "accounts" / "work" / "CLAUDE.md"
            victim.unlink()
            victim.symlink_to(outside)
        return fd

    monkeypatch.setattr(inst.os, "open", _open_then_swap)
    inst.install(inst.plan(str(src), _accounts(tgt)))

    assert swapped, "抽換沒有發生過，這條測試沒測到東西"
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"


def test_sigkill_after_temp_write_leaves_no_truncated_final(tmp_path: Path, caplog):
    """窗口一：暫存檔寫完、`link` 之前被強制結束。

    最終檔名此刻不該存在，SIGKILL 之後也不該出現——否則下次重跑會因為 EEXIST 判它
    已存在而跳過，那就是「名字對但內容截斷」的永久損壞。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()

    proc = _spawn_until_barrier(tmp_path, src, tgt, "after_temp")
    assert not (tgt / "CLAUDE.md").exists(), "最終名此刻不該存在"
    proc.kill()
    proc.wait(timeout=10)
    assert not (tgt / "CLAUDE.md").exists(), "SIGKILL 後不得留下佔用最終名的截斷檔"

    with caplog.at_level(logging.WARNING, logger="fledge_sidecar.backup.install"):
        inst.install(inst.plan(str(src), _accounts(tgt)))
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"
    # 殘骸只被指認、不被刪（票 08 R3：判準全是可偽造的檔名特徵，達不到「只刪自己建的」）
    assert _temp_leftovers(tgt), "暫存檔不該被自動刪除"
    assert "殘留的暫存檔" in caplog.text, "但必須被指認出來，使用者才知道它在"


def test_sigkill_after_link_before_temp_cleanup(tmp_path: Path, caplog):
    """窗口二：`link` 成功、暫存檔還沒清掉時被強制結束。

    最終名此刻已經完整（原子發布的意義），重跑判為已存在；殘留的暫存檔要被回收。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()

    proc = _spawn_until_barrier(tmp_path, src, tgt, "after_link")
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES", "最終名此刻已完整"
    assert _temp_leftovers(tgt), "此刻暫存檔還在——這正是本窗口的定義"
    proc.kill()
    proc.wait(timeout=10)

    with caplog.at_level(logging.WARNING, logger="fledge_sidecar.backup.install"):
        results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert any(r.rel_path == "CLAUDE.md" and r.outcome == "skipped" for r in results)
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"
    assert _temp_leftovers(tgt), "暫存檔不該被自動刪除"
    assert "殘留的暫存檔" in caplog.text, "但必須被指認出來"


def test_sigkill_between_phases_still_creates_symlinks_on_rerun(tmp_path: Path):
    """窗口三：第一階段全部發布完、第一條 symlink 之前被強制結束。

    這是最容易漏掉的一個：重跑時那些目標在記憶體裡全是「已存在」（skipped），判準若
    只認「這一輪裝的」，所有 symlink 會永久補不回來。必須靠 provenance journal 認出
    它們是**本次 transaction** 裝的。"""
    src = _staging(tmp_path)
    work = src / "accounts" / "work"
    (work / "commands").mkdir()
    (work / "commands" / "c.md").write_text("CMD", encoding="utf-8")
    (work / "linked").symlink_to("/Users/olduser/.claude/commands")
    # 落點必須落在 <new_home>/.claude：symlink 授權判準是把字面目標的舊 home 前綴改寫
    # 成新 home 再比對 node（spec §4.2.3）。自訂落點下 rewrite 對不上任何 node，
    # symlink 一律 fail-safe 不建——那是既有測試 `_home_target` 記錄過的前提。
    tgt = Path(os.environ["HOME"]) / ".claude"
    tgt.mkdir()

    proc = _spawn_until_barrier(tmp_path, src, tgt, "before_links")
    assert (tgt / "commands" / "c.md").read_text(encoding="utf-8") == "CMD", "第一階段已完成"
    assert not os.path.lexists(tgt / "linked"), "symlink 階段還沒開始"
    proc.kill()
    proc.wait(timeout=10)

    inst.install(inst.plan(str(src), _accounts(tgt)))
    assert (tgt / "linked").is_symlink(), "重跑必須把 symlink 補上"
    assert (tgt / "linked" / "c.md").read_text(encoding="utf-8") == "CMD"


def test_stale_temp_scan_is_skipped_when_there_was_no_prior_round(tmp_path: Path, monkeypatch):
    """正常首次安裝不掃暫存殘骸：沒有前一輪就不可能有殘骸，掃描是純成本。

    這個掃描是**按目的地既有目錄項計費**而非按殘骸數計費（Codex 票 08 R1 F3）——落點
    若已有上千個使用者檔案，每一層都要全掃一次。前一輪完整成功會清掉 journal，所以
    「journal 還在」正是「上一輪沒收尾」的訊號，也就是唯一可能有殘骸的情況。"""
    calls: list[int] = []
    monkeypatch.setattr(inst.safe_fs, "find_stale_temps",
                        lambda fd: calls.append(fd) or [])
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()

    inst.install(inst.plan(str(src), _accounts(tgt)))
    assert calls == [], "首次安裝不該掃描目的地"


def test_stale_temps_reported_when_transaction_changed_after_interrupt(tmp_path: Path, caplog):
    """中斷後重展 bundle（或改 mapping／落點）→ transaction 變了，同一個落點的殘骸
    仍要回收（Codex 票 08 R2）。

    gating 若綁**本次** `transaction_id` 的 journal，這種情況下新 journal 還不存在、
    舊殘骸永遠掃不到；而新 transaction 完整成功後又會清掉自己的 journal，殘骸就永久
    留在使用者的現役目錄裡。粒度必須是「有沒有任何一輪沒收尾」。"""
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()

    proc = _spawn_until_barrier(tmp_path, src, tgt, "after_temp")
    proc.kill()
    proc.wait(timeout=10)
    assert _temp_leftovers(tgt), "前一輪應該留下了暫存檔"
    tid_before = inst.transaction_id(inst.plan(str(src), _accounts(tgt)))

    # 使用者重新展開 bundle：內容一樣但實體目錄換了 → source_identity 變 → 新 transaction
    shutil.rmtree(src)
    src2 = _staging(tmp_path)
    plan2 = inst.plan(str(src2), _accounts(tgt))
    assert inst.transaction_id(plan2) != tid_before, "前提沒成立：transaction 沒有變"

    with caplog.at_level(logging.WARNING, logger="fledge_sidecar.backup.install"):
        inst.install(plan2)
    assert "殘留的暫存檔" in caplog.text, "換了 transaction 也要指認出前一輪的殘骸"

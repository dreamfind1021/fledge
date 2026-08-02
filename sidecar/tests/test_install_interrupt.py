"""競態與硬中斷之後的恢復契約（票 08 驗收關卡，plan Task 11）。

**不能用 monkeypatch 拋例外代替 SIGKILL**：例外走得到 Python 的清理邏輯，硬中斷走不到，
而後者正是要防的失敗模式。所以三條 SIGKILL 用**真的子行程＋真的 SIGKILL**。

**而且必須有 deterministic barrier**：靠 sleep 或輪詢檔名會有排程競態，可能在寫入前或
發布後才殺掉，斷言照樣通過卻完全沒覆蓋恢復路徑——那正是這組要防的假綠形狀。做法是子
行程走到指定窗口時經 FIFO 通知父行程並停住，父行程確認狀態之後才送出 SIGKILL。

barrier 刻意**不放進 production code**（plan 原本寫的是讀環境變數的 `_barrier()`）：
子行程腳本是我們自己寫的，在裡面臨時替換 `os.link`／`_publish_links` 就能達到同樣的
精準停頓，出貨的程式裡不必留只為測試存在的分支。SIGKILL 仍然是真的。

**全程假 HOME + tmp_path，絕不碰真實的 ~/.claude。**
"""
import os
import select
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from conftest import make_staging as _staging

from fledge_sidecar.backup import install as inst

_SIDECAR_ROOT = Path(inst.__file__).parents[2]

# 子行程：在指定窗口停住等父行程送 SIGKILL。停頓點靠臨時替換函式達成，production 不動。
_CHILD = textwrap.dedent('''
    import os
    import sys
    import time

    stage, fifo, src, tgt = sys.argv[1:5]

    from fledge_sidecar.backup import install as inst
    from fledge_sidecar.setup import safe_fs

    def _reach():
        """通知父行程「我到窗口了」，然後停住——這個函式永遠不返回。"""
        with open(fifo, "w", encoding="utf-8") as fh:
            fh.write(stage)
        while True:
            time.sleep(3600)

    if stage in ("after_temp", "after_link"):
        _real_link = safe_fs.os.link

        def _link(temp_name, name, **kwargs):
            # 只在指定的那個檔案上停，才有確定性（scandir 順序不保證）
            if name != "CLAUDE.md":
                return _real_link(temp_name, name, **kwargs)
            if stage == "after_temp":
                _reach()                 # 暫存檔已完整落盤，最終名還沒出現
            result = _real_link(temp_name, name, **kwargs)
            _reach()                     # after_link：最終名已在，暫存檔還沒清
            return result

        safe_fs.os.link = _link
    elif stage == "before_links":
        _real_publish = inst._publish_links

        def _publish(*args, **kwargs):
            _reach()                     # 第一階段全部發布完，第一條 symlink 之前
            return _real_publish(*args, **kwargs)

        inst._publish_links = _publish

    inst.install(inst.plan(src, {"work": {"config_dir": tgt, "label": ""}}))
''')


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


def _spawn_until_barrier(tmp_path: Path, src: Path, tgt: Path,
                         stage: str) -> subprocess.Popen:
    """起 install 子行程，等它真的走到 `stage` 才返回。"""
    fifo = tmp_path / f"barrier-{stage}.fifo"
    os.mkfifo(fifo)
    script = tmp_path / f"child-{stage}.py"
    script.write_text(_CHILD, encoding="utf-8")
    env = {
        **os.environ,
        "PYTHONPATH": str(_SIDECAR_ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    proc = subprocess.Popen(
        [sys.executable, str(script), stage, str(fifo), str(src), str(tgt)],
        env=env)
    # 讀端先開起來（O_NONBLOCK 即使還沒有 writer 也立即返回），子行程的寫端才不會卡住。
    # select 帶超時：子行程若在抵達窗口前就早夭，測試要失敗而不是永久掛住。
    fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
    try:
        ready, _, _ = select.select([fd], [], [], 30)
        if not ready:
            proc.kill()
            proc.wait(timeout=10)
            raise AssertionError(f"子行程未在時限內抵達窗口 {stage}")
        assert os.read(fd, 64).decode("utf-8").strip() == stage
    finally:
        os.close(fd)
    return proc


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


def test_sigkill_after_temp_write_leaves_no_truncated_final(tmp_path: Path):
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

    inst.install(inst.plan(str(src), _accounts(tgt)))
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"
    assert _temp_leftovers(tgt) == [], "重跑要回收前一輪的暫存檔"


def test_sigkill_after_link_before_temp_cleanup(tmp_path: Path):
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

    results = inst.install(inst.plan(str(src), _accounts(tgt)))
    assert any(r.rel_path == "CLAUDE.md" and r.outcome == "skipped" for r in results)
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"
    assert _temp_leftovers(tgt) == [], "重跑要回收前一輪的暫存檔"


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

import json
import os
import select
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _default_test_unauth(monkeypatch):
    """預設讓所有測試以 opt-out（無認證）跑——既有測試不必逐一帶 token。
    要測 enforced 的測試自行 monkeypatch.delenv('FLEDGE_TEST_UNAUTH') + setenv('FLEDGE_TOKEN')。"""
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")


def make_staging(base: Path, *, home: str = "/Users/olduser") -> Path:
    """造一份最小的展開目錄（含 manifest），比照 backup-claude.sh 的產出佈局。

    test_install 與 test_restore_routes 共用（出現第二個使用點才抽進來）。"""
    root = base / "staging"
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


_SIDECAR_ROOT = Path(__file__).parents[1]

# install 子行程：在指定窗口停住等父行程送 SIGKILL。停頓點靠臨時替換函式達成，
# production 不動。`test_install_interrupt`（模組層恢復契約）與 `test_restore_routes`
# （route 的殘骸回報端到端）共用——出現第二個使用點才抽進來，比照 `make_staging`。
_INSTALL_BARRIER_CHILD = textwrap.dedent('''
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


def spawn_install_until_barrier(tmp_path: Path, src: Path, tgt: Path,
                                stage: str) -> subprocess.Popen:
    """起 install 子行程，等它真的走到 `stage` 才返回。

    **不能用 monkeypatch 拋例外代替 SIGKILL**：例外走得到 Python 的清理邏輯，硬中斷
    走不到，而後者正是要防的失敗模式。barrier 讓停頓點有確定性——靠 sleep 或輪詢會有
    排程競態，可能在寫入前或發布後才殺掉，斷言照樣通過卻完全沒覆蓋恢復路徑。"""
    fifo = tmp_path / f"barrier-{stage}.fifo"
    os.mkfifo(fifo)
    script = tmp_path / f"child-{stage}.py"
    script.write_text(_INSTALL_BARRIER_CHILD, encoding="utf-8")
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

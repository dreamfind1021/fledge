import json
import os
import select
import stat
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


@pytest.fixture(autouse=True)
def _no_codex_account_poll(monkeypatch):
    """app 的 lifespan 會起 Codex 帳號用量的背景更新；測試預設一律不起，不得啟動真的 codex、打到 OpenAI
    （spec 5.4）。要測背景更新本身的測試自行 monkeypatch.delenv('FLEDGE_TEST_NO_CODEX_POLL')。"""
    monkeypatch.setenv("FLEDGE_TEST_NO_CODEX_POLL", "1")


# 假 codex：講 app-server 同一套 JSON-RPC 的 Python 腳本（test_codex_usage 與 test_codex_account_poll 共用，
# 出現第二個使用點才抽進來，比照 make_staging）。FAKE_CODEX_MODE：normal／noise（夾雜通知與非 JSON 行）／
# silent（不讀 stdin、睡 60 秒）／exit-after-init／hang-usage（account/usage/read 不回，寫 FAKE_CODEX_MARKER 後
# 繼續讀 stdin，EOF 才結束——跟真的 app-server 一樣）。
FAKE_CODEX = r'''#!%(py)s
import json, os, sys, time
mode = os.environ.get("FAKE_CODEX_MODE", "normal")
out = os.environ.get("FAKE_CODEX_OUT")
if out:
    with open(out, "w") as f:
        json.dump({"pid": os.getpid(), "CODEX_HOME": os.environ.get("CODEX_HOME"), "argv": sys.argv[1:]}, f)
if mode == "silent":
    time.sleep(60); sys.exit(0)
def emit(o): sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    try: m = json.loads(line)
    except json.JSONDecodeError: continue
    if "id" not in m: continue                          # 通知（initialized）不回
    if mode == "noise":
        sys.stdout.write("warning: something on stdout\n"); sys.stdout.flush()
        emit({"jsonrpc": "2.0", "method": "remoteControl/status/changed", "params": {"status": "disabled"}})
    if m["method"] == "initialize":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"userAgent": "fake", "codexHome": os.environ.get("CODEX_HOME")}})
        if mode == "exit-after-init": sys.exit(0)
    elif m["method"] == "account/read":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"account": {"type": "chatgpt", "planType": "plus"}, "requiresOpenaiAuth": True}})
    elif m["method"] == "account/rateLimits/read":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"accountId": "acc-fake", "rateLimits": {"planType": "plus",
              "primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1789408745}, "secondary": None}}})
    elif m["method"] == "account/usage/read" and mode == "hang-usage":
        open(os.environ["FAKE_CODEX_MARKER"], "w").close()       # 通知測試：已經卡在這裡，不回、繼續讀 stdin 直到 EOF
    elif m["method"] == "account/usage/read":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"dailyUsageBuckets": [{"startDate": "2026-10-21", "tokens": 7}],
              "summary": {"lifetimeTokens": 7}}})
    elif m["method"] == "model/list":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"data": [{"id": "m", "model": "gpt-fake", "isDefault": True}],
              "nextCursor": None}})
    else:
        emit({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "method not found"}})
'''


@pytest.fixture
def fake_codex(tmp_path, monkeypatch):
    """PATH 上放一支講同一套協定的假 codex；回 (執行檔路徑, 它會寫 pid／env 的檔案)。"""
    script = tmp_path / "bin" / "codex"
    script.parent.mkdir()
    script.write_text(FAKE_CODEX % {"py": sys.executable}, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    out = tmp_path / "fake-codex-out.json"
    monkeypatch.setenv("FAKE_CODEX_OUT", str(out))
    home = tmp_path / ".codex"
    home.mkdir()
    return script, out, home


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

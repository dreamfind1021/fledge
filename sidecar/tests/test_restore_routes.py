"""還原的路由契約：`POST /api/restore/plan` 與 `POST /api/sessions` 的 kind=restore。

全程 tmp_path 假 config、假 scripts 目錄與 stub 腳本——**不碰真實 Claude 目錄，也不真的
展開任何東西**（成功路徑攔截 create_session，只驗後端組出來的 argv）。
"""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app

BUNDLE = "claude-backup-20260101-1200.tar.gz"


def _config(
    tmp_path: Path,
    monkeypatch,
    backup_dir: str | None = None,
    with_script: bool = True,
    with_bundle: bool = True,
) -> Path:
    """假 config + 假 scripts 目錄。回備份目錄（backup_dir 傳 None 時就是它）。"""
    out = tmp_path / "backups"
    out.mkdir(exist_ok=True)
    if with_bundle:
        (out / BUNDLE).write_bytes(b"x")
    (tmp_path / "claude").mkdir(exist_ok=True)
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({
        "version": 1, "roots": [],
        "accounts": {"default": {"config_dir": str(tmp_path / "claude"), "label": ""}},
        "backup_dir": str(out) if backup_dir is None else backup_dir,
    }), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    scripts = tmp_path / "scripts"
    scripts.mkdir(exist_ok=True)
    stub = scripts / "restore-claude.sh"
    if with_script:
        stub.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    else:
        stub.unlink(missing_ok=True)   # 同一個 tmp_path 內重呼叫時要真的拿掉，否則測不到缺檔
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(scripts))
    return out


def _plan(client, bundle: str = BUNDLE, dest: str | None = None):
    body: dict = {"bundle": bundle}
    if dest is not None:
        body["dest"] = dest
    return client.post("/api/restore/plan", json=body)


def _post_restore(client, bundle: str = BUNDLE, dest: str | None = None):
    body: dict = {"path": "", "kind": "restore", "restore_bundle": bundle}
    if dest is not None:
        body["restore_dest"] = dest
    return client.post("/api/sessions", json=body)


# ── 環境前提要在備份狀態裡一起回報 ────────────────────────────────────────────


def test_backup_status_reports_restore_script_availability(tmp_path: Path, monkeypatch):
    """還原腳本是獨立的一個檔案，打包漏收它時備份可用、還原不可用——旗標必須分開。

    比照既有的 `script_available`：環境前提與 backup_dir 無關，未設定位置時也照回。"""
    _config(tmp_path, monkeypatch)
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["restore_script_available"] is True

    _config(tmp_path, monkeypatch, with_script=False)
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["restore_script_available"] is False


# ── POST /api/restore/plan ───────────────────────────────────────────────────


def test_plan_suggests_a_default_dest(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    body = _plan(TestClient(create_app())).json()
    assert body["bundle"] == BUNDLE
    assert body["dest"] == str(tmp_path / "home" / ".claude-restore-20260101-1200")
    assert body["dest_status"] == "ok"


def test_plan_validates_a_chosen_dest(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch)
    used = tmp_path / "used"
    used.mkdir()
    (used / "mine.txt").write_bytes(b"x")
    body = _plan(TestClient(create_app()), dest=str(used)).json()
    assert body["dest"] == str(used)
    assert body["dest_status"] == "not_empty"


def test_plan_reports_overlap_with_live_data_as_a_state_not_an_error(tmp_path: Path, monkeypatch):
    """位置問題不是錯誤：一律 200 用旗標表達（沿用備份狀態的取向）。塞進 HTTP 錯誤碼
    就只剩「壞了」一個資訊，卡片無法分辨「非空」與「選到現役資料裡面」。"""
    _config(tmp_path, monkeypatch)
    inside = tmp_path / "claude" / "restored"
    resp = _plan(TestClient(create_app()), dest=str(inside))
    assert resp.status_code == 200
    assert resp.json()["dest_status"] == "inside_source"


def test_plan_rejects_a_bundle_not_in_the_listing(tmp_path: Path, monkeypatch):
    """備份包名是 allowlist——請求本身壞掉才用錯誤碼。"""
    _config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    for bad in ("../../etc/passwd", "nope.tar.gz", str(tmp_path / BUNDLE)):
        resp = _plan(client, bundle=bad)
        assert resp.status_code == 400
        assert resp.json()["error"] == "unknown_bundle"


def test_plan_rejects_relative_dest(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch)
    resp = _plan(TestClient(create_app()), dest="somewhere")
    assert resp.status_code == 400
    assert resp.json()["error"] == "dest_invalid"


def test_plan_reports_unusable_backup_dir(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch, backup_dir="")
    assert _plan(TestClient(create_app())).json()["error"] == "backup_dir_not_set"

    _config(tmp_path, monkeypatch, backup_dir="relative/path")
    assert _plan(TestClient(create_app())).json()["error"] == "backup_dir_invalid"

    _config(tmp_path, monkeypatch, backup_dir=str(tmp_path / "gone"))
    assert _plan(TestClient(create_app())).json()["error"] == "backup_dir_unusable"


def test_plan_rejects_unknown_fields(tmp_path: Path, monkeypatch):
    """未知欄位一律擋掉（extra="forbid"）：命令字串永遠不可能從前端進來。"""
    _config(tmp_path, monkeypatch)
    resp = TestClient(create_app()).post(
        "/api/restore/plan", json={"bundle": BUNDLE, "command": "rm -rf /"},
    )
    assert resp.status_code == 422


# ── POST /api/sessions kind=restore ─────────────────────────────────────────


def test_restore_session_rejects_injected_command(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch)
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "kind": "restore", "restore_bundle": BUNDLE, "command": "rm -rf /",
    })
    assert resp.status_code == 422


def test_restore_session_requires_a_bundle(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch)
    resp = TestClient(create_app()).post(
        "/api/sessions", json={"path": "", "kind": "restore"})
    assert resp.status_code == 400
    assert resp.json()["error"] == "restore_bundle_required"


def test_restore_session_revalidates_everything(tmp_path: Path, monkeypatch):
    """**spawn 前的閘才是真正的守門**：plan 說可以，到按下去之間 FS 可能已經變了，
    而 client 送來的值本來就不可信（ADR-0002 的同一條原則）。"""
    out = _config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    assert _post_restore(client, bundle="nope.tar.gz").json()["error"] == "unknown_bundle"
    assert _post_restore(client, dest="relative").json()["error"] == "dest_invalid"
    used = tmp_path / "used"
    used.mkdir()
    (used / "x").write_bytes(b"x")
    assert _post_restore(client, dest=str(used)).json()["error"] == "dest_not_empty"
    inside = tmp_path / "claude" / "restored"
    assert _post_restore(client, dest=str(inside)).json()["error"] == "dest_inside_source"
    assert out.exists()   # 被擋下時什麼都沒動


def test_restore_session_blocked_when_script_missing(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch, with_script=False)
    assert _post_restore(TestClient(create_app())).json()["error"] == "restore_script_missing"


def test_restore_session_blocked_when_python3_missing(tmp_path: Path, monkeypatch):
    """腳本兩處呼叫系統 python3（讀 manifest、產差異報告），缺了它跑起來只會失敗。"""
    _config(tmp_path, monkeypatch)
    monkeypatch.setattr("fledge_sidecar.routes.sessions.python3_available", lambda: False)
    assert _post_restore(TestClient(create_app())).json()["error"] == "python3_missing"


def test_restore_session_gate_order_puts_the_dir_first(tmp_path: Path, monkeypatch):
    """多個條件同時成立時回優先序最前的——卡片顯示的修復指引必須與後端下一個會擋的一致。"""
    _config(tmp_path, monkeypatch, backup_dir="", with_script=False)
    monkeypatch.setattr("fledge_sidecar.routes.sessions.python3_available", lambda: False)
    assert _post_restore(TestClient(create_app())).json()["error"] == "backup_dir_not_set"


def test_restore_session_spawns_with_backend_built_argv(tmp_path: Path, monkeypatch):
    """成功路徑：跑的是後端組的 argv（前端只送備份包名與展開位置），且不綁帳號。"""
    out = _config(tmp_path, monkeypatch)
    dest = tmp_path / "My Restore"        # 含空白，驗證不經 shell
    captured: dict = {}

    class _Session:
        session_id = "test-restore-session"

    def _create(**kwargs):
        captured.update(kwargs)
        return _Session()

    monkeypatch.setattr(
        "fledge_sidecar.routes.sessions._bridge.create_session", _create)
    resp = _post_restore(TestClient(create_app()), dest=str(dest))
    assert resp.status_code == 200
    argv = captured["command"]
    assert argv[0] == "/bin/bash"
    assert argv[1].endswith("restore-claude.sh")
    assert argv[2] == str(out / BUNDLE)   # 名字在後端才被解析成路徑
    assert argv[3:] == ["-o", str(dest)]
    assert captured["cwd"] == str(Path.home())
    assert captured["env_overrides"] == {}
    assert "CLAUDE_CONFIG_DIR" in captured["env_remove"]


def test_restore_session_defaults_the_dest_when_not_given(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    captured: dict = {}

    class _Session:
        session_id = "s"

    monkeypatch.setattr(
        "fledge_sidecar.routes.sessions._bridge.create_session",
        lambda **kw: (captured.update(kw), _Session())[1],
    )
    assert _post_restore(TestClient(create_app())).status_code == 200
    assert captured["command"][-1] == str(tmp_path / "home" / ".claude-restore-20260101-1200")


def test_plan_default_dest_skips_a_previous_restore(tmp_path: Path, monkeypatch):
    """跑過一次之後回到卡片，預設位置正是上次的展開結果——app 不該建議一個自己隨後
    會拒絕的位置（真機驗收抓到）。往後加序號，且 `dest_status` 直接就是 ok。"""
    _config(tmp_path, monkeypatch)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    previous = home / ".claude-restore-20260101-1200"
    (previous / "accounts").mkdir(parents=True)

    body = _plan(TestClient(create_app())).json()
    assert body["dest"] == str(previous) + "-1"
    assert body["dest_status"] == "ok"

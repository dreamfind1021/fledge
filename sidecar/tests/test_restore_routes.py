"""還原的路由契約：`POST /api/restore/plan` 與 `POST /api/sessions` 的 kind=restore。

全程 tmp_path 假 config、假 scripts 目錄與 stub 腳本——**不碰真實 Claude 目錄，也不真的
展開任何東西**（成功路徑攔截 create_session，只驗後端組出來的 argv）。
"""
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

from conftest import make_staging, spawn_install_until_barrier
from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app
from fledge_sidecar.backup import install
from fledge_sidecar.backup import restore as restore_mod

BUNDLE = "claude-backup-20260101-1200.tar.gz"
REPO = Path(__file__).resolve().parents[2]


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


# ── 票 03：install-plan／install 端點（實際寫入走 backup/install.py） ──────────────

def _install_config(tmp_path: Path, monkeypatch) -> Path:
    """install 端點用的假 config：一個 work 帳號指向 tmp 內的 live 目錄。回 live。"""
    # home 要真的建：install 的 provenance journal 走 fd-relative 開啟（票 04 R2 F1），
    # home 不存在會 journal_unavailable。
    (tmp_path / "home").mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    live = tmp_path / "live"
    live.mkdir()
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({
        "version": 1, "roots": [],
        "accounts": {"work": {"config_dir": str(live), "label": ""}},
    }), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    return live


def test_install_plan_reads_accounts_from_config_not_body(tmp_path: Path, monkeypatch):
    """落點從已落檔的 config.json 讀——那是使用者確認過的，不是 manifest 說的。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    resp = TestClient(create_app()).post("/api/restore/install-plan",
                                         json={"dest": str(staging)})
    assert resp.status_code == 200
    assert resp.json()["will_install"] == 2


def test_install_plan_rejects_non_bundle_dest(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    bare = tmp_path / "bare"
    bare.mkdir()
    resp = TestClient(create_app()).post("/api/restore/install-plan",
                                         json={"dest": str(bare)})
    assert resp.status_code == 400
    assert resp.json()["error"] == "source_not_a_bundle"


def test_install_recomputes_plan_and_does_not_trust_client(tmp_path: Path, monkeypatch):
    """ADR-0002：server 以相同輸入重算 plan，不吃 client 送來的 plan。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    resp = TestClient(create_app()).post("/api/restore/install",
                                         json={"dest": str(staging)})
    assert resp.status_code == 200
    outcomes = {r["outcome"] for r in resp.json()["results"]}
    assert outcomes == {"installed"}
    assert (live / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"


def test_install_rejects_client_supplied_plan(tmp_path: Path, monkeypatch):
    """ADR-0002 的強制面：body 只有 dest，client 塞 plan 進來一律 422、零寫入。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    resp = TestClient(create_app()).post(
        "/api/restore/install",
        json={"dest": str(staging), "plan": {"targets": {"work": "/etc"}}})
    assert resp.status_code == 422
    assert list(live.iterdir()) == []          # 一個檔案都沒寫


def test_install_plan_is_readonly_and_matches_install_results(tmp_path: Path, monkeypatch):
    """票 03 驗收：預覽端點不寫任何東西，且它報的數字與實際執行的結果一致。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    client = TestClient(create_app())
    planned = client.post("/api/restore/install-plan", json={"dest": str(staging)}).json()
    assert list(live.iterdir()) == []          # 預覽零寫入
    results = client.post("/api/restore/install",
                          json={"dest": str(staging)}).json()["results"]
    installed = [r for r in results if r["outcome"] == "installed"]
    assert len(installed) == planned["will_install"]


def test_install_requires_initialized_config(tmp_path: Path, monkeypatch):
    """破壞性端點的 readiness 閘（與 common-config 的 apply／repair 同款）：config 未落檔
    時 AppConfig.load() 會 fallback 到指向真實 ~/.claude 的 DEFAULT_CONFIG——沒有這道閘，
    未 onboard 的機器只要 bundle 的 manifest 含 "default" 帳號，install 就會把備份內容
    寫進現役 Claude 目錄（Codex 票 03 R3，L1）。

    測試用雙層保險：HOME 指向假目錄、manifest 的帳號 key 也刻意不撞 DEFAULT_CONFIG。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "nope" / "config.json"))
    root = tmp_path / "staging-z"
    (root / "accounts" / "zzz").mkdir(parents=True)
    (root / "accounts" / "zzz" / "f.md").write_text("X", encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps({
        "format": 1, "home": "/Users/olduser",
        "accounts": {"zzz": "/Users/olduser/.claude"},
    }), encoding="utf-8")
    resp = TestClient(create_app()).post("/api/restore/install", json={"dest": str(root)})
    assert resp.status_code == 400
    assert resp.json()["error"] == "config_not_initialized"


def test_install_never_uses_fallback_accounts(tmp_path: Path, monkeypatch):
    """R4 L1：exists→load 兩段式閘有 TOCTOU（等鎖期間 config 被刪即退回 DEFAULT_CONFIG），
    且 load() 的 fallback 有兩層——檔案不存在退整份、檔案在但缺 accounts 欄位退 DEFAULT
    帳號（default=~/.claude）。寫入端改走 load_existing 單次讀取、兩層都永不 fallback：
    缺 accounts 的 config 一律 config_unreadable，絕不拿 DEFAULT 帳號當落點。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "roots": []}), encoding="utf-8")  # 缺 accounts
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    staging = make_staging(tmp_path)
    resp = TestClient(create_app()).post("/api/restore/install", json={"dest": str(staging)})
    assert resp.status_code == 500
    assert resp.json()["error"] == "config_unreadable"


def test_corrupt_bundles_map_to_stable_code_not_naked_500(tmp_path: Path, monkeypatch):
    """R4 L2：manifest["accounts"] 不是物件會在 plan 產生 TypeError、manifest 在但實體
    accounts/ 目錄缺失會在 install 拋 OSError——都要映成 source_not_a_bundle 400，
    不得讓例外穿出變裸 500（error-code 合約）。"""
    _install_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    # accounts 欄位是 null
    bad1 = tmp_path / "bad1"
    bad1.mkdir()
    (bad1 / "manifest.json").write_text(json.dumps({
        "format": 1, "home": "/x", "accounts": None,
    }), encoding="utf-8")
    resp = client.post("/api/restore/install-plan", json={"dest": str(bad1)})
    assert (resp.status_code, resp.json()["error"]) == (400, "source_not_a_bundle")
    # manifest 合法但沒有實體 accounts/ 目錄
    bad2 = tmp_path / "bad2"
    bad2.mkdir()
    (bad2 / "manifest.json").write_text(json.dumps({
        "format": 1, "home": "/x", "accounts": {"work": "/x/.claude"},
    }), encoding="utf-8")
    resp = client.post("/api/restore/install-plan", json={"dest": str(bad2)})
    assert (resp.status_code, resp.json()["error"]) == (400, "source_not_a_bundle")
    resp = client.post("/api/restore/install", json={"dest": str(bad2)})
    assert (resp.status_code, resp.json()["error"]) == (400, "source_not_a_bundle")


# ---------- 票 07：adopt-config 與 extra 接線 ----------


def _adopt_env(tmp_path: Path, monkeypatch) -> tuple[Path, Path, Path]:
    """假 HOME＋尚未落檔的 config＋含 extra 的 staging。回 (cfg_path, src, home)。

    staging 帶一條帳號內指向 extra 資產的 symlink——F2 端到端要驗「搬完連結解得開」。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    cfg = tmp_path / "fledge-config.json"
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    src = make_staging(tmp_path)
    (src / "extra" / "agents" / "skills" / "s").mkdir(parents=True)
    (src / "extra" / "agents" / "skills" / "s" / "SKILL.md").write_text("X", encoding="utf-8")
    (src / "accounts" / "work" / "skills" / "s").symlink_to("/Users/olduser/.agents/skills/s")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["extra"] = {"agents": "/Users/olduser/.agents"}
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return cfg, src, home


def test_adopt_config_requires_confirmed_landing_spots(tmp_path: Path, monkeypatch):
    """manifest 說的落點不算數——body 沒帶 accounts 就一位元組都不寫（spec §4.2.2）。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    resp = TestClient(create_app()).post("/api/restore/adopt-config",
                                         json={"dest": str(src)})
    assert resp.status_code == 422
    assert not cfg.exists()


def test_adopt_config_revalidates_landing_spots(tmp_path: Path, monkeypatch):
    """使用者送回的落點一樣要重驗：home 本身（ADR-0001）與落點互為祖先都擋、零寫入。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home)}]})
    assert (resp.status_code, resp.json()["error"]) == (400, "unsafe_config_dir")
    resp = client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}],
        "extra": [{"name": "agents", "path": str(home / ".claude" / "sub")}]})
    assert (resp.status_code, resp.json()["error"]) == (400, "overlapping_config_dirs")
    assert not cfg.exists()


def test_adopt_config_refuses_when_config_exists(tmp_path: Path, monkeypatch):
    """設定檔已存在 → 409 且逐位元組不變（票 07 驗收：不是部分寫入）。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    cfg.write_text('{"version": 1, "accounts": {}}', encoding="utf-8")
    before = cfg.read_bytes()
    resp = TestClient(create_app()).post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}]})
    assert (resp.status_code, resp.json()["error"]) == (409, "config_already_initialized")
    assert cfg.read_bytes() == before


def test_adopt_config_rejects_undeclared_or_duplicate_names(tmp_path: Path, monkeypatch):
    """帳號 key／extra name 必須是備份包宣稱的成員；同名重複（後蓋前的歧義）也拒。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "ghost", "config_dir": str(home / ".x")}]})
    assert (resp.status_code, resp.json()["error"]) == (400, "unknown_account_key")
    resp = client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}],
        "extra": [{"name": "ghost", "path": str(home / ".g")}]})
    assert (resp.status_code, resp.json()["error"]) == (400, "unknown_extra_name")
    resp = client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".c1")},
                     {"key": "work", "config_dir": str(home / ".c2")}]})
    assert (resp.status_code, resp.json()["error"]) == (400, "duplicate_account_key")
    assert not cfg.exists()


def test_adopt_config_rejects_root_with_unknown_account(tmp_path: Path, monkeypatch):
    """root 的 default_account 必須指向本次確認的帳號之一，否則 400、零寫入。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    projects = tmp_path / "projects"
    projects.mkdir()
    resp = TestClient(create_app()).post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}],
        "roots": [{"path": str(projects), "default_account": "ghost"}]})
    assert (resp.status_code, resp.json()["error"]) == (400, "unknown_account")
    assert not cfg.exists()


def test_adopt_config_writes_confirmed_spots_not_manifest_suggestions(
        tmp_path: Path, monkeypatch):
    """成功路徑：config 收使用者確認的值（raw）；manifest 的舊機路徑一個都不落地。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    projects = tmp_path / "projects"
    projects.mkdir()
    resp = TestClient(create_app()).post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}],
        "roots": [{"path": str(projects), "default_account": "work"}],
        "extra": [{"name": "agents", "path": str(home / ".agents")}]})
    assert resp.status_code == 200
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["accounts"] == {"work": {"config_dir": str(home / ".claude"), "label": ""}}
    assert data["extra"] == {"agents": str(home / ".agents")}
    assert [r["default_account"] for r in data["roots"]] == ["work"]
    assert "/Users/olduser" not in cfg.read_text(encoding="utf-8")


def test_adopt_config_accepts_extra_name_from_the_real_backup_script(
        tmp_path: Path, monkeypatch):
    """端到端（票 13）：**真的跑 `backup-claude.sh`** 產一份含 `~/.agents` 的包，manifest
    的 extra name 就是 `basename` 出來的 `.agents`——sidecar 這側必須收得下自己備份腳本的
    產出，一路走到 extra 資產落地。

    本檔其餘 fixture 一律把 name 寫成不帶點的 `agents`，與真實產出不一致，這條判準漂移
    因此藏到票 12 R4 才被撞見。**手工造的 manifest 複製不出這個形狀**，只有跑真的產生端
    才鎖得住兩邊的相容性。"""
    old_home = tmp_path / "old"
    (old_home / ".claude" / "skills").mkdir(parents=True)
    (old_home / ".claude" / "skills" / "a.md").write_text("A", encoding="utf-8")
    (old_home / ".agents" / "skills" / "s").mkdir(parents=True)
    (old_home / ".agents" / "skills" / "s" / "SKILL.md").write_text("X", encoding="utf-8")
    (old_home / ".fledge").mkdir()
    (old_home / ".fledge" / "config.json").write_text(json.dumps({
        "version": 1, "roots": [],
        "accounts": {"work": {"config_dir": str(old_home / ".claude"), "label": ""}},
    }), encoding="utf-8")
    out = tmp_path / "bundles"
    env = {**os.environ, "HOME": str(old_home)}
    env.pop("FLEDGE_BACKUP_DIR", None)
    proc = subprocess.run(
        ["/bin/bash", str(REPO / "scripts" / "backup-claude.sh"), "-o", str(out)],
        capture_output=True, text=True, env=env, timeout=120)
    assert proc.returncode == 0, proc.stderr
    (bundle,) = list(out.glob("claude-backup-*.tar.gz"))
    src = tmp_path / "unpacked"
    # 展開等同 `restore-claude.sh` 的 `tar -xzf`；那支腳本的展開契約有自己的測試檔，
    # 這裡要鎖的是「備份腳本產的 manifest 形狀」×「sidecar 的判準」。
    with tarfile.open(bundle) as tf:
        tf.extractall(src, filter="tar")
    assert json.loads((src / "manifest.json").read_text(encoding="utf-8"))["extra"] == {
        ".agents": str(old_home / ".agents")}          # 真實形狀：帶前導點

    new_home = tmp_path / "new"
    new_home.mkdir()
    monkeypatch.setenv("HOME", str(new_home))
    cfg = tmp_path / "fledge-config.json"
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    client = TestClient(create_app())
    resp = client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(new_home / ".claude")}],
        "extra": [{"name": ".agents", "path": str(new_home / ".agents")}]})
    assert resp.status_code == 200, resp.json()
    assert json.loads(cfg.read_text(encoding="utf-8"))["extra"] == {
        ".agents": str(new_home / ".agents")}
    resp = client.post("/api/restore/install", json={"dest": str(src)})
    assert resp.status_code == 200, resp.json()
    assert (new_home / ".agents" / "skills" / "s" / "SKILL.md").read_text(
        encoding="utf-8") == "X"
    assert (new_home / ".claude" / "skills" / "a.md").read_text(encoding="utf-8") == "A"


def test_install_endpoints_use_config_extra(tmp_path: Path, monkeypatch):
    """F2 端到端（Codex 票 05 R1/R2）：adopt-config 確認 extra → install-plan 把 extra
    數進預覽 → install 落地且帳號內指向它的連結解得開。extra 落點全程只來自 config。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}],
        "extra": [{"name": "agents", "path": str(home / ".agents")}]})
    assert resp.status_code == 200
    resp = client.post("/api/restore/install-plan", json={"dest": str(src)})
    assert resp.status_code == 200
    assert resp.json()["will_install"] == 3      # 帳號 2 檔＋extra 的 SKILL.md
    resp = client.post("/api/restore/install", json={"dest": str(src)})
    assert resp.status_code == 200
    assert (home / ".agents" / "skills" / "s" / "SKILL.md").read_text(encoding="utf-8") == "X"
    assert (home / ".claude" / "skills" / "s" / "SKILL.md").read_text(encoding="utf-8") == "X"


def test_install_plan_excludes_extra_without_config_entry(tmp_path: Path, monkeypatch):
    """config 沒有該 extra 的確認（使用者跳過）→ 經正式 API 的 plan 列 excluded。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    client = TestClient(create_app())
    client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}]})
    resp = client.post("/api/restore/install-plan", json={"dest": str(src)})
    assert resp.status_code == 200
    assert "agents" in resp.json()["excluded"]


def test_install_plan_rejects_overlapping_spots_from_config(tmp_path: Path, monkeypatch):
    """config 被手編成巢狀落點 → install 端點 400 overlapping_config_dirs，不裸 500
    也不動手（Codex 票 07 R1 F2：授權時刻的重疊檢查不能是唯一一道）。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    cfg.write_text(json.dumps({
        "version": 1, "roots": [],
        "accounts": {"work": {"config_dir": str(home / ".claude"), "label": ""}},
        "extra": {"agents": str(home / ".claude" / "agents")},
    }), encoding="utf-8")
    resp = TestClient(create_app()).post("/api/restore/install-plan",
                                         json={"dest": str(src)})
    assert (resp.status_code, resp.json()["error"]) == (400, "overlapping_config_dirs")


def _add_history(src: Path) -> None:
    proj = src / "accounts" / "work" / "projects" / "-Users-olduser-work-app"
    proj.mkdir(parents=True)
    (proj / "s.jsonl").write_text(
        json.dumps({"cwd": "/Users/olduser/work/app"}) + "\n", encoding="utf-8")


def test_bundle_info_route_summarizes_bundle(tmp_path: Path, monkeypatch):
    """唯讀端點（票 02，增補 spec 缺口 1）：`bundle` 頁靠它確認「這是不是我要的那一包」。
    非 bundle 的目錄 → 400 `source_not_a_bundle`（沿用 `_INSTALL_CLIENT_ERRORS` 分流）。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    _add_history(src)
    client = TestClient(create_app())
    resp = client.get("/api/restore/bundle-info", params={"dest": str(src)})
    assert resp.status_code == 200
    assert resp.json() == {
        "host": "old-mac",
        "created": "20260731-1200",
        "accounts": ["work"],
        "extra": ["agents"],
        "project_count": 1,
    }
    resp = client.get("/api/restore/bundle-info", params={"dest": str(tmp_path)})
    assert (resp.status_code, resp.json()["error"]) == (400, "source_not_a_bundle")


def test_bundle_info_route_needs_no_config(tmp_path: Path, monkeypatch):
    """移機的常態是**設定檔還沒落檔**（`adopt-config` 要到下一頁才跑）——摘要端點不得
    因為讀不到 config 就失敗，否則 `bundle` 頁在真正的移機情境下永遠看不到摘要。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "nonexistent.json"))
    src = make_staging(tmp_path)
    resp = TestClient(create_app()).get("/api/restore/bundle-info",
                                        params={"dest": str(src)})
    assert resp.status_code == 200
    assert resp.json()["accounts"] == ["work"]


def test_landing_suggestions_route_returns_spots(tmp_path: Path, monkeypatch):
    """唯讀端點（票 03）：帳號與 extra 各一筆，建議值只在舊路徑位於舊 home 底下時給。
    非 bundle → 400（沿用 `_INSTALL_CLIENT_ERRORS` 分流）。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.get("/api/restore/landing-suggestions", params={"dest": str(src)})
    assert resp.status_code == 200
    assert resp.json() == {
        "home": "/Users/olduser",
        "spots": [
            {"key": "agents", "kind": "extra", "old_path": "/Users/olduser/.agents",
             "suggested": f"{home}/.agents", "suggested_exists": False},
            {"key": "work", "kind": "account", "old_path": "/Users/olduser/.claude",
             "suggested": f"{home}/.claude", "suggested_exists": False},
        ],
    }
    resp = client.get("/api/restore/landing-suggestions", params={"dest": str(tmp_path)})
    assert (resp.status_code, resp.json()["error"]) == (400, "source_not_a_bundle")


def test_landing_suggestions_route_needs_no_config(tmp_path: Path, monkeypatch):
    """與 `bundle-info` 同一條：移機的常態是設定檔還沒落檔（`adopt-config` 是下一步），
    端點不得因為讀不到 config 就失敗。"""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "nonexistent.json"))
    src = make_staging(tmp_path)
    resp = TestClient(create_app()).get("/api/restore/landing-suggestions",
                                        params={"dest": str(src)})
    assert resp.status_code == 200
    assert [s["key"] for s in resp.json()["spots"]] == ["work"]


def test_project_paths_route_reads_bundle(tmp_path: Path, monkeypatch):
    """唯讀端點（票 06）：列備份包裡的專案、舊路徑（讀歷史檔 cwd）、建議新路徑；
    非 bundle 400。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    _add_history(src)
    client = TestClient(create_app())
    resp = client.get("/api/restore/project-paths", params={"dest": str(src)})
    assert resp.status_code == 200
    [p] = resp.json()["projects"]
    assert p["old_path"] == "/Users/olduser/work/app"
    assert p["suggested"] == f"{home}/work/app"
    resp = client.get("/api/restore/project-paths", params={"dest": str(tmp_path)})
    assert (resp.status_code, resp.json()["error"]) == (400, "source_not_a_bundle")


def test_install_endpoints_apply_mapping(tmp_path: Path, monkeypatch):
    """mapping 經正式 API 一路生效（票 06）：install-plan 帶 mapping 預覽（改名表＋
    未對應清單）、install 依同一 mapping 把歷史裝到新名底下；mapping 錯誤映 400。"""
    from fledge_sidecar.project_scanner import encode_cc_project_dir
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    _add_history(src)
    client = TestClient(create_app())
    assert client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}],
    }).status_code == 200
    resp = client.post("/api/restore/install-plan", json={"dest": str(src)})
    assert [u["encoded_dir"] for u in resp.json()["unmapped_projects"]] \
        == ["-Users-olduser-work-app"]
    mapping = [{"old": "/Users/olduser/work/app", "new": f"{home}/work/app"}]
    resp = client.post("/api/restore/install-plan",
                       json={"dest": str(src), "mapping": mapping})
    assert resp.status_code == 200
    new_enc = encode_cc_project_dir(f"{home}/work/app")
    assert resp.json()["project_renames"] == {"-Users-olduser-work-app": new_enc}
    assert resp.json()["unmapped_projects"] == []
    resp = client.post("/api/restore/install",
                       json={"dest": str(src), "mapping": mapping})
    assert resp.status_code == 200
    assert (home / ".claude" / "projects" / new_enc / "s.jsonl").is_file()
    resp = client.post("/api/restore/install-plan", json={
        "dest": str(src),
        "mapping": [{"old": "/Users/olduser/work/app", "new": "rel/path"}]})
    assert (resp.status_code, resp.json()["error"]) == (400, "mapping_not_absolute")


# ── 票 08 收官守門：install 端點的錯誤合約完整性（Codex 階段 10 F6） ──────────────


def test_install_reports_stable_code_when_staging_vanishes_after_plan(
        tmp_path: Path, monkeypatch):
    """server 重算 plan 之後、真正寫入之前 staging 被刪 → 穩定判別碼，不得裸穿 500。

    `_require_source_identity` 的 `os.open` 失敗拋的是 OSError，而 route 只接 ValueError
    ——不正規化就會變成非合約的 500，前端分不出「來源不見了」與「設定檔壞了」。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    real_plan = install.plan

    def _plan_then_remove(*args, **kwargs):
        result = real_plan(*args, **kwargs)
        shutil.rmtree(staging)          # plan 過了、install 還沒開始
        return result

    monkeypatch.setattr(install, "plan", _plan_then_remove)
    resp = TestClient(create_app()).post("/api/restore/install",
                                         json={"dest": str(staging)})
    assert resp.status_code == 400
    assert resp.json()["error"] == "source_not_a_bundle"


def test_install_reports_journal_unavailable_as_itself(tmp_path: Path, monkeypatch):
    """journal 開不起來是**環境問題**，不是設定檔問題——判別碼要說實話。

    誤報成 `config_unreadable` 會讓使用者去修一個沒壞的檔案。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    # **這一輪的 journal 檔**被佔成目錄 → fd-relative 開啟必失敗。
    # 不能再用「~/.fledge 整個佔成一般檔」：票 07 起續作簿記寫在同一個目錄、而且排在
    # `install()` **之前**，那個環境會先撞 `migration_marker_unavailable`（另有專測）。
    # 要驗 journal 這條路徑，故障點就得精準落在 journal 自己身上。
    plan = install.plan(str(staging), {"work": {"config_dir": str(live), "label": ""}})
    install.journal_path(install.transaction_id(plan)).mkdir(parents=True)

    resp = TestClient(create_app()).post("/api/restore/install",
                                         json={"dest": str(staging)})
    assert resp.json()["error"] == "journal_unavailable"
    assert resp.status_code == 500          # 環境問題不是 client 送錯
    assert not (live / "CLAUDE.md").exists(), "journal 開不起來就不該動使用者目錄"


def test_install_rejects_malformed_account_entry_in_config(tmp_path: Path, monkeypatch):
    """config.json 是使用者可手編的：帳號項不是物件 → 穩定判別碼，不得 AttributeError 裸穿。

    票 07 對 extra 已做「非字串視同未確認」，帳號側要有同等的形狀檢查。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    cfg = tmp_path / "config.json"
    data = json.loads(cfg.read_text(encoding="utf-8"))
    data["accounts"]["work"] = "/somewhere"          # 手編成字串
    cfg.write_text(json.dumps(data), encoding="utf-8")

    resp = TestClient(create_app()).post("/api/restore/install",
                                         json={"dest": str(staging)})
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_account_entry"


def test_install_still_reports_source_root_moved_as_client_error(
        tmp_path: Path, monkeypatch):
    """回歸保護：`source_root_moved` 本來就在 client 錯誤清單裡，別在修上面三條時弄丟。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    real_plan = install.plan

    def _plan_then_swap(*args, **kwargs):
        result = real_plan(*args, **kwargs)
        shutil.rmtree(staging)
        make_staging(tmp_path)          # 同路徑、換一個 inode
        return result

    monkeypatch.setattr(install, "plan", _plan_then_swap)
    resp = TestClient(create_app()).post("/api/restore/install",
                                         json={"dest": str(staging)})
    assert resp.status_code == 400
    assert resp.json()["error"] == "source_root_moved"


def test_install_endpoints_report_config_unreadable_for_malformed_containers(
        tmp_path: Path, monkeypatch):
    """config 的頂層容器欄位畸形（手編出 `roots: 1`／`project_overrides: []`）→ 兩支
    install 端點都回 `config_unreadable`，不得讓框架產生非合約 500。

    `_from_data` 對容器欄位不驗形狀，拋的是 TypeError／AttributeError 而非 ValueError
    （Codex 階段 10 守門 R2 實測）。**config 的容錯判準是另一張票的主題**
    （`.scratch/config-resilience/issues/01`——在 `load()` 丟棄畸形資料會造成不可逆
    遺失，那張票的四輪 PR-gate 就是栽在這裡）；這裡只保證端點合約。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    cfg = tmp_path / "config.json"
    client = TestClient(create_app())

    for malformed in ({"accounts": {}, "roots": 1},
                      {"accounts": {}, "project_overrides": []},
                      {"accounts": {}, "manual_projects": 5}):
        cfg.write_text(json.dumps(malformed), encoding="utf-8")
        for path in ("/api/restore/install-plan", "/api/restore/install"):
            resp = client.post(path, json={"dest": str(staging)})
            assert resp.status_code == 500, (path, malformed)
            assert resp.json()["error"] == "config_unreadable", (path, malformed)
        # /api/restore/plan 走同一份 config，合約要一致（Codex 階段 10 守門 R3）
        resp = client.post("/api/restore/plan", json={"bundle": BUNDLE})
        assert resp.status_code == 500, malformed
        assert resp.json()["error"] == "config_unreadable", malformed


def test_config_read_failures_are_part_of_the_endpoint_contract(
        tmp_path: Path, monkeypatch):
    """設定檔讀不出來（是目錄、沒權限）也是「讀不出來」——同樣回穩定判別碼。

    `Path.read_text()` 拋的是 `OSError` 家族（`IsADirectoryError`／`PermissionError`），
    不在原本的 tuple 裡就會裸穿成非合約 500（Codex 階段 10 守門 R3）。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    client = TestClient(create_app())

    as_dir = tmp_path / "config-as-dir.json"
    as_dir.mkdir()
    no_perm = tmp_path / "config-no-perm.json"
    no_perm.write_text(json.dumps({"accounts": {}}), encoding="utf-8")
    no_perm.chmod(0o000)
    try:
        for broken in (as_dir, no_perm):
            monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(broken))
            for path, body in (("/api/restore/install-plan", {"dest": str(staging)}),
                               ("/api/restore/install", {"dest": str(staging)}),
                               ("/api/restore/plan", {"bundle": BUNDLE})):
                resp = client.post(path, json=body)
                assert resp.status_code == 500, (path, broken.name)
                assert resp.json()["error"] == "config_unreadable", (path, broken.name)
    finally:
        no_perm.chmod(0o600)          # 讓 tmp_path 清得掉


def test_missing_config_still_reads_as_not_initialized_not_unreadable(
        tmp_path: Path, monkeypatch):
    """**`FileNotFoundError` 是 `OSError` 子類**——把 OSError 納進「讀不出來」之後，
    `except FileNotFoundError` 必須排在前面，否則「還沒初始化」會被吞成「設定檔壞掉」，
    而前者是引導精靈該接手的狀態、後者是叫使用者去修檔案。這條釘住那個順序。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "does-not-exist.json"))

    resp = TestClient(create_app()).post("/api/restore/install",
                                         json={"dest": str(staging)})
    assert resp.status_code == 400
    assert resp.json()["error"] == "config_not_initialized"


# ── 路徑模式：使用者用系統檔案選擇器挑的包（票 11）────────────────────────────
#
# 移機情境的存在理由：新機器上 `backup_dir` 還是空字串（config 要到 targets 頁的
# adopt-config 才落檔），而備份包在隨身碟／NAS——名字模式必然撞 backup_dir_not_set。


def _loose_bundle(tmp_path: Path, name: str = BUNDLE) -> Path:
    """一個**不在** backup_dir 裡的備份包（隨身碟／下載資料夾的模擬）。"""
    d = tmp_path / "usb"
    d.mkdir(exist_ok=True)
    f = d / name
    f.write_bytes(b"x")
    return f


def test_plan_accepts_a_bundle_path_outside_the_backup_dir(tmp_path: Path, monkeypatch):
    """**這條測試就是本票存在的理由**：`backup_dir` 是空字串（全新機器的預設狀態）時，
    名字模式會撞 `backup_dir_not_set`，而路徑模式要照樣走得完。"""
    _config(tmp_path, monkeypatch, backup_dir="", with_bundle=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    bundle = _loose_bundle(tmp_path)
    client = TestClient(create_app())

    named = client.post("/api/restore/plan", json={"bundle": BUNDLE})
    assert named.status_code == 400
    assert named.json()["error"] == "backup_dir_not_set"

    resp = client.post("/api/restore/plan", json={"bundle_path": str(bundle)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["bundle"] == str(bundle)
    assert body["dest"] == str(tmp_path / "home" / ".claude-restore-20260101-1200")
    assert body["dest_status"] == "ok"


def test_plan_rejects_giving_both_bundle_and_bundle_path(tmp_path: Path, monkeypatch):
    """兩個來源都給＝授權歧義。**不讓後蓋前**（比照 adopt-config 的 duplicate_account_key）
    ——默默挑一個，使用者就無從知道實際用了哪一份包。"""
    _config(tmp_path, monkeypatch)
    bundle = _loose_bundle(tmp_path, "claude-backup-20260202-0900.tar.gz")
    client = TestClient(create_app())

    resp = client.post("/api/restore/plan", json={"bundle": BUNDLE, "bundle_path": str(bundle)})
    assert resp.status_code == 400
    assert resp.json()["error"] == "bundle_source_ambiguous"


def test_plan_rejects_giving_neither_source(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch)
    client = TestClient(create_app())

    resp = client.post("/api/restore/plan", json={})
    assert resp.status_code == 400
    assert resp.json()["error"] == "bundle_required"


def test_plan_path_mode_refuses_to_guess_a_dest_from_an_odd_filename(tmp_path: Path, monkeypatch):
    """檔名不符命名規則且沒指定位置 → 要使用者挑，不猜一個目錄名。"""
    _config(tmp_path, monkeypatch, backup_dir="")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    bundle = _loose_bundle(tmp_path, "my-backup.tgz")
    client = TestClient(create_app())

    resp = client.post("/api/restore/plan", json={"bundle_path": str(bundle)})
    assert resp.status_code == 400
    assert resp.json()["error"] == "dest_required"

    ok = client.post("/api/restore/plan",
                     json={"bundle_path": str(bundle), "dest": str(tmp_path / "here")})
    assert ok.status_code == 200, ok.text
    assert ok.json()["dest"] == str(tmp_path / "here")


def test_plan_path_mode_still_validates_the_source(tmp_path: Path, monkeypatch):
    """沒有 allowlist **不等於**不驗：型別與可讀性的判別碼要原樣透出去。"""
    _config(tmp_path, monkeypatch, backup_dir="")
    client = TestClient(create_app())
    adir = tmp_path / "adir"
    adir.mkdir()

    for path, code in (
        ("relative/x.tar.gz", "bundle_path_invalid"),
        (str(tmp_path / "gone.tar.gz"), "bundle_not_found"),
        (str(adir), "bundle_not_a_file"),
    ):
        resp = client.post("/api/restore/plan", json={"bundle_path": path})
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"] == code


def test_restore_session_accepts_a_bundle_path_outside_the_backup_dir(tmp_path: Path, monkeypatch):
    """移機的實際形狀：`backup_dir` 空字串、包在隨身碟，argv 仍由後端組且不經 shell。"""
    _config(tmp_path, monkeypatch, backup_dir="", with_bundle=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    bundle = _loose_bundle(tmp_path, "my backup.tar.gz")   # 含空白，驗證不經 shell
    dest = tmp_path / "My Restore"
    captured: dict = {}

    class _Session:
        session_id = "s"

    monkeypatch.setattr(
        "fledge_sidecar.routes.sessions._bridge.create_session",
        lambda **kw: (captured.update(kw), _Session())[1],
    )
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "kind": "restore",
        "restore_bundle_path": str(bundle), "restore_dest": str(dest),
    })
    assert resp.status_code == 200, resp.text
    argv = captured["command"]
    assert argv[0] == "/bin/bash"
    assert argv[1].endswith("restore-claude.sh")
    assert argv[2] == str(bundle)          # 路徑原樣進 argv，不經 shell 拼接
    assert argv[3:] == ["-o", str(dest)]


def test_restore_session_rejects_both_sources(tmp_path: Path, monkeypatch):
    _config(tmp_path, monkeypatch)
    bundle = _loose_bundle(tmp_path, "claude-backup-20260202-0900.tar.gz")
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "kind": "restore",
        "restore_bundle": BUNDLE, "restore_bundle_path": str(bundle),
    })
    assert resp.status_code == 400
    assert resp.json()["error"] == "bundle_source_ambiguous"


def test_restore_session_keeps_its_own_missing_source_code(tmp_path: Path, monkeypatch):
    """模組層拋的是 `bundle_required`，但這支端點的欄位叫 `restore_bundle`——既有判別碼
    不改（前端的映射表與既有測試都依賴它）。規則仍只有一份，只在 route 映射碼。"""
    _config(tmp_path, monkeypatch)
    resp = TestClient(create_app()).post("/api/sessions", json={"path": "", "kind": "restore"})
    assert resp.status_code == 400
    assert resp.json()["error"] == "restore_bundle_required"


def test_restore_session_path_mode_skips_the_backup_dir_gate(tmp_path: Path, monkeypatch):
    """閘序：路徑模式**跳過** backup_dir（新機器沒有它是正常狀態），但環境前提照擋。"""
    _config(tmp_path, monkeypatch, backup_dir="", with_script=False, with_bundle=False)
    bundle = _loose_bundle(tmp_path)
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "kind": "restore", "restore_bundle_path": str(bundle),
    })
    assert resp.json()["error"] == "restore_script_missing"   # 不是 backup_dir_not_set


def test_restore_session_path_mode_revalidates_the_source(tmp_path: Path, monkeypatch):
    """spawn 前的閘照樣重驗來源——plan 說可以，到按下去之間 FS 可能已經變了。"""
    _config(tmp_path, monkeypatch, backup_dir="", with_bundle=False)
    adir = tmp_path / "adir"
    adir.mkdir()
    client = TestClient(create_app())
    for path, code in (
        ("relative/x.tar.gz", "bundle_path_invalid"),
        (str(tmp_path / "gone.tar.gz"), "bundle_not_found"),
        (str(adir), "bundle_not_a_file"),
    ):
        resp = client.post("/api/sessions", json={
            "path": "", "kind": "restore", "restore_bundle_path": path,
        })
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"] == code


def test_restore_session_path_mode_still_enforces_containment(tmp_path: Path, monkeypatch):
    """**containment 不因來源模式而鬆動**：展開位置落在現役資料裡面，路徑模式一樣擋。

    後果不是「檔案被覆蓋」而是更難察覺的——把一份完整副本折回備份來源，下一次備份會把它
    整包再收一遍。"""
    _config(tmp_path, monkeypatch, backup_dir="", with_bundle=False)
    bundle = _loose_bundle(tmp_path)
    inside = tmp_path / "claude" / "restored"     # `claude` 是 config 裡的帳號目錄
    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "kind": "restore",
        "restore_bundle_path": str(bundle), "restore_dest": str(inside),
    })
    assert resp.status_code == 400
    assert resp.json()["error"] == "dest_inside_source"


# ── spawn 前的閘與實際 argv 必須是同一組值（Codex 票 11 審查）──────────────────
# 閘驗過一組 `(bundle, dest)` 之後，若組 argv 時再解析一次，實際跑的可能是**沒被驗過**的
# 另一組——`resolve_dest` 的撞名迴圈會探測檔案系統，兩次之間狀態變了就會給出不同答案。


def _spawn_capture(monkeypatch) -> dict:
    captured: dict = {}

    class _Session:
        session_id = "s"

    monkeypatch.setattr(
        "fledge_sidecar.routes.sessions._bridge.create_session",
        lambda **kw: (captured.update(kw), _Session())[1],
    )
    return captured


def _occupy_after_gate(monkeypatch, victim: Path):
    """在閘的最後一步（`check_dest`）跑完之後占用 `victim`，模擬「驗過到用之間」的變化。"""
    real = restore_mod.check_dest

    def _hook(abs_path: str, roots: list[str]):
        verdict = real(abs_path, roots)
        victim.mkdir(parents=True, exist_ok=True)
        (victim / "someone-elses").write_bytes(b"x")
        return verdict

    monkeypatch.setattr("fledge_sidecar.backup.restore.check_dest", _hook)


def test_restore_session_spawns_exactly_what_the_gate_approved(tmp_path: Path, monkeypatch):
    """閘算出預設位置 `base` 並驗過；驗完後 `base` 被占用。若組 argv 時重新解析，
    `resolve_dest` 的撞名迴圈會改回 `base-1`——那一個**沒有經過 check_dest**。"""
    _config(tmp_path, monkeypatch, backup_dir="", with_bundle=False)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    bundle = _loose_bundle(tmp_path)
    base = home / ".claude-restore-20260101-1200"
    _occupy_after_gate(monkeypatch, base)
    captured = _spawn_capture(monkeypatch)

    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "kind": "restore", "restore_bundle_path": str(bundle),
    })

    assert resp.status_code == 200, resp.text
    assert captured["command"][-1] == str(base)      # 閘驗過的那一個，不是 base-1


def test_restore_session_does_not_500_when_the_bundle_vanishes_mid_request(
    tmp_path: Path, monkeypatch,
):
    """驗過之後備份包被拔掉（隨身碟拔除）。這個窗口關不掉——tar 終究要以 pathname 重開——
    但它**不該變成裸 500**：閘已經放行，就用閘驗過的那組值往下走，讓展開自己失敗並把訊息
    顯示在 PTY 上（票 02 的「展開失敗要有明確訊息」）。"""
    _config(tmp_path, monkeypatch, backup_dir="", with_bundle=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    bundle = _loose_bundle(tmp_path)
    real = restore_mod.check_dest

    def _hook(abs_path: str, roots: list[str]):
        verdict = real(abs_path, roots)
        bundle.unlink()          # 驗完之後才消失
        return verdict

    monkeypatch.setattr("fledge_sidecar.backup.restore.check_dest", _hook)
    captured = _spawn_capture(monkeypatch)

    resp = TestClient(create_app()).post("/api/sessions", json={
        "path": "", "kind": "restore", "restore_bundle_path": str(bundle),
    })

    assert resp.status_code == 200, resp.text
    assert captured["command"][2] == str(bundle)


def test_install_route_reports_stale_temps_with_absolute_paths(tmp_path: Path, monkeypatch):
    """票 06（增補 spec §4）：前一輪硬中斷留下的暫存檔要**經 API 回到使用者眼前**。

    這條刻意是端到端的：殘骸清單是經一個**選填**參數帶出來的，route 忘了傳的話，安裝
    照樣成功、log 照樣有、所有既有回傳斷言照樣綠，而 API 永遠回空清單——功能等於沒做。
    模組層測試看不到這個形狀。

    殘骸要是**真的**：跑到「暫存檔已落盤、最終名還沒出現」的窗口後 SIGKILL（比照
    `test_install_interrupt`）——例外走得到 Python 的清理路徑，硬中斷走不到，而後者
    正是留下殘骸的那個失敗模式。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)

    proc = spawn_install_until_barrier(tmp_path, staging, live, "after_temp")
    proc.kill()
    proc.wait(timeout=10)
    # 期望值以 resolved 路徑表示：落點在 plan 裡就已 resolve（macOS 的 /var → /private/var）
    leftovers = sorted(str(p) for p in live.resolve().rglob(".fledge-install-*"))
    assert leftovers, "前提沒成立：中斷沒有留下暫存檔"

    resp = TestClient(create_app()).post("/api/restore/install",
                                         json={"dest": str(staging)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["stale_temps"] == leftovers
    # 既有回應形狀不變（結果清單仍是那份），殘骸只是多出來的一欄
    assert any(r["outcome"] == "installed" for r in body["results"])
    # **只回報不刪**：判準全是可偽造的檔名特徵，達不到「只刪自己建的」這條底線
    assert all(Path(p).exists() for p in leftovers)


# ── 中斷續作的簿記（票 07，增補 spec §3） ────────────────────────────────────


def _marker(tmp_path: Path) -> Path:
    return tmp_path / "home" / ".fledge" / "migration-in-progress.json"


def _journals(tmp_path: Path) -> list[Path]:
    fledge = tmp_path / "home" / ".fledge"
    return sorted(fledge.glob("restore-journal-*.jsonl")) if fledge.is_dir() else []


def test_migration_status_is_none_on_a_clean_machine(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir(exist_ok=True)
    resp = TestClient(create_app()).get("/api/restore/migration-status")
    assert resp.status_code == 200
    assert resp.json() == {"state": "none"}


def test_install_clears_both_bookkeeping_files_on_full_success(
        tmp_path: Path, monkeypatch):
    """完整成功：journal（安全簿記）與 marker（續作資訊）**一起**消失——留下任何一個
    都會讓還原卡永遠顯示「上次的移機還沒完成」。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    client = TestClient(create_app())

    resp = client.post("/api/restore/install", json={"dest": str(staging)})

    assert resp.status_code == 200
    assert {r["outcome"] for r in resp.json()["results"]} == {"installed"}
    assert not _marker(tmp_path).exists()
    assert _journals(tmp_path) == []
    assert client.get("/api/restore/migration-status").json() == {"state": "none"}


def test_install_keeps_bookkeeping_when_anything_failed(tmp_path: Path, monkeypatch):
    """有 failed：兩個檔都保留——修好之後要能接著跑，而續作靠 marker 找回展開位置。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    client = TestClient(create_app())
    # 落點唯讀 → 寫入拿到 EACCES → failed。**同名檔案不行**：那是 no-clobber 的 skipped，
    # 一整輪照樣「無 failed」，簿記會被清掉而這條測試什麼都沒驗到
    live.chmod(0o500)
    try:
        resp = client.post("/api/restore/install", json={"dest": str(staging)})
    finally:
        live.chmod(0o700)

    assert any(r["outcome"] == "failed" for r in resp.json()["results"])
    assert _marker(tmp_path).exists()
    assert len(_journals(tmp_path)) == 1
    assert client.get("/api/restore/migration-status").json() == {
        "state": "resumable", "source_root": str(staging.resolve()), "mapping": []}


def test_install_refuses_to_start_when_the_marker_cannot_be_written(
        tmp_path: Path, monkeypatch):
    """簿記寫不進去就**不准開始**（增補 spec §3.2）：照樣安裝的話，硬中斷之後只剩
    journal → 沒有續作資訊 → 而 config 早已落檔、重走精靈會撞 adopt-config 的 409，
    正好重現這張票要消除的那條死路。

    要求是**回穩定判別碼且一個 target 都沒被動過**——不是「裝到一半卡死」。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    called: list[int] = []
    monkeypatch.setattr(install, "install",
                        lambda *a, **kw: called.append(1) or [])
    fledge = tmp_path / "home" / ".fledge"
    fledge.mkdir(parents=True, exist_ok=True)
    fledge.chmod(0o500)                     # 目錄唯讀 → atomic write 的第一步就失敗
    try:
        resp = TestClient(create_app()).post("/api/restore/install",
                                             json={"dest": str(staging)})
    finally:
        fledge.chmod(0o700)

    assert resp.status_code == 500
    assert resp.json()["error"] == "migration_marker_unavailable"
    assert called == [], "簿記失敗時 install() 一次都不該被呼叫"
    assert list(live.iterdir()) == []


def test_marker_survives_when_journal_cleanup_fails_after_success(
        tmp_path: Path, monkeypatch):
    """**安裝成功但 journal 清不掉**（`install()` 用 suppress 吞掉，結果照樣無 failed）：
    marker 必須保留。只憑「無 failed」就刪 marker 會留下「journal 還在、marker 沒了」
    ＝ `unfinished_unknown`——安裝其實已經成功，使用者卻看到「未完成」而且**不能續作**。

    保留 marker 的話狀態是 `resumable`，使用者頂多多按一次繼續（續作冪等、全部 skipped）。"""
    _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    real_unlink = Path.unlink

    def _refuse_journal_unlink(self: Path, *args, **kwargs):
        if self.name.startswith("restore-journal-"):
            raise PermissionError(13, "denied")
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", _refuse_journal_unlink)
    client = TestClient(create_app())

    resp = client.post("/api/restore/install", json={"dest": str(staging)})

    assert {r["outcome"] for r in resp.json()["results"]} == {"installed"}
    assert _marker(tmp_path).exists(), "journal 還在，marker 就不能刪"
    assert client.get("/api/restore/migration-status").json()["state"] == "resumable"


def test_migration_status_hands_back_the_mapping_that_was_sent(
        tmp_path: Path, monkeypatch):
    """續作要能把上次填的專案對應原封不動帶回精靈——那組值只存在於這份簿記裡
    （journal 記的是改名**後**的位置，推不回原始 mapping）。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    (staging / "accounts" / "work" / "projects" / "-old-a").mkdir(parents=True)
    (staging / "accounts" / "work" / "projects" / "-old-a" / "s.jsonl").write_text(
        json.dumps({"cwd": "/old/a"}) + "\n", encoding="utf-8")
    client = TestClient(create_app())

    live.chmod(0o500)                       # 製造 failed → 簿記保留（理由同上一條）
    try:
        client.post("/api/restore/install", json={
            "dest": str(staging),
            "mapping": [{"old": "/old/a", "new": str(tmp_path / "newa")}]})
    finally:
        live.chmod(0o700)

    body = client.get("/api/restore/migration-status").json()
    assert body["state"] == "resumable"
    assert body["mapping"] == [{"old": "/old/a", "new": str(tmp_path / "newa")}]


def test_marker_survives_failures_even_if_the_journal_vanishes(
        tmp_path: Path, monkeypatch):
    """刪除 gate 的**兩個條件各自有意義**（增補 spec §3.2：無 failed **且** journal 確認
    不在了）。正常路徑下兩者互相蘊含——有 failed 就不會清 journal——所以只有把 journal
    從外部拿掉，才驗得到「無 failed」那一半是不是真的在把關。

    真實對應：使用者手動清了 `~/.fledge`，或另一個 Fledge 實例插手（單實例是假設不是
    保證）。這時候安裝有失敗＝沒收尾，續作資訊就該留著。"""
    live = _install_config(tmp_path, monkeypatch)
    staging = make_staging(tmp_path)
    real_install = install.install

    def _install_then_lose_the_journal(plan, **kwargs):
        results = real_install(plan, **kwargs)
        install.journal_path(install.transaction_id(plan)).unlink(missing_ok=True)
        return results

    monkeypatch.setattr(install, "install", _install_then_lose_the_journal)
    live.chmod(0o500)                       # 造 failed
    try:
        resp = TestClient(create_app()).post("/api/restore/install",
                                             json={"dest": str(staging)})
    finally:
        live.chmod(0o700)

    assert any(r["outcome"] == "failed" for r in resp.json()["results"])
    assert _marker(tmp_path).exists(), "有 failed 就不該清掉續作資訊"


# ---------- 票 09：從備份包帶回 Fledge 自己的設定 ----------
#
# `backup-claude.sh:267` 把整份 `~/.fledge/config.json` 打進 `<bundle>/fledge/config.json`，
# 但移機路徑從來不讀它——`subscriptions`／`kms_root`／`roots` 因此永遠停在 DEFAULT_CONFIG
# 的空值，而且沒有任何一頁讓使用者發現（增補 spec §2.6 缺口 5、§2.8.3）。
#
# 讀取走票 10 的共用原語；**包裡的 config.json 與 manifest 同級，都是不可信輸入**。


def _plant_bundle_config(src: Path, payload) -> None:
    """比照備份腳本的產出佈局塞一份 `<bundle>/fledge/config.json`。"""
    (src / "fledge").mkdir(exist_ok=True)
    (src / "fledge" / "config.json").write_text(json.dumps(payload), encoding="utf-8")


def _adopt(client, src: Path, home: Path, **extra):
    return client.post("/api/restore/adopt-config", json={
        "dest": str(src),
        "accounts": [{"key": "work", "config_dir": str(home / ".claude")}],
        **extra})


def test_adopt_config_brings_back_subscriptions_kms_root_and_roots(
        tmp_path: Path, monkeypatch):
    """成功路徑：三欄都在包裡、在新機都通得過驗證 → 全部帶回。

    這是本票存在的理由——這三個值本來就在備份包裡，只是沒人讀它。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    kms = tmp_path / "kms"
    kms.mkdir()
    projects = tmp_path / "projects"
    projects.mkdir()
    _plant_bundle_config(src, {
        "version": 1,
        "subscriptions": [{"name": "Codex", "monthly_cost": 20}],
        "kms_root": str(kms),
        "roots": [{"path": str(projects), "default_account": "work"}],
        "accounts": {"work": {"config_dir": "/Users/olduser/.claude", "label": ""}},
    })
    resp = _adopt(TestClient(create_app()), src, home)
    assert resp.status_code == 200
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["subscriptions"] == [{"name": "Codex", "monthly_cost": 20.0}]
    assert data["kms_root"] == str(kms)
    assert [(r["path"], r["default_account"]) for r in data["roots"]] == \
        [(str(projects), "work")]
    # 包裡的 accounts 是**舊機的落點**，一個位元組都不准回到 config——授權只認使用者
    # 在 targets 頁確認的那一份（spec §4.2.2）。這是本票最容易做壞的地方。
    assert data["accounts"] == {"work": {"config_dir": str(home / ".claude"), "label": ""}}
    assert "/Users/olduser" not in cfg.read_text(encoding="utf-8")


def test_adopt_config_succeeds_when_the_bundle_has_no_fledge_config(
        tmp_path: Path, monkeypatch):
    """舊版備份腳本產的包根本沒有 `fledge/`——三欄當作沒有，**移機不失敗**。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    resp = _adopt(TestClient(create_app()), src, home)
    assert resp.status_code == 200
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert (data["subscriptions"], data["kms_root"], data["roots"]) == ([], "", [])


def test_adopt_config_survives_a_hostile_fledge_config(tmp_path: Path, monkeypatch):
    """**惡意包不得讓 `adopt-config` 回 5xx**——每一種壞形狀都要 200 且移機能繼續。

    `null`／字串／數字／陣列的 item 正是既有 `put_subscriptions` 會 `AttributeError`
    → 裸 500 的那組（它靠 Pydantic 擋，這條路徑沒有那層）。"""
    hostile = [
        "not an object", ["not", "an", "object"], 42, None,
        {"subscriptions": "not a list"},
        {"subscriptions": {"name": "Codex"}},
        {"subscriptions": [None, "Codex", 7, ["a"], {"name": ""}]},
        {"kms_root": 7}, {"kms_root": ["/tmp"]}, {"kms_root": "relative/path"},
        {"roots": "not a list"}, {"roots": [None, 7, {"path": 1}, {}]},
    ]
    for i, payload in enumerate(hostile):
        base = tmp_path / f"hostile{i}"
        base.mkdir()
        cfg, src, home = _adopt_env(base, monkeypatch)
        _plant_bundle_config(src, payload)
        resp = _adopt(TestClient(create_app()), src, home)
        assert resp.status_code == 200, f"{payload!r} → {resp.status_code}"
        data = json.loads(cfg.read_text(encoding="utf-8"))
        assert data["accounts"]["work"]["config_dir"] == str(home / ".claude")


def test_adopt_config_drops_bad_subscription_items_and_keeps_good_ones(
        tmp_path: Path, monkeypatch):
    """兩層容錯的**第二層**：list 內逐項判，壞項丟棄、好項保留，**不連坐**。

    同名不去重（`put_subscriptions` 也不去重——同一份資料兩條規則必然漂移）；
    多餘欄位丟掉；`"12.5"` 這種可轉字串照收（沿用既有的寬鬆判準，不趁機收緊）。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    _plant_bundle_config(src, {"subscriptions": [
        {"name": "Codex", "monthly_cost": 20, "note": "多餘欄位"},
        None, "Codex", 7, ["Codex", 20],
        {"name": "", "monthly_cost": 1},
        {"name": "Bad", "monthly_cost": "abc"},
        {"name": "Neg", "monthly_cost": -1},
        {"name": "Inf", "monthly_cost": float("inf")},
        {"name": "Codex", "monthly_cost": "12.5"},          # 同名不去重
    ]})
    assert _adopt(TestClient(create_app()), src, home).status_code == 200
    assert json.loads(cfg.read_text(encoding="utf-8"))["subscriptions"] == [
        {"name": "Codex", "monthly_cost": 20.0},
        {"name": "Codex", "monthly_cost": 12.5},
    ]


def test_adopt_config_drops_a_kms_root_that_is_missing_on_the_new_machine(
        tmp_path: Path, monkeypatch):
    """`kms_root` 是**舊機的路徑**，在新機多半不存在——不存在就不帶回。

    帶回一個指不到東西的路徑比留空更糟：使用者會以為知識庫已經設好了，而記憶頁
    永遠是空的。走與 `roots` 相同的 `expand_and_validate` + `probe_dir`。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    a_file = tmp_path / "a-file"
    a_file.write_text("x", encoding="utf-8")
    _plant_bundle_config(src, {"kms_root": "/Users/olduser/kms"})
    assert _adopt(TestClient(create_app()), src, home).status_code == 200
    assert json.loads(cfg.read_text(encoding="utf-8"))["kms_root"] == ""

    base = tmp_path / "notdir"
    base.mkdir()
    cfg2, src2, home2 = _adopt_env(base, monkeypatch)
    _plant_bundle_config(src2, {"kms_root": str(a_file)})   # 存在但不是目錄
    assert _adopt(TestClient(create_app()), src2, home2).status_code == 200
    assert json.loads(cfg2.read_text(encoding="utf-8"))["kms_root"] == ""


def test_adopt_config_drops_roots_that_are_missing_or_point_at_unconfirmed_accounts(
        tmp_path: Path, monkeypatch):
    """包裡的 roots 逐項驗、**壞項丟棄不連坐也不失敗**——與 `body.roots` 的處置不同。

    `body.roots` 是使用者送的，`default_account` 指向沒確認的帳號要回 400
    （`unknown_account`，既有行為）；包裡的是不可信輸入，同樣的情形只丟棄那一項——
    使用者在 targets 頁只選了部分帳號時，指向沒選帳號的 root 是**正常情況**，
    不該讓整個移機失敗。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    good = tmp_path / "good"
    good.mkdir()
    _plant_bundle_config(src, {"roots": [
        {"path": str(good), "default_account": "work"},
        {"path": str(good), "default_account": "personal"},   # 沒確認的帳號
        {"path": "/Users/olduser/projects", "default_account": "work"},   # 新機沒有
        {"path": "", "default_account": "work"},
    ]})
    assert _adopt(TestClient(create_app()), src, home).status_code == 200
    assert [(r["path"], r["default_account"])
            for r in json.loads(cfg.read_text(encoding="utf-8"))["roots"]] == \
        [(str(good), "work")]


def test_adopt_config_lets_user_sent_roots_win_over_the_bundle(tmp_path: Path, monkeypatch):
    """`body.roots` 非空 → 完全以它為準，包裡的不摻進來。

    使用者明確送出的是授權，包裡的只是「沒有更好的來源時的替代」。移機分支目前一律
    送空陣列（`sidecar.ts`），所以實務上走的是包裡那條——但兩個來源合併會讓同一個
    路徑出現兩次、`default_account` 還可能不同，那是說不清楚的狀態。"""
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    mine = tmp_path / "mine"
    mine.mkdir()
    theirs = tmp_path / "theirs"
    theirs.mkdir()
    _plant_bundle_config(src, {"roots": [{"path": str(theirs), "default_account": "work"}]})
    resp = _adopt(TestClient(create_app()), src, home,
                  roots=[{"path": str(mine), "default_account": "work"}])
    assert resp.status_code == 200
    assert [r["path"] for r in json.loads(cfg.read_text(encoding="utf-8"))["roots"]] == \
        [str(mine)]


def test_adopt_config_reads_the_bundle_config_through_the_safe_primitive(
        tmp_path: Path, monkeypatch):
    """`fledge/` 是指向展開目錄外的 symlink → 讀取被票 10 的原語擋下，三欄當作沒有。

    **不是 400**：讀不出來與「包裡沒有」對這三欄是同一件事（移機不因此失敗）。這條
    釘的是「這條路徑真的走共用原語」——換回裸 `read_text()` 就會跟過去讀到包外的
    JSON，然後把別人的 kms_root 寫進使用者的設定檔。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    kms = tmp_path / "kms"
    kms.mkdir()
    (outside / "config.json").write_text(
        json.dumps({"kms_root": str(kms)}), encoding="utf-8")
    cfg, src, home = _adopt_env(tmp_path, monkeypatch)
    (src / "fledge").symlink_to(outside, target_is_directory=True)
    assert _adopt(TestClient(create_app()), src, home).status_code == 200
    assert json.loads(cfg.read_text(encoding="utf-8"))["kms_root"] == ""

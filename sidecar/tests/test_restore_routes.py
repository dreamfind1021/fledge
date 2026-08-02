"""還原的路由契約：`POST /api/restore/plan` 與 `POST /api/sessions` 的 kind=restore。

全程 tmp_path 假 config、假 scripts 目錄與 stub 腳本——**不碰真實 Claude 目錄，也不真的
展開任何東西**（成功路徑攔截 create_session，只驗後端組出來的 argv）。
"""
import json
from pathlib import Path

from conftest import make_staging
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

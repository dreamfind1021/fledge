import json
from datetime import datetime
from pathlib import Path

from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app


def _setup(tmp_path: Path, monkeypatch, backup_dir: str = "") -> None:
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps(
            {
                "version": 1,
                "roots": [],
                "accounts": {"default": {"config_dir": str(tmp_path / "claude"), "label": ""}},
                "backup_dir": backup_dir,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))


def test_not_configured(tmp_path: Path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["configured"] is False
    assert body["backup_dir"] == ""


def test_configured_and_usable(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    _setup(tmp_path, monkeypatch, backup_dir=str(out))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["configured"] is True
    assert body["backup_dir"] == str(out)
    assert body["dir_status"] == "dir"


def test_reports_missing_directory(tmp_path: Path, monkeypatch):
    _setup(tmp_path, monkeypatch, backup_dir=str(tmp_path / "gone"))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["dir_status"] == "missing"


def test_reports_not_a_directory(tmp_path: Path, monkeypatch):
    f = tmp_path / "a-file"
    f.write_text("x", encoding="utf-8")
    _setup(tmp_path, monkeypatch, backup_dir=str(f))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["dir_status"] == "not_dir"


def test_reports_denied(tmp_path: Path, monkeypatch):
    """讀不到與不存在必須分得開——使用者要知道是「不見了」還是「沒權限」。"""
    parent = tmp_path / "locked"
    target = parent / "backups"
    target.mkdir(parents=True)
    parent.chmod(0o000)
    try:
        _setup(tmp_path, monkeypatch, backup_dir=str(target))
        body = TestClient(create_app()).get("/api/backup/status").json()
        assert body["dir_status"] == "denied"
    finally:
        parent.chmod(0o755)  # 還原，否則 tmp_path 清不掉


def test_status_never_errors_on_bad_config(tmp_path: Path, monkeypatch):
    """目錄問題不是錯誤：一律 200，用旗標表達。錯誤只留給請求本身壞掉。"""
    _setup(tmp_path, monkeypatch, backup_dir=str(tmp_path / "gone"))
    assert TestClient(create_app()).get("/api/backup/status").status_code == 200


def test_containment_ok_for_unrelated_dir(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    _setup(tmp_path, monkeypatch, backup_dir=str(out))
    assert TestClient(create_app()).get("/api/backup/status").json()["containment"] == "ok"


def test_containment_reports_inside_source(tmp_path: Path, monkeypatch):
    """事後才變得不合法的情形（例如新增了包住它的帳號）：值已在設定檔裡，status 要如實回報。"""
    inside = tmp_path / "claude" / "projects" / "backups"
    inside.mkdir(parents=True)
    _setup(tmp_path, monkeypatch, backup_dir=str(inside))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["containment"] == "inside_source"


def test_relative_path_reported_via_containment_not_dir_status(tmp_path: Path, monkeypatch):
    """`invalid` 屬於 containment 而不是 dir_status：後者回答「這個目錄現在怎麼樣」，
    前者回答「這個位置能不能用」。相對路徑連目錄都稱不上，探測它沒有意義。"""
    _setup(tmp_path, monkeypatch, backup_dir="foo")
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["containment"] == "invalid"
    assert body["dir_status"] == "missing"   # 不拿 sidecar 的 cwd 去探一個假答案


def test_dir_status_is_probe_four_states_only(tmp_path: Path, monkeypatch):
    """dir_status 回歸單純的 probe_dir 四態，不再混進 invalid。"""
    out = tmp_path / "backups"
    out.mkdir()
    _setup(tmp_path, monkeypatch, backup_dir=str(out))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["dir_status"] in {"dir", "missing", "not_dir", "denied"}


def test_lists_bundles_with_size_and_days(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    (out / "claude-backup-20260727-1432.tar.gz").write_bytes(b"x" * 99)
    _setup(tmp_path, monkeypatch, backup_dir=str(out))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert [b["name"] for b in body["bundles"]] == ["claude-backup-20260727-1432.tar.gz"]
    assert body["bundles"][0]["size_bytes"] == 99
    assert body["last_backup_ts"] == datetime(2026, 7, 27, 14, 32).timestamp()
    assert body["days_since"] >= 0


def test_no_bundles_yet(tmp_path: Path, monkeypatch):
    """從未備份：天數是 null 而不是 0——0 會被讀成「今天剛備份過」。"""
    out = tmp_path / "backups"
    out.mkdir()
    _setup(tmp_path, monkeypatch, backup_dir=str(out))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["bundles"] == []
    assert body["last_backup_ts"] is None
    assert body["days_since"] is None


def test_unusable_dir_does_not_report_stale_bundles(tmp_path: Path, monkeypatch):
    """目錄不可用時不能端出清單——掃目錄的整個重點是狀態要誠實。"""
    _setup(tmp_path, monkeypatch, backup_dir=str(tmp_path / "gone"))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["bundles"] == []
    assert body["days_since"] is None


def test_reports_script_missing(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    _setup(tmp_path, monkeypatch, backup_dir=str(out))
    monkeypatch.setenv("FLEDGE_BACKUP_SCRIPTS_DIR", str(tmp_path / "no-scripts"))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["script_available"] is False


def test_reports_python3_missing(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    _setup(tmp_path, monkeypatch, backup_dir=str(out))
    monkeypatch.setattr("fledge_sidecar.routes.backup.python3_available", lambda: False)
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["python3_available"] is False


def test_env_flags_reported_even_when_unconfigured(tmp_path: Path, monkeypatch):
    """環境前提與 backup_dir 無關：使用者不該在選完位置之後，才第一次得知
    這台機器根本跑不了備份。"""
    _setup(tmp_path, monkeypatch)
    monkeypatch.setattr("fledge_sidecar.routes.backup.python3_available", lambda: False)
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["configured"] is False
    assert body["python3_available"] is False


def test_reports_last_attempt_failed(tmp_path: Path, monkeypatch):
    out = tmp_path / "backups"
    out.mkdir()
    (out / "claude-backup-20260727-1432.tar.gz").write_bytes(b"x")
    (out / ".claude-backup-20260729-0900-12345-678.tar.gz.partial").write_bytes(b"x")
    _setup(tmp_path, monkeypatch, backup_dir=str(out))
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["last_attempt_failed"] is True
    assert body["days_since"] is not None   # 仍然照常回報上次成功的備份

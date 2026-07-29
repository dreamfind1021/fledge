import json
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


def test_relative_path_reported_as_invalid(tmp_path: Path, monkeypatch):
    """手動編輯設定檔塞進相對路徑時，status 要如實說它不合法，
    而不是拿 sidecar 的 cwd 去解讀出一個假的探測結果。"""
    _setup(tmp_path, monkeypatch, backup_dir="foo")
    body = TestClient(create_app()).get("/api/backup/status").json()
    assert body["dir_status"] == "invalid"


def test_status_never_errors_on_bad_config(tmp_path: Path, monkeypatch):
    """目錄問題不是錯誤：一律 200，用旗標表達。錯誤只留給請求本身壞掉。"""
    _setup(tmp_path, monkeypatch, backup_dir=str(tmp_path / "gone"))
    assert TestClient(create_app()).get("/api/backup/status").status_code == 200

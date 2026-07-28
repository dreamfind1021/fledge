import json
from pathlib import Path

from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app


def _write_config(tmp_path: Path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(
        json.dumps(
            {
                "version": 1,
                "roots": [{"path": "/root-a", "default_account": "work"}],
                "accounts": {
                    "work": {"config_dir": "~/.claude", "label": "工作"},
                    "personal": {"config_dir": "~/.claude-tc", "label": "私人"},
                },
                "manual_projects": [],
                "project_overrides": {},
                "ui": {"theme": "dark"},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg_path))
    return cfg_path


def test_get_config(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.get("/api/config")
    assert resp.status_code == 200
    assert resp.json()["roots"] == [{"path": "/root-a", "default_account": "work"}]


def test_add_and_remove_root(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    d = tmp_path / "root-b"
    d.mkdir()
    client = TestClient(create_app())
    resp = client.post("/api/config/roots", json={"path": str(d), "account": "personal"})
    assert resp.status_code == 200
    assert {"path": str(d.resolve()), "default_account": "personal"} in resp.json()["roots"]

    resp = client.request("DELETE", "/api/config/roots", json={"path": str(d)})
    assert resp.status_code == 200
    assert all(r["path"] != str(d.resolve()) for r in resp.json()["roots"])


def test_set_root_account(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.patch("/api/config/roots", json={"path": "/root-a", "account": "personal"})
    assert resp.json()["roots"][0]["default_account"] == "personal"


def test_manual_and_override(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    m = tmp_path / "m"
    m.mkdir()
    client = TestClient(create_app())
    resp = client.post("/api/config/manual", json={"path": str(m), "account": "work"})
    assert {"path": str(m.resolve()), "account": "work"} in resp.json()["manual_projects"]

    resp = client.put("/api/config/overrides", json={"path": "/p", "account": "personal"})
    assert resp.json()["project_overrides"]["/p"] == {"account": "personal"}

    resp = client.request("DELETE", "/api/config/overrides", json={"path": "/p"})
    assert "/p" not in resp.json()["project_overrides"]


def test_unknown_account_rejected(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    d = tmp_path / "x"
    d.mkdir()
    client = TestClient(create_app())
    resp = client.post("/api/config/roots", json={"path": str(d), "account": "nope"})
    assert resp.status_code == 400


def test_duplicate_root_rejected(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    d = tmp_path / "dup"
    d.mkdir()
    client = TestClient(create_app())
    assert client.post("/api/config/roots", json={"path": str(d), "account": "work"}).status_code == 200
    resp = client.post("/api/config/roots", json={"path": str(d), "account": "work"})
    assert resp.status_code == 400


def test_duplicate_manual_rejected(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    m = tmp_path / "m"
    m.mkdir()
    client = TestClient(create_app())
    assert client.post("/api/config/manual", json={"path": str(m), "account": "work"}).status_code == 200
    resp = client.post("/api/config/manual", json={"path": str(m), "account": "work"})
    assert resp.status_code == 400


def test_writes_persist_to_disk(tmp_path: Path, monkeypatch):
    cfg_path = _write_config(tmp_path, monkeypatch)
    d = tmp_path / "root-b"
    d.mkdir()
    client = TestClient(create_app())
    client.post("/api/config/roots", json={"path": str(d), "account": "work"})
    on_disk = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert any(r["path"] == str(d.resolve()) for r in on_disk["roots"])


def test_get_config_first_run_true_when_no_file(tmp_path: Path, monkeypatch):
    # 指向不存在的設定檔 → is_first_run True、roots 空（in-memory DEFAULT）
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "nope.json"))
    client = TestClient(create_app())
    resp = client.get("/api/config")
    assert resp.status_code == 200
    assert resp.json()["is_first_run"] is True


def test_get_config_first_run_false_when_file_exists(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    assert client.get("/api/config").json()["is_first_run"] is False


def test_onboard_writes_multiple_roots(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    r1 = tmp_path / "r1"; r1.mkdir()
    r2 = tmp_path / "r2"; r2.mkdir()
    client = TestClient(create_app())
    resp = client.post("/api/config/onboard", json={"roots": [
        {"path": str(r1), "default_account": "default"},
        {"path": str(r2), "default_account": "default"},
    ]})
    assert resp.status_code == 200
    assert [r["path"] for r in resp.json()["roots"]] == [str(r1.resolve()), str(r2.resolve())]
    assert resp.json()["is_first_run"] is False  # 寫入後不再是首次


def test_onboard_dedup_same_batch(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    dup = tmp_path / "dup"; dup.mkdir()
    client = TestClient(create_app())
    resp = client.post("/api/config/onboard", json={"roots": [
        {"path": str(dup), "default_account": "default"},
        {"path": str(dup), "default_account": "default"},
    ]})
    assert [r["path"] for r in resp.json()["roots"]] == [str(dup.resolve())]  # 同批重複只留第一個


def test_onboard_empty_rejected(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    assert client.post("/api/config/onboard", json={"roots": []}).status_code == 400


def test_onboard_unknown_account_rejected_atomically(tmp_path: Path, monkeypatch):
    cfg = tmp_path / "config.json"
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    client = TestClient(create_app())
    resp = client.post("/api/config/onboard", json={"roots": [
        {"path": "/r1", "default_account": "work"},
        {"path": "/r2", "default_account": "nope"},
    ]})
    assert resp.status_code == 400
    assert not cfg.exists()  # 整批不寫：save 前就 raise，檔案不被建立


def test_onboard_rejects_when_config_exists(tmp_path: Path, monkeypatch):
    # first-run guard：設定檔已存在時 onboard 回 409，不覆蓋既有 config（Codex F-1）
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.post("/api/config/onboard", json={"roots": [
        {"path": "/r1", "default_account": "work"},
    ]})
    assert resp.status_code == 409


def test_add_account(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.post("/api/config/accounts", json={"key": "team", "config_dir": "~/.claude-team", "label": "團隊"})
    assert resp.status_code == 200
    assert resp.json()["accounts"]["team"] == {"config_dir": "~/.claude-team", "label": "團隊"}


def test_add_account_duplicate_or_bad_key(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    assert client.post("/api/config/accounts", json={"key": "work", "config_dir": "~/.x", "label": ""}).status_code == 400
    assert client.post("/api/config/accounts", json={"key": "a b", "config_dir": "~/.x", "label": ""}).status_code == 400
    assert client.post("/api/config/accounts", json={"key": "a/b", "config_dir": "~/.x", "label": ""}).status_code == 400
    assert client.post("/api/config/accounts", json={"key": "", "config_dir": "~/.x", "label": ""}).status_code == 400


def test_patch_account(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.patch("/api/config/accounts/work", json={"config_dir": "~/.claude-x", "label": "上班"})
    assert resp.status_code == 200
    assert resp.json()["accounts"]["work"] == {"config_dir": "~/.claude-x", "label": "上班"}
    assert client.patch("/api/config/accounts/nope", json={"label": "x"}).status_code == 404


def test_delete_account_cascade_reassign(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    rp = tmp_path / "root-p"; rp.mkdir()
    client = TestClient(create_app())
    client.post("/api/config/roots", json={"path": str(rp), "account": "personal"})
    resp = client.request("DELETE", "/api/config/accounts/personal", json={"reassign_to": "work"})
    assert resp.status_code == 200
    body = resp.json()
    assert "personal" not in body["accounts"]
    assert all(r["default_account"] == "work" for r in body["roots"])


def test_delete_account_needs_reassign_when_referenced(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.request("DELETE", "/api/config/accounts/work", json={})
    assert resp.status_code == 400


def test_delete_account_last_one_rejected(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    client.request("DELETE", "/api/config/accounts/personal", json={"reassign_to": "work"})
    resp = client.request("DELETE", "/api/config/accounts/work", json={})
    assert resp.status_code == 400


def test_delete_account_cascade_manual_and_overrides(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    m = tmp_path / "m"; m.mkdir()
    client = TestClient(create_app())
    client.post("/api/config/manual", json={"path": str(m), "account": "personal"})
    client.put("/api/config/overrides", json={"path": "/p", "account": "personal"})
    resp = client.request("DELETE", "/api/config/accounts/personal", json={"reassign_to": "work"})
    assert resp.status_code == 200
    body = resp.json()
    assert all(m["account"] == "work" for m in body["manual_projects"])
    assert all(o["account"] == "work" for o in body["project_overrides"].values())


def test_delete_account_invalid_reassign_rejected(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.request("DELETE", "/api/config/accounts/personal", json={"reassign_to": "nope"})
    assert resp.status_code == 400


def test_delete_account_reassign_to_self_rejected(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.request("DELETE", "/api/config/accounts/personal", json={"reassign_to": "personal"})
    assert resp.status_code == 400


def test_add_root_rejects_missing(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.post("/api/config/roots", json={"path": str(tmp_path / "nope"), "account": "work"})
    assert resp.status_code == 400


def test_add_root_rejects_file(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    f = tmp_path / "f.txt"
    f.write_text("x")
    client = TestClient(create_app())
    resp = client.post("/api/config/roots", json={"path": str(f), "account": "work"})
    assert resp.status_code == 400


def test_add_root_rejects_relative(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.post("/api/config/roots", json={"path": "relative/x", "account": "work"})
    assert resp.status_code == 400


def test_add_root_canonicalizes_symlink(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    client = TestClient(create_app())
    resp = client.post("/api/config/roots", json={"path": str(link), "account": "work"})
    assert resp.status_code == 200
    assert any(r["path"] == str(real.resolve()) for r in resp.json()["roots"])


def test_add_root_allows_denied(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    from fledge_sidecar.routes import config as config_route
    monkeypatch.setattr(config_route, "probe_dir", lambda _p: "denied")
    d = tmp_path / "secret"
    d.mkdir()
    client = TestClient(create_app())
    resp = client.post("/api/config/roots", json={"path": str(d), "account": "work"})
    assert resp.status_code == 200
    assert any(r["path"] == str(d.resolve()) for r in resp.json()["roots"])  # 不只 200，要確實寫入


def test_remove_nonexistent_path_ok(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.request("DELETE", "/api/config/roots", json={"path": str(tmp_path / "long-gone")})
    assert resp.status_code == 200


def test_put_kms_root(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    resp = client.put("/api/config/kms-root", json={"path": "~/vault"})
    assert resp.status_code == 200
    assert resp.json()["kms_root"] == "~/vault"  # raw（含 ~）原樣存，不展開


def test_put_kms_root_clears(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    client.put("/api/config/kms-root", json={"path": "~/vault"})
    resp = client.put("/api/config/kms-root", json={"path": ""})
    assert resp.status_code == 200
    assert resp.json()["kms_root"] == ""  # 空字串清除


def test_check_dir_status(tmp_path: Path, monkeypatch):
    _write_config(tmp_path, monkeypatch)
    client = TestClient(create_app())
    f = tmp_path / "f.txt"
    f.write_text("x")
    assert client.post("/api/config/check-dir", json={"path": str(tmp_path)}).json()["status"] == "dir"
    assert client.post("/api/config/check-dir", json={"path": str(tmp_path / "nope")}).json()["status"] == "missing"
    assert client.post("/api/config/check-dir", json={"path": str(f)}).json()["status"] == "not_dir"

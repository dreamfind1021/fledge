import json
from pathlib import Path

from fastapi.testclient import TestClient

import fledge_sidecar.routes.setup as setup_mod
from fledge_sidecar.app import create_app
from fledge_sidecar.setup.env_detect import ToolStatus


def test_status_returns_tools(monkeypatch):
    fake = [
        ToolStatus("node", "Node.js", "core", True, "/opt/homebrew/bin/node", "v25.8.2"),
        ToolStatus("git", "Git", "core", False, None, None),
    ]
    monkeypatch.setattr(setup_mod, "detect_all", lambda: fake)
    body = TestClient(create_app()).get("/api/setup/status").json()
    assert [t["id"] for t in body["tools"]] == ["node", "git"]
    node = body["tools"][0]
    assert node["installed"] is True and node["version"] == "v25.8.2"
    assert body["tools"][1]["installed"] is False and body["tools"][1]["path"] is None


def _config_with_accounts(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    src = tmp_path / "claude"
    src.mkdir()
    tgt = tmp_path / "claude-tc"
    tgt.mkdir()
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({
            "version": 1,
            "roots": [],
            "accounts": {
                "work": {"config_dir": str(src), "label": "工作"},
                "personal": {"config_dir": str(tgt), "label": "私人"},
            },
            "manual_projects": [],
            "project_overrides": {},
            "ui": {},
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    return src, tgt


def test_common_config_plan_previews_without_mutating(tmp_path: Path, monkeypatch):
    src, tgt = _config_with_accounts(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    body = TestClient(create_app()).post(
        "/api/setup/common-config/plan",
        json={"source": "work", "targets": ["personal"], "entries": ["commands"]},
    ).json()
    assert body["source_dir"] == str(src.resolve())
    op = body["operations"][0]
    assert op["entry"] == "commands" and op["state"] == "missing"
    assert op["action"] == "create_link" and op["needs_overwrite"] is False
    assert not (tgt / "commands").exists()      # 預覽不動 FS


def test_common_config_apply_creates_link(tmp_path: Path, monkeypatch):
    src, tgt = _config_with_accounts(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    body = TestClient(create_app()).post(
        "/api/setup/common-config/apply",
        json={"source": "work", "targets": ["personal"], "entries": ["commands"]},
    ).json()
    assert body["results"][0]["outcome"] == "created"
    assert (tgt / "commands").is_symlink()


def test_common_config_apply_honours_overwrite_gate(tmp_path: Path, monkeypatch):
    src, tgt = _config_with_accounts(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    (tgt / "commands").mkdir()
    (tgt / "commands" / "mine.md").write_text("MINE", encoding="utf-8")
    client = TestClient(create_app())
    payload = {"source": "work", "targets": ["personal"], "entries": ["commands"]}
    body = client.post("/api/setup/common-config/apply", json=payload).json()
    assert body["results"][0]["outcome"] == "conflict"    # 未授權＝不動
    body = client.post(
        "/api/setup/common-config/apply",
        json={**payload, "overwrite": [{"account": "personal", "entry": "commands"}]},
    ).json()
    assert body["results"][0]["outcome"] == "created"
    assert body["results"][0]["backup_path"]


def test_common_config_rejects_bad_input(tmp_path: Path, monkeypatch):
    _config_with_accounts(tmp_path, monkeypatch)
    client = TestClient(create_app())
    r = client.post(
        "/api/setup/common-config/plan",
        json={"source": "ghost", "targets": ["personal"], "entries": ["commands"]},
    )
    assert r.status_code == 400 and r.json()["error"] == "unknown_account"
    r = client.post(
        "/api/setup/common-config/plan",
        json={"source": "work", "targets": ["work"], "entries": ["commands"]},
    )
    assert r.status_code == 400 and r.json()["error"] == "source_in_targets"
    r = client.post(
        "/api/setup/common-config/plan",
        json={"source": "work", "targets": ["personal"], "entries": ["../evil"]},
    )
    assert r.status_code == 400 and r.json()["error"] == "unknown_entry"
    # 未知欄位 fail-closed（沿用 sessions 的 extra="forbid"）
    r = client.post(
        "/api/setup/common-config/plan",
        json={"source": "work", "targets": ["personal"], "entries": ["commands"], "cmd": "rm -rf"},
    )
    assert r.status_code == 422
    # ADR-0002：client 不得夾帶 plan 物件——server 一律以相同輸入重算
    r = client.post(
        "/api/setup/common-config/plan",
        json={"source": "work", "targets": ["personal"], "entries": ["commands"],
              "plan": {"operations": []}},
    )
    assert r.status_code == 422


def test_common_config_returns_code_when_config_file_is_corrupt(tmp_path: Path, monkeypatch):
    # AppConfig.load() 走 json.loads，JSONDecodeError 是 ValueError 子類——若與模組的
    # 判別碼共用一個 except，剖析訊息會被當成 error code 吐給前端（§4.6.13）。
    # 設定檔壞掉是伺服端狀況，不是 client 輸入錯誤。
    cfg = tmp_path / "config.json"
    cfg.write_text("{oops not json", encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    client = TestClient(create_app(), raise_server_exceptions=False)
    r = client.post(
        "/api/setup/common-config/plan",
        json={"source": "work", "targets": ["personal"], "entries": ["commands"]},
    )
    assert r.status_code == 500
    assert r.json()["error"] == "config_unreadable"


def test_common_config_plan_returns_code_when_probe_hits_unreadable_dir(tmp_path: Path, monkeypatch):
    # probe_entry 的 os.listdir 會拋 OSError（目錄不可讀、競態中消失）。無人接就是
    # 裸 500，違反「錯誤一律回英文判別碼」。
    src, tgt = _config_with_accounts(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    blocked = tgt / "commands"
    blocked.mkdir()
    blocked.chmod(0o000)
    try:
        client = TestClient(create_app(), raise_server_exceptions=False)
        r = client.post(
            "/api/setup/common-config/plan",
            json={"source": "work", "targets": ["personal"], "entries": ["commands"]},
        )
        assert r.status_code == 500
        assert r.json()["error"] == "probe_failed"
    finally:
        blocked.chmod(0o700)          # 還原否則 tmp_path 清不掉


def test_common_config_apply_authorizes_per_account_not_per_entry(tmp_path: Path, monkeypatch):
    # route 把 overwrite 轉成 (account, entry) pair 的接線必須忠實：授權 a 帳號的
    # commands 不得連帶炸掉 b 帳號的（模組層的同名測試只保護模組契約，不保護此映射）。
    src = tmp_path / "claude"
    src.mkdir()
    (src / "commands").mkdir()
    accounts = {"work": {"config_dir": str(src), "label": "工作"}}
    dirs = {}
    for key in ("a", "b"):
        d = tmp_path / f"claude-{key}"
        (d / "commands").mkdir(parents=True)
        (d / "commands" / "mine.md").write_text(key, encoding="utf-8")
        accounts[key] = {"config_dir": str(d), "label": key}
        dirs[key] = d
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "roots": [], "accounts": accounts,
                               "manual_projects": [], "project_overrides": {}, "ui": {}}),
                   encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    r = TestClient(create_app()).post(
        "/api/setup/common-config/apply",
        json={"source": "work", "targets": ["a", "b"], "entries": ["commands"],
              "overwrite": [{"account": "a", "entry": "commands"}]},
    )
    assert r.status_code == 200
    by_account = {x["account"]: x["outcome"] for x in r.json()["results"]}
    assert by_account == {"a": "created", "b": "conflict"}
    assert (dirs["b"] / "commands" / "mine.md").read_text(encoding="utf-8") == "b"


def test_common_config_apply_serialises_concurrent_calls(tmp_path: Path, monkeypatch):
    # _setup_lock：apply 會動 FS，並發進來若不序列化，兩個請求會在同一路徑上互踩
    # （實測無鎖時直接噴 500）。序列化後應是「一個 created、其餘看到已完成→skipped」。
    from concurrent.futures import ThreadPoolExecutor

    src, _tgt = _config_with_accounts(tmp_path, monkeypatch)
    (src / "commands").mkdir()
    client = TestClient(create_app())
    payload = {"source": "work", "targets": ["personal"], "entries": ["commands"]}

    def _post():
        return client.post("/api/setup/common-config/apply", json=payload)

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = [f.result() for f in [pool.submit(_post) for _ in range(8)]]
    assert {r.status_code for r in responses} == {200}
    outcomes = [r.json()["results"][0]["outcome"] for r in responses]
    assert outcomes.count("created") == 1
    assert set(outcomes) == {"created", "skipped"}

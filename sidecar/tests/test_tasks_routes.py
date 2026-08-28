"""待辦面板路由（design §7）。

本檔第一條是**接線測試**（design §9.1）：`routes/tasks.py` 的單測會直接 import router
來測，不會經過 `app.py` 的註冊點——漏掉 `include_router` 時那些單測仍會全綠、而
`/tasks` 全部 404。這條對「組好的 app」打，補上那個缺口。
"""
import json

from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app


def _client(tmp_path, monkeypatch, *, roots=None):
    """指向臨時 config，讓 scan_all 只看得到測試造的專案（不讀使用者真實設定）。"""
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({"version": 1, "accounts": {}, "roots": roots or [], "kms_root": ""}),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    return TestClient(create_app())


def test_router_registered_on_composed_app(tmp_path, monkeypatch):
    """對【組好的 app】打 /tasks/overview，斷言 200 ＋ 最小回應 shape。

    ⚠ 不可改寫成「斷言不是 404」：`app.py` 的 TokenAuthMiddleware 在路由分派【之前】
    就對未帶有效 token 的請求回 401，所以漏掉 `include_router` 時「非 404」也會通過
    ——那正是這條測試要防的漏接線風險本身（design §9.1 的假綠警告）。
    """
    c = _client(tmp_path, monkeypatch)
    r = c.get("/tasks/overview")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body.get("projects"), list)


def test_overview_requires_token_when_auth_enforced(tmp_path, monkeypatch):
    """認證拒絕【另立一條】，不與上面那條混在一起（design §9.1）。"""
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({"version": 1, "accounts": {}, "roots": [], "kms_root": ""}),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    c = TestClient(create_app())
    assert c.get("/tasks/overview").status_code == 401


def _project_root(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    return root


def test_overview_lists_every_known_project_with_counts(tmp_path, monkeypatch):
    """所有已知專案各一列，沒有待辦的顯示 0——不隱藏（design §5.1）。"""
    root = _project_root(tmp_path)
    has = root / "has-tasks"
    (has / ".fledge" / "tasks").mkdir(parents=True)
    (has / ".fledge" / "tasks" / "01-a.md").write_text(
        "---\nstatus: todo\n---\n\n# a\n", encoding="utf-8"
    )
    (root / "no-fledge").mkdir()

    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    rows = {r["name"]: r for r in c.get("/tasks/overview").json()["projects"]}
    assert rows["has-tasks"]["unfinished"] == 1
    assert rows["has-tasks"]["tasks_status"] == "ok"
    assert rows["no-fledge"]["unfinished"] == 0
    assert rows["no-fledge"]["tasks_status"] == "absent"


def test_overview_reports_unavailable_not_zero(tmp_path, monkeypatch):
    """讀不到的專案回 `unavailable` ＋ `unfinished: null`，**不是 0**（design §6.3）。

    回 0 的話使用者無法分辨「真的沒有待辦」與「整份待辦讀不到」，會誤判清單已清空。
    `unfinished` 用 null 而非 0，讓前端在結構上不可能把它畫成 0。"""
    import os

    import pytest

    if os.geteuid() == 0:
        pytest.skip("root 無視目錄權限")
    root = _project_root(tmp_path)
    blocked = root / "blocked"
    tasks = blocked / ".fledge" / "tasks"
    tasks.mkdir(parents=True)
    os.chmod(tasks, 0o000)
    try:
        c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
        row = next(r for r in c.get("/tasks/overview").json()["projects"] if r["name"] == "blocked")
        assert row["tasks_status"] == "unavailable"
        assert row["unfinished"] is None
        assert row["unfinished"] != 0
    finally:
        os.chmod(tasks, 0o755)

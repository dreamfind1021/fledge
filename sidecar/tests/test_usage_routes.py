import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app
from fledge_sidecar.routes import usage as usage_route


def _env(tmp_path: Path, monkeypatch):
    claude_dir = tmp_path / "claude" / "projects" / "-p-a"
    claude_dir.mkdir(parents=True)
    (claude_dir / "s.jsonl").write_text(json.dumps({
        "type": "assistant", "timestamp": "2026-06-12T01:00:00Z", "cwd": "/p/a",
        "sessionId": "s", "requestId": "r",
        "message": {"id": "m", "model": "claude-opus-4-8",
                    "usage": {"input_tokens": 1000, "output_tokens": 100}}}), encoding="utf-8")
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({
        "version": 1, "roots": [], "manual_projects": [], "project_overrides": {},
        "ui": {}, "subscriptions": [{"name": "Claude", "monthly_cost": 100.0}],
        "accounts": {"work": {"config_dir": str(tmp_path / "claude"), "label": "工作"}},
    }), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.setenv("FLEDGE_CODEX_HOME", str(tmp_path / "codex"))     # 不存在 → 空源
    monkeypatch.setenv("FLEDGE_USAGE_CACHE", str(tmp_path / "usage-v1.json"))
    usage_route.reset_state_for_tests()


def _poll_ok(client, tries=50):
    for _ in range(tries):
        resp = client.get("/usage/dashboard")
        if resp.status_code == 200 and resp.json()["scan_meta"]["state"] == "ok":
            return resp.json()
        time.sleep(0.05)
    raise AssertionError("scan 未在時限內完成")


# 注意：必須用 `with TestClient(...) as client`——背景 asyncio.create_task 需要
# 跨請求存活的 event loop（context manager 形式才會維持單一 portal）。
def test_dashboard_cold_202_then_ok(tmp_path: Path, monkeypatch):
    _env(tmp_path, monkeypatch)
    with TestClient(create_app()) as client:
        first = client.get("/usage/dashboard")
        assert first.status_code in (200, 202)    # 冷掃可能極快完成
        data = _poll_ok(client)
        assert data["kpi"]["subscriptions_total"] == 100.0
        assert data["scan_meta"]["sources"]["claude"] == "ok"
        assert data["scan_meta"]["sources"]["codex"] == "missing"
        assert data["scan_meta"]["generation"] >= 1
        assert isinstance(data["scan_meta"]["cold_scan_ms"], int)   # Task 16 驗收佐證欄位
        assert data["scan_meta"]["days"] == 30
        # days 切換 contract：已有 snapshot → 立即 200（可能仍是 days=30 的 last-good），
        # 下一輪掃描收斂為 days=7（以 scan_meta.days 為準）
        assert client.get("/usage/dashboard?days=7").status_code == 200
        for _ in range(50):
            j = client.get("/usage/dashboard?days=7").json()
            if j["scan_meta"].get("days") == 7 and j["scan_meta"]["state"] == "ok":
                break
            time.sleep(0.05)
        else:
            raise AssertionError("days=7 未在時限內收斂")


def test_dashboard_returns_last_good_while_rescanning(tmp_path: Path, monkeypatch):
    _env(tmp_path, monkeypatch)
    with TestClient(create_app()) as client:
        _poll_ok(client)
        resp = client.get("/usage/dashboard")      # 已有 snapshot → 永遠 200
        assert resp.status_code == 200


def test_put_subscriptions_validates(tmp_path: Path, monkeypatch):
    _env(tmp_path, monkeypatch)
    with TestClient(create_app()) as client:
        ok = client.put("/api/config/subscriptions",
                        json={"subscriptions": [{"name": "Codex", "monthly_cost": 20.0}]})
        assert ok.status_code == 200
        assert ok.json()["subscriptions"] == [{"name": "Codex", "monthly_cost": 20.0}]
        bad = client.put("/api/config/subscriptions",
                         json={"subscriptions": [{"name": "", "monthly_cost": -1}]})
        assert bad.status_code == 400


def test_steady_state_second_poll_reports_ok(tmp_path: Path, monkeypatch):
    # 穩態：snapshot 存在、本請求自己觸發的 rescan 不得標 scanning（design §10）
    _env(tmp_path, monkeypatch)
    with TestClient(create_app()) as client:
        _poll_ok(client)
        usage_route._state["scanned_at"] = 0.0      # 強制 stale → 下一請求觸發 rescan
        resp = client.get("/usage/dashboard")
        assert resp.status_code == 200
        assert resp.json()["scan_meta"]["state"] == "ok"   # 抵達當下無 in-flight → ok


def test_error_keeps_snapshot_and_reports_state(tmp_path: Path, monkeypatch):
    _env(tmp_path, monkeypatch)
    with TestClient(create_app()) as client:
        _poll_ok(client)
        monkeypatch.setattr(usage_route, "_scan_sync", lambda days: (_ for _ in ()).throw(RuntimeError("boom")))
        usage_route._state["scanned_at"] = 0.0
        client.get("/usage/dashboard")              # 觸發失敗掃描
        for _ in range(50):
            j = client.get("/usage/dashboard").json()
            if j["scan_meta"]["state"] == "error":
                break
            time.sleep(0.05)
        else:
            raise AssertionError("error state 未出現")
        assert j["kpi"]["subscriptions_total"] == 100.0    # snapshot 保留（200＋舊資料）
        assert "boom" in j["scan_meta"]["error"]


def test_cold_error_shape_has_missing_pricing(tmp_path: Path, monkeypatch):
    _env(tmp_path, monkeypatch)
    monkeypatch.setattr(usage_route, "_scan_sync", lambda days: (_ for _ in ()).throw(RuntimeError("cold boom")))
    with TestClient(create_app()) as client:
        for _ in range(50):
            resp = client.get("/usage/dashboard")
            if resp.status_code == 200 and resp.json()["scan_meta"]["state"] == "error":
                break
            time.sleep(0.05)
        else:
            raise AssertionError("cold error 未出現")
        j = resp.json()
        assert j["scan_meta"]["missing_pricing"] == []     # error-only 形狀必含空欄（防前端炸）

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
    monkeypatch.setenv("FLEDGE_CODEX_ACCOUNT_USAGE", str(tmp_path / "codex-account-usage.json"))
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


def _yesterday() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))


def _write_history(tmp_path: Path, days: dict) -> None:
    (tmp_path / "codex-account-usage.json").write_text(json.dumps({
        "version": 1, "accounts": {"acc-1": days}, "default_model": "gpt-6.1-sol", "fetches": []}), encoding="utf-8")


def test_dashboard_carries_codex_unattributed(tmp_path: Path, monkeypatch):
    """歷史檔有資料 → payload 帶 codex_unattributed；估價模型先看 config.toml，沒有才用歷史檔存的預設模型（spec 5.3-5）。"""
    _env(tmp_path, monkeypatch)
    day = _yesterday()
    _write_history(tmp_path, {day: 1000})
    with TestClient(create_app()) as client:
        ua = _poll_ok(client)["codex_unattributed"]
    assert ua == {"tokens": 1000, "account_tokens": 1000, "share": 1.0, "days": 1, "start_date": day,
                  "end_date": day, "price_model": "gpt-6.1-sol", "cost": None}
    (tmp_path / "codex").mkdir()
    (tmp_path / "codex" / "config.toml").write_text('model = "gpt-6-astra"\n', encoding="utf-8")
    usage_route.reset_state_for_tests()
    with TestClient(create_app()) as client:
        assert _poll_ok(client)["codex_unattributed"]["price_model"] == "gpt-6-astra"


def test_dashboard_codex_unattributed_is_null_without_history(tmp_path: Path, monkeypatch):
    _env(tmp_path, monkeypatch)
    with TestClient(create_app()) as client:
        data = _poll_ok(client)
    assert "codex_unattributed" in data and data["codex_unattributed"] is None


def test_dashboard_picks_up_history_written_while_running(tmp_path: Path, monkeypatch):
    """背景第一次抓完（啟動後約 1 分鐘）歷史檔才出現：下一輪掃描就讀到，不必重開儀表板或重啟 sidecar。"""
    _env(tmp_path, monkeypatch)
    with TestClient(create_app()) as client:
        assert _poll_ok(client)["codex_unattributed"] is None
        _write_history(tmp_path, {_yesterday(): 1000})
        usage_route._state["scanned_at"] = 0.0      # 強制 stale → 下一請求觸發 rescan（平常是 25 秒後）
        client.get("/usage/dashboard")
        for _ in range(50):
            ua = client.get("/usage/dashboard").json().get("codex_unattributed")
            if ua is not None:
                break
            time.sleep(0.05)
    assert ua is not None and ua["account_tokens"] == 1000


def test_dashboard_survives_a_corrupt_history_file(tmp_path: Path, monkeypatch):
    """歷史檔壞掉時儀表板照常（這一塊是 null）；讀取端不動壞檔，留給下一次背景寫入改名保留。"""
    _env(tmp_path, monkeypatch)
    (tmp_path / "codex-account-usage.json").write_bytes(b"{not json")
    with TestClient(create_app()) as client:
        data = _poll_ok(client)
    assert data["codex_unattributed"] is None and data["kpi"]["subscriptions_total"] == 100.0
    assert (tmp_path / "codex-account-usage.json").read_bytes() == b"{not json"


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


def test_put_subscriptions_keeps_its_two_distinct_400_messages(tmp_path: Path, monkeypatch):
    """**回歸保護**（票 09）：判準抽成共用 helper 之後，這支的對外行為要一字不變。

    兩句 400 是分開的——「轉不出數字」與「值不合法」是使用者要採取不同動作的兩件事。
    helper 若把失敗原因合併成一種，這條會紅。非物件的 item 仍由 Pydantic 的
    `list[dict]` 註記擋成 422（不是 400），那一層也不能因為 helper 接手就拿掉。"""
    _env(tmp_path, monkeypatch)
    with TestClient(create_app()) as client:
        cost = client.put("/api/config/subscriptions",
                          json={"subscriptions": [{"name": "Codex", "monthly_cost": "abc"}]})
        assert (cost.status_code, cost.json()["detail"]) == (400, "monthly_cost 須為數字")
        values = client.put("/api/config/subscriptions",
                            json={"subscriptions": [{"name": "", "monthly_cost": 1}]})
        assert (values.status_code, values.json()["detail"]) == \
            (400, "name 不可為空、monthly_cost 不可為負或非有限值")
        shape = client.put("/api/config/subscriptions",
                           json={"subscriptions": ["Codex"]})
        assert shape.status_code == 422


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


def _codex_stub(calls):
    def stub(codex_home, now, **kw):
        calls["n"] += 1
        return {"source": "live", "observed_at": now, "plan_type": "plus",
                "primary": {"used_percent": float(calls["n"]), "window_minutes": 300, "resets_at": 1.0}}
    return stub


def test_codex_usage_coalesces_within_floor(tmp_path: Path, monkeypatch):
    # 60s floor 內第二次請求沿用快取、不再打 upstream（防多視窗/重掛狂打未公開端點）
    _env(tmp_path, monkeypatch)
    calls = {"n": 0}
    monkeypatch.setattr(usage_route, "fetch_codex_usage", _codex_stub(calls))
    with TestClient(create_app()) as client:
        r1 = client.get("/usage/codex")
        assert r1.status_code == 200 and r1.json()["source"] == "live"
        first = r1.json()["primary"]["used_percent"]
        r2 = client.get("/usage/codex")
        assert r2.json()["primary"]["used_percent"] == first
        assert calls["n"] == 1      # 只真打一次


def test_codex_usage_refetches_after_floor(tmp_path: Path, monkeypatch):
    _env(tmp_path, monkeypatch)
    calls = {"n": 0}
    monkeypatch.setattr(usage_route, "fetch_codex_usage", _codex_stub(calls))
    with TestClient(create_app()) as client:
        client.get("/usage/codex")
        usage_route._codex_state["fetched_at"] = 0.0    # 強制過期 → force-on-open 重抓
        client.get("/usage/codex")
        assert calls["n"] == 2


def test_codex_usage_failure_has_short_ttl(tmp_path: Path, monkeypatch):
    # 失敗結果只快取極短時間——使用者登入 codex 後能很快恢復（Codex 審查 finding #2）
    _env(tmp_path, monkeypatch)
    calls = {"n": 0}
    def stub(codex_home, now, **kw):
        calls["n"] += 1
        return {"source": "unavailable", "failure_reason": "no_auth", "observed_at": None}
    monkeypatch.setattr(usage_route, "fetch_codex_usage", stub)
    with TestClient(create_app()) as client:
        client.get("/usage/codex")
        usage_route._codex_state["fetched_at"] = time.time() - (usage_route.CODEX_USAGE_FAIL_INTERVAL_SEC + 1)
        client.get("/usage/codex")
        assert calls["n"] == 2      # 失敗 TTL 已過 → 重抓


def test_codex_usage_live_holds_full_floor(tmp_path: Path, monkeypatch):
    # live 結果在「失敗 TTL 之後、成功 floor 之內」不得重抓（floor 依 source 區分）
    _env(tmp_path, monkeypatch)
    calls = {"n": 0}
    monkeypatch.setattr(usage_route, "fetch_codex_usage", _codex_stub(calls))
    with TestClient(create_app()) as client:
        client.get("/usage/codex")
        usage_route._codex_state["fetched_at"] = time.time() - (usage_route.CODEX_USAGE_FAIL_INTERVAL_SEC + 1)
        client.get("/usage/codex")
        assert calls["n"] == 1      # 仍在成功 floor 內


def test_codex_usage_passes_through_unavailable(tmp_path: Path, monkeypatch):
    _env(tmp_path, monkeypatch)
    monkeypatch.setattr(usage_route, "fetch_codex_usage",
                        lambda codex_home, now, **kw: {"source": "unavailable",
                                                       "failure_reason": "no_auth", "observed_at": None})
    with TestClient(create_app()) as client:
        r = client.get("/usage/codex")
        assert r.json() == {"source": "unavailable", "failure_reason": "no_auth", "observed_at": None}


def test_put_subscriptions_rejects_a_huge_cost_instead_of_crashing(
        tmp_path: Path, monkeypatch):
    """309 位以上的整數讓 `float()` 拋 `OverflowError`——原本只接 `TypeError/ValueError`，
    於是這支會裸 500（**既有 bug，不是本票引入**）。

    判準抽成共用 helper 時一併把它正規化成 `bad_cost`。**500 → 400 不算改對外行為**：
    裸例外是未定義行為不是合約，而移機那一側必須 200，同一份判準不能一邊修一邊不修。"""
    _env(tmp_path, monkeypatch)
    huge = json.loads('{"c": ' + "9" * 400 + "}")["c"]
    with TestClient(create_app()) as client:
        resp = client.put("/api/config/subscriptions",
                          json={"subscriptions": [{"name": "Codex", "monthly_cost": huge}]})
        assert (resp.status_code, resp.json()["detail"]) == (400, "monthly_cost 須為數字")

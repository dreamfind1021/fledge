from datetime import datetime, timezone

from fledge_sidecar.usage.aggregator import build_dashboard
from fledge_sidecar.usage.parser import UsageEntry

NOW = datetime(2026, 6, 12, 10, 0, tzinfo=timezone.utc).timestamp()


def _e(ts=NOW - 60, source="claude", model="claude-opus-4-8", cost=1.0,
       project="/p/a", dedup="m:r", sidechain=False, missing=False, **tok):
    tokens = {"input_tokens": 100, "output_tokens": 10, "cache_read_tokens": 0,
              "cache_create_5m": 0, "cache_create_1h": 0} | tok
    return UsageEntry(ts=ts, source=source, model=model, cost=cost, project=project,
                      session_id="s", dedup_key=dedup, sidechain=sidechain,
                      missing_pricing=missing, **tokens)


def test_claude_dedup_drops_duplicate_key():
    d = build_dashboard([_e(dedup="m:r"), _e(dedup="m:r"), _e(dedup="m2:r2")],
                        codex_rate_limits=None, subscriptions=[], now=NOW)
    assert d["kpi"]["today_value"] == 2.0  # 三筆中重複一筆


def test_claude_dedup_prefers_parent_then_more_tokens():
    # 同 key：sidechain 先到、parent 後到 → 保留 parent（design §6 替換規則）
    d = build_dashboard([_e(dedup="m:r", sidechain=True, cost=1.0),
                         _e(dedup="m:r", sidechain=False, cost=2.0)],
                        codex_rate_limits=None, subscriptions=[], now=NOW)
    assert d["kpi"]["today_value"] == 2.0
    # 同 key 同為 parent：token 多者勝
    d2 = build_dashboard([_e(dedup="x:y", input_tokens=10, cost=1.0),
                          _e(dedup="x:y", input_tokens=999, cost=3.0)],
                         codex_rate_limits=None, subscriptions=[], now=NOW)
    assert d2["kpi"]["today_value"] == 3.0


def test_kpi_windows_and_net_roi():
    # 取月中時點，任何機器時區（±12h）下都仍落在六月，避免時區邊界 flaky
    month_old = datetime(2026, 6, 5, 12, 0, tzinfo=timezone.utc).timestamp()
    d = build_dashboard([_e(ts=NOW - 60, cost=2.0), _e(ts=month_old, cost=3.0, dedup="x:y")],
                        codex_rate_limits=None,
                        subscriptions=[{"name": "Claude", "monthly_cost": 4.0}], now=NOW)
    assert d["kpi"]["today_value"] == 2.0
    assert d["kpi"]["month_value"] == 5.0
    assert abs(d["kpi"]["net_roi"] - 1.0) < 1e-9   # 5 - 4
    assert d["kpi"]["subscriptions_total"] == 4.0


def test_cache_hit_rate_per_source_denominators():
    # Claude: read=80, input=20 → 分母 100；Codex: cached=50, input=100 → 分母 100（不再加 cached）
    entries = [
        _e(cache_read_tokens=80, input_tokens=20, output_tokens=0),
        _e(source="codex", model="gpt-5.5", dedup="", cache_read_tokens=50, input_tokens=100),
    ]
    d = build_dashboard(entries, codex_rate_limits=None, subscriptions=[], now=NOW)
    assert abs(d["kpi"]["cache_hit_rate"] - (80 + 50) / (100 + 100)) < 1e-9


def test_projects_models_daily_hourly_shapes():
    entries = [_e(project="/p/a", cost=1.0),
               _e(source="codex", model="gpt-5.5", dedup="", project="/p/a", cost=0.5),
               _e(project="/p/b", dedup="q:w", cost=2.0, missing=True, model="claude-x")]
    d = build_dashboard(entries, codex_rate_limits={"plan_type": "plus"},
                        subscriptions=[], now=NOW)
    pa = next(p for p in d["projects"] if p["path"] == "/p/a")
    assert pa["claude_cost"] == 1.0 and pa["codex_cost"] == 0.5 and pa["total"] == 1.5
    assert "claude-x" in d["scan_meta"]["missing_pricing"]
    assert d["blocks"]["codex"]["plan_type"] == "plus"
    assert len(d["hourly"]) == 7 and all(len(row) == 24 for row in d["hourly"])
    assert len(d["daily"]) >= 1
    assert any(m["model"] == "gpt-5.5" for m in d["models"])


def test_synthetic_not_in_missing_pricing_warning():
    # synthetic 是「排除計價」非「查無定價」，不得進使用者警示清單
    d = build_dashboard([_e(model="<synthetic>", missing=True, cost=0.0)],
                        codex_rate_limits=None, subscriptions=[], now=NOW)
    assert d["scan_meta"]["missing_pricing"] == []


def test_horizon_excludes_old_entries_from_panels_but_not_kpi():
    old = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc).timestamp()  # 月內但 >days=7
    d = build_dashboard([_e(ts=NOW - 60, cost=1.0), _e(ts=old, cost=2.0, dedup="o:k")],
                        codex_rate_limits=None, subscriptions=[], now=NOW, days=7)
    assert d["kpi"]["month_value"] == 3.0          # KPI 視窗不受 horizon 限制
    assert all(day["total"] != 2.0 for day in d["daily"]) or len(d["daily"]) == 1  # 舊條目不進 daily


def test_week_value_counts_recent_entry():
    d = build_dashboard([_e(ts=NOW - 60, cost=1.5)], codex_rate_limits=None,
                        subscriptions=[], now=NOW)
    assert d["kpi"]["week_value"] == 1.5


def test_synthetic_not_in_models_table():
    d = build_dashboard([_e(model="<synthetic>", missing=True, cost=0.0, input_tokens=999)],
                        codex_rate_limits=None, subscriptions=[], now=NOW)
    assert all(m["model"] != "<synthetic>" for m in d["models"])


def test_bad_subscription_items_skipped():
    d = build_dashboard([_e(cost=1.0)], codex_rate_limits=None,
                        subscriptions=[{"name": "X", "monthly_cost": "abc"}, {"name": "Y", "monthly_cost": 5}],
                        now=NOW)
    assert d["kpi"]["subscriptions_total"] == 5.0   # 壞項目跳過不炸

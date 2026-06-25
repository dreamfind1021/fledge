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
    # Claude: read=80, input=20 → 分母 100 → 0.8；Codex: cached=50, input=100 → 分母 100 → 0.5（不再加 cached）
    entries = [
        _e(cache_read_tokens=80, input_tokens=20, output_tokens=0),
        _e(source="codex", model="gpt-5.5", dedup="", cache_read_tokens=50, input_tokens=100),
    ]
    d = build_dashboard(entries, codex_rate_limits=None, subscriptions=[], now=NOW)
    assert abs(d["kpi"]["claude_cache_hit_rate"] - 0.8) < 1e-9
    assert abs(d["kpi"]["codex_cache_hit_rate"] - 0.5) < 1e-9


def test_cache_hit_rate_none_when_source_absent():
    # 只有 Claude 條目：Codex 分母為 0 → 回 None（前端顯示「—」而非誤導的 0%）
    d = build_dashboard([_e(cache_read_tokens=80, input_tokens=20, output_tokens=0)],
                        codex_rate_limits=None, subscriptions=[], now=NOW)
    assert abs(d["kpi"]["claude_cache_hit_rate"] - 0.8) < 1e-9
    assert d["kpi"]["codex_cache_hit_rate"] is None


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


def test_project_rollup_collapses_worktrees_and_subdirs():
    # 專案表收斂到「側欄層級專案」＝root 第一層子目錄；worktree/子目錄/深層 topics 全歸母專案
    root = "/work"
    entries = [
        _e(project="/work/fledge", cost=1.0),
        _e(project="/work/fledge/.claude/worktrees/feat-x", dedup="a:1", cost=2.0),
        _e(project="/work/fledge/sidecar", dedup="b:2", cost=0.5),
        _e(project="/work/fledge/node_modules/@xterm/xterm", dedup="c:3", cost=0.25),
        _e(source="codex", model="gpt-5.5", dedup="", project="/work/創意發想/topics/x/slides", cost=4.0),
    ]
    d = build_dashboard(entries, codex_rate_limits=None, subscriptions=[], now=NOW, roots=[root])
    by_path = {p["path"]: p for p in d["projects"]}
    assert set(by_path) == {"/work/fledge", "/work/創意發想"}
    assert by_path["/work/fledge"]["claude_cost"] == 3.75   # 1 + 2 + 0.5 + 0.25
    assert by_path["/work/創意發想"]["codex_cost"] == 4.0


def test_project_no_roots_keeps_raw_cwd():
    # 未傳 roots（或路徑在 root 外）→ 維持原 cwd 分組，不誤收斂
    d = build_dashboard([_e(project="/elsewhere/proj/sub", cost=1.0)],
                        codex_rate_limits=None, subscriptions=[], now=NOW, roots=["/work"])
    assert [p["path"] for p in d["projects"]] == ["/elsewhere/proj/sub"]


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


def test_zero_token_unpriced_entry_not_in_warning():
    # 零 token 的無模型條目（空 session 快照）沒有低估可言 → 不進警示；
    # 有 token 的查無定價模型仍要警示（真低估）
    zero = _e(model="unknown-codex", source="codex", dedup="", missing=True, cost=0.0,
              input_tokens=0, output_tokens=0, cache_read_tokens=0)
    real = _e(model="gpt-9-future", source="codex", dedup="", missing=True, cost=0.0,
              input_tokens=500)
    d = build_dashboard([zero, real], codex_rate_limits=None, subscriptions=[], now=NOW)
    assert d["scan_meta"]["missing_pricing"] == ["gpt-9-future"]


def _claude_entry(ts, key_suffix, tokens, sidechain=False):
    from fledge_sidecar.usage.parser import UsageEntry
    return UsageEntry(ts=ts, source="claude", model="claude-opus-4-8",
                      input_tokens=tokens, output_tokens=0, cache_read_tokens=0,
                      cache_create_5m=0, cache_create_1h=0, cost=0.0, project="/p",
                      session_id="s", dedup_key=f"m{key_suffix}:r{key_suffix}",
                      sidechain=sidechain, missing_pricing=False)


def test_build_dashboard_per_account_blocks():
    from fledge_sidecar.usage.aggregator import build_dashboard
    now = 1_800_000_000.0
    ts = now - 600   # 10 分鐘前，落在 active block
    by_account = {
        "work": [_claude_entry(ts, "w", 1000)],
        "personal": [_claude_entry(ts, "p", 400)],
    }
    labels = {"work": "工作", "personal": "私人"}
    out = build_dashboard([], None, [], now=now, days=30,
                          claude_entries_by_account=by_account, account_labels=labels)
    accounts = out["blocks"]["claude"]["accounts"]
    assert {a["account_key"] for a in accounts} == {"work", "personal"}
    work = next(a for a in accounts if a["account_key"] == "work")
    assert work["label"] == "工作"
    assert work["active"]["total_tokens"] == 1000   # 只反映該帳號
    # 樣本不足 → limit_p90 為 None（不足 5 個 closed block）
    assert work["limit_p90"] is None


def test_per_account_dedup_no_cross_account_cancellation():
    # 兩帳號各有一筆「相同 dedup_key」的 entry → 不可互相消去
    from fledge_sidecar.usage.aggregator import build_dashboard
    now = 1_800_000_000.0
    ts = now - 600
    same = "dup"
    by_account = {
        "work": [_claude_entry(ts, same, 1000)],
        "personal": [_claude_entry(ts, same, 700)],
    }
    out = build_dashboard([], None, [], now=now,
                          claude_entries_by_account=by_account, account_labels={})
    accounts = {a["account_key"]: a for a in out["blocks"]["claude"]["accounts"]}
    assert accounts["work"]["active"]["total_tokens"] == 1000
    assert accounts["personal"]["active"]["total_tokens"] == 700


def test_build_dashboard_fallback_keeps_legacy_shape():
    # 不帶 claude_entries_by_account → 舊 shape（既有測試相容）
    from fledge_sidecar.usage.aggregator import build_dashboard
    out = build_dashboard([], None, [], now=1_800_000_000.0)
    assert set(out["blocks"]["claude"].keys()) == {"active", "recent", "limit_p90"}


def test_build_dashboard_account_partial_flag():
    from fledge_sidecar.usage.aggregator import build_dashboard
    now = 1_800_000_000.0
    ts = now - 600
    by_account = {"work": [_claude_entry(ts, "w", 1000)],
                  "personal": [_claude_entry(ts, "p", 400)]}
    out = build_dashboard([], None, [], now=now,
                          claude_entries_by_account=by_account,
                          account_labels={"work": "工作", "personal": "私人"},
                          account_partial={"work": True})
    accts = {a["account_key"]: a for a in out["blocks"]["claude"]["accounts"]}
    assert accts["work"]["partial"] is True
    assert accts["personal"]["partial"] is False     # 預設 False


def test_build_dashboard_partial_defaults_false_when_not_given():
    from fledge_sidecar.usage.aggregator import build_dashboard
    now = 1_800_000_000.0
    by_account = {"work": [_claude_entry(now - 600, "w", 1000)]}
    out = build_dashboard([], None, [], now=now, claude_entries_by_account=by_account)
    assert out["blocks"]["claude"]["accounts"][0]["partial"] is False

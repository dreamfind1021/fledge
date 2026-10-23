from datetime import datetime, timezone

import pytest

from fledge_sidecar.usage.aggregator import build_codex_unattributed, build_dashboard
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
                        subscriptions=[], now=NOW)
    assert d["kpi"]["today_value"] == 2.0  # 三筆中重複一筆


def test_claude_dedup_prefers_parent_then_more_tokens():
    # 同 key：sidechain 先到、parent 後到 → 保留 parent（design §6 替換規則）
    d = build_dashboard([_e(dedup="m:r", sidechain=True, cost=1.0),
                         _e(dedup="m:r", sidechain=False, cost=2.0)],
                        subscriptions=[], now=NOW)
    assert d["kpi"]["today_value"] == 2.0
    # 同 key 同為 parent：token 多者勝
    d2 = build_dashboard([_e(dedup="x:y", input_tokens=10, cost=1.0),
                          _e(dedup="x:y", input_tokens=999, cost=3.0)],
                         subscriptions=[], now=NOW)
    assert d2["kpi"]["today_value"] == 3.0


def test_kpi_windows_and_net_roi():
    # 取月中時點，任何機器時區（±12h）下都仍落在六月，避免時區邊界 flaky
    month_old = datetime(2026, 6, 5, 12, 0, tzinfo=timezone.utc).timestamp()
    d = build_dashboard([_e(ts=NOW - 60, cost=2.0), _e(ts=month_old, cost=3.0, dedup="x:y")],
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
    d = build_dashboard(entries, subscriptions=[], now=NOW)
    assert abs(d["kpi"]["claude_cache_hit_rate"] - 0.8) < 1e-9
    assert abs(d["kpi"]["codex_cache_hit_rate"] - 0.5) < 1e-9


def test_cache_hit_rate_none_when_source_absent():
    # 只有 Claude 條目：Codex 分母為 0 → 回 None（前端顯示「—」而非誤導的 0%）
    d = build_dashboard([_e(cache_read_tokens=80, input_tokens=20, output_tokens=0)],
                        subscriptions=[], now=NOW)
    assert abs(d["kpi"]["claude_cache_hit_rate"] - 0.8) < 1e-9
    assert d["kpi"]["codex_cache_hit_rate"] is None


def test_projects_models_daily_hourly_shapes():
    entries = [_e(project="/p/a", cost=1.0),
               _e(source="codex", model="gpt-5.5", dedup="", project="/p/a", cost=0.5),
               _e(project="/p/b", dedup="q:w", cost=2.0, missing=True, model="claude-x")]
    d = build_dashboard(entries, subscriptions=[], now=NOW)
    pa = next(p for p in d["projects"] if p["path"] == "/p/a")
    assert pa["claude_cost"] == 1.0 and pa["codex_cost"] == 0.5 and pa["total"] == 1.5
    assert "claude-x" in d["scan_meta"]["missing_pricing"]
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
        _e(source="codex", model="gpt-5.5", dedup="", project="/work/食譜整理/topics/x/slides", cost=4.0),
    ]
    d = build_dashboard(entries, subscriptions=[], now=NOW, roots=[root])
    by_path = {p["path"]: p for p in d["projects"]}
    assert set(by_path) == {"/work/fledge", "/work/食譜整理"}
    assert by_path["/work/fledge"]["claude_cost"] == 3.75   # 1 + 2 + 0.5 + 0.25
    assert by_path["/work/食譜整理"]["codex_cost"] == 4.0


def test_project_no_roots_keeps_raw_cwd():
    # 未傳 roots（或路徑在 root 外）→ 維持原 cwd 分組，不誤收斂
    d = build_dashboard([_e(project="/elsewhere/proj/sub", cost=1.0)],
                        subscriptions=[], now=NOW, roots=["/work"])
    assert [p["path"] for p in d["projects"]] == ["/elsewhere/proj/sub"]


def test_synthetic_not_in_missing_pricing_warning():
    # synthetic 是「排除計價」非「查無定價」，不得進使用者警示清單
    d = build_dashboard([_e(model="<synthetic>", missing=True, cost=0.0)],
                        subscriptions=[], now=NOW)
    assert d["scan_meta"]["missing_pricing"] == []


def test_horizon_excludes_old_entries_from_panels_but_not_kpi():
    old = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc).timestamp()  # 月內但 >days=7
    d = build_dashboard([_e(ts=NOW - 60, cost=1.0), _e(ts=old, cost=2.0, dedup="o:k")],
                        subscriptions=[], now=NOW, days=7)
    assert d["kpi"]["month_value"] == 3.0          # KPI 視窗不受 horizon 限制
    assert all(day["total"] != 2.0 for day in d["daily"]) or len(d["daily"]) == 1  # 舊條目不進 daily


def test_week_value_counts_recent_entry():
    d = build_dashboard([_e(ts=NOW - 60, cost=1.5)], subscriptions=[], now=NOW)
    assert d["kpi"]["week_value"] == 1.5


def test_synthetic_not_in_models_table():
    d = build_dashboard([_e(model="<synthetic>", missing=True, cost=0.0, input_tokens=999)],
                        subscriptions=[], now=NOW)
    assert all(m["model"] != "<synthetic>" for m in d["models"])


def test_bad_subscription_items_skipped():
    d = build_dashboard([_e(cost=1.0)],
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
    d = build_dashboard([zero, real], subscriptions=[], now=NOW)
    assert d["scan_meta"]["missing_pricing"] == ["gpt-9-future"]


# ---- build_codex_unattributed（spec 5.3）：NOW＝2026-06-12 10:00 UTC，今天＝06-12 ----

def _ts(day_hour: str) -> float:
    return datetime.strptime(day_hour, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()


def _cx(day_hour: str, inp: int, out: int, *, model="gpt-6.1-sol", cost=0.0, cached=0, missing=False):
    """一筆本機 codex 條目；day_hour 是 UTC 的 'YYYY-MM-DD HH:MM'。"""
    return _e(ts=_ts(day_hour), source="codex", model=model, cost=cost, dedup="", missing=missing,
              input_tokens=inp, output_tokens=out, cache_read_tokens=cached)


def _ua(entries, accounts, final, windows=None, *, now=NOW, price_model="gpt-6.1-sol"):
    return build_codex_unattributed(entries, accounts, final, windows or {}, now=now, price_model=price_model)


def _june(first: int, last: int) -> list[str]:
    return [f"2026-06-{d:02d}" for d in range(first, last + 1)]


def test_unattributed_share_sums_first_then_subtracts_once():
    """同一筆用量帳號算 06-10、本機算 06-11（跨午夜），兩天總量相同 → 比例 0。逐日歸零會是 100/150。
    最新的一天（06-12，還沒定稿）不進期間。本輪估計由前端算，後端不讀即時額度。"""
    out = _ua([_cx("2026-06-11 00:30", 140, 10)], {"acc-1": {"2026-06-10": 100, "2026-06-11": 50, "2026-06-12": 9}},
              {"acc-1": ["2026-06-10", "2026-06-11"]})
    assert out == {"share": 0.0, "share_start": "2026-06-10", "share_end": "2026-06-11", "share_days": 2,
                   "price_model": "gpt-6.1-sol", "previous": None}


def test_unattributed_share_uses_at_most_seven_complete_days():
    """最新的完整日往回最多 7 天；期間外的本機用量不扣，本機 token＝輸入＋輸出（輸入已含快取）。"""
    out = _ua([_cx("2026-06-03 12:00", 1000, 0), _cx("2026-06-04 12:00", 2, 1, cached=2), _cx("2026-06-11 12:00", 500, 0)],
              {"acc-1": {d: 10 for d in _june(1, 11)}}, {"acc-1": _june(1, 10)})
    assert (out["share_start"], out["share_end"], out["share_days"], out["share"]) == (
        "2026-06-04", "2026-06-10", 7, 67 / 70)


def test_unattributed_share_stops_at_a_missing_or_unfinal_day():
    """遇到缺日、或有資料但沒定稿的日子就停（spec 5.3-2）：沒定稿的那天可能是關機前還在變的最新一天。"""
    out = _ua([], {"acc-1": {"2026-06-07": 10, "2026-06-09": 30, "2026-06-10": 40}},
              {"acc-1": ["2026-06-07", "2026-06-09", "2026-06-10"]})
    assert (out["share_start"], out["share_days"]) == ("2026-06-09", 2)
    out = _ua([], {"acc-1": {"2026-06-07": 10, "2026-06-08": 20, "2026-06-09": 30, "2026-06-10": 40}},
              {"acc-1": ["2026-06-07", "2026-06-09", "2026-06-10"]})
    assert (out["share_start"], out["share_days"]) == ("2026-06-09", 2)


def test_unattributed_is_none_without_a_usable_share():
    """沒有完整日（只有還沒定稿的最新一天）→ None；期間帳號加總 0 → None（不畫那一行）。"""
    assert _ua([], {"acc-1": {"2026-06-11": 5}}, {"acc-1": []}) is None
    assert _ua([], {"acc-1": {"2026-06-10": 0, "2026-06-11": 3}}, {"acc-1": ["2026-06-10"]}) is None


def test_unattributed_is_none_when_the_newest_complete_day_is_too_old():
    """最新的完整日比今天早超過 8 天 → 背景停太久，借來的比例跟這一輪無關（spec 5.3-2）。"""
    assert (_ua([], {"acc-1": {"2026-06-04": 5, "2026-06-05": 1}}, {"acc-1": ["2026-06-04"]}) or {}).get("share_end") == "2026-06-04"
    assert _ua([], {"acc-1": {"2026-06-03": 5, "2026-06-04": 1}}, {"acc-1": ["2026-06-03"]}) is None


def test_unattributed_sums_accounts_and_missing_day_is_zero():
    """所有帳號加總；某帳號在期間內沒有某一天＝0。"""
    out = _ua([_cx("2026-06-11 12:00", 18, 0)], {"acc-a": {"2026-06-10": 100, "2026-06-11": 50}, "acc-b": {"2026-06-11": 30}},
              {"acc-a": ["2026-06-10", "2026-06-11"], "acc-b": ["2026-06-11"]})
    assert (out["share_start"], out["share"]) == ("2026-06-10", 162 / 180)


def test_unattributed_local_beyond_account_clamps_to_zero_and_ignores_claude():
    out = _ua([_cx("2026-06-11 08:00", 120, 30), _e(ts=NOW - 60)], {"acc-1": {"2026-06-11": 100}}, {"acc-1": ["2026-06-11"]})
    assert out["share"] == 0.0
    out = _ua([_e(ts=_ts("2026-06-11 12:00"), input_tokens=999)], {"acc-1": {"2026-06-11": 100}}, {"acc-1": ["2026-06-11"]})
    assert out["share"] == 1.0                                     # 期間內的 claude 條目不算本機 codex 用量


# 上一輪（spec 5.3-4）：重置在 UTC 17:48（台北 01:48）。06-11 是最新的一天（還沒定稿）
PREV = {"start": _ts("2026-06-03 17:48"), "resets_at": _ts("2026-06-10 17:48")}
CUR = {"start": _ts("2026-06-10 17:48"), "resets_at": _ts("2026-06-17 17:48")}
ACC = {"acc-1": {d: int(d[-2:]) * 10 for d in _june(1, 11)}}
FIN = {"acc-1": _june(1, 10)}
LOCAL = [_cx("2026-06-03 12:00", 100, 0, cost=0.2),     # 上一輪之前
         _cx("2026-06-04 01:00", 5, 0, cost=0.01),
         _cx("2026-06-10 20:00", 7, 0, cost=0.014),     # 重置之後，但 06-10 的中午在上一輪裡 → 算上一輪
         _cx("2026-06-11 12:00", 1000, 0, cost=2.0)]    # 單價＝全部紀錄 2.224／1112＝0.002


def test_previous_window_figures():
    """一天歸給它中午 12 點所在的那一輪：上一輪＝06-04～06-10。帳號 (4+…+10)×10＝490、本機 5＋7＝12。"""
    out = _ua(LOCAL, ACC, FIN, {"acc-1": [PREV, CUR]})["previous"]
    assert out == {"start_date": "2026-06-04", "end_date": "2026-06-10", "days": 7, "tokens": 478,
                   "account_tokens": 490, "share": pytest.approx(478 / 490), "cost": pytest.approx(478 * 0.002)}


@pytest.mark.parametrize("windows, final, now", [
    ({"acc-1": [CUR]}, FIN, NOW),
    ({"acc-1": [PREV, CUR]}, FIN, CUR["resets_at"]),
    ({"acc-1": [{"start": PREV["start"] - 86400, "resets_at": PREV["resets_at"] - 86400}, CUR]}, FIN, NOW),
    ({"acc-1": [PREV, CUR]}, {"acc-1": [d for d in _june(1, 10) if d != "2026-06-07"]}, NOW),
    ({"acc-1": [PREV, CUR]}, {"acc-1": _june(1, 9)}, NOW),
], ids=["single-window", "current-window-over", "gap-between-windows", "a-day-not-final", "last-day-not-final"])
def test_previous_window_is_none(windows, final, now):
    """只有一筆（裝好後第一輪）／這一輪已過 resets_at（紀錄落後）／兩輪中間有空檔（可能漏看了幾輪）／
    上一輪有任何一天不是完整日 → 沒有上一輪（spec 5.3-4）。"""
    assert _ua(LOCAL, ACC, final, windows, now=now)["previous"] is None


def test_previous_window_tolerates_a_small_gap():
    """兩輪之間差不到 10 分鐘仍算相接（resetsAt 的小幅漂移）。"""
    prev = {"start": PREV["start"] - 300, "resets_at": CUR["start"] - 300}
    out = _ua(LOCAL, ACC, FIN, {"acc-1": [prev, CUR]})["previous"]
    assert out is not None and out["days"] == 7


def test_previous_window_after_an_early_reset_ends_at_the_reset():
    """提早重置：上一輪在這一輪的 start 結束（spec 5.3-4），不是它原本的 resets_at。"""
    prev = {"start": _ts("2026-06-05 17:48"), "resets_at": _ts("2026-06-12 17:48")}
    cur = {"start": _ts("2026-06-09 05:00"), "resets_at": _ts("2026-06-16 05:00")}
    out = _ua(LOCAL, ACC, FIN, {"acc-1": [prev, cur]})["previous"]
    assert out is not None and (out["start_date"], out["end_date"], out["days"], out["tokens"]) == (
        "2026-06-06", "2026-06-08", 3, 210)


def test_previous_window_uses_the_account_seen_most_recently():
    """窗口紀錄取 start 最晚的那個帳號（換過帳號時，舊帳號的紀錄停在過去）。"""
    old = [{"start": PREV["start"] - 28 * 86400, "resets_at": PREV["resets_at"] - 28 * 86400},
           {"start": CUR["start"] - 28 * 86400, "resets_at": CUR["resets_at"] - 28 * 86400}]
    out = _ua(LOCAL, ACC, FIN, {"acc-old": old, "acc-1": [PREV, CUR]})["previous"]
    assert (out or {}).get("days") == 7


def test_cost_uses_all_local_entries_of_the_price_model():
    """單價＝該模型在本機**全部**紀錄的 sum(cost)/sum(輸入＋輸出)，不限期間；別的模型、查無定價的不算。"""
    entries = [_cx("2026-03-01 12:00", 900, 100, cost=2.0),            # 期間外也算進單價
               _cx("2026-06-05 12:00", 900, 100, cost=1.0),
               _cx("2026-06-05 13:00", 1000, 0, model="gpt-6-astra", cost=50.0),
               _cx("2026-06-05 14:00", 1000, 0, cost=0.0, missing=True)]
    acc = {"acc-1": {**{d: 0 for d in _june(4, 11)}, "2026-06-05": 13000}}
    out = _ua(entries, acc, FIN, {"acc-1": [PREV, CUR]}, price_model="gpt-6.1-sol-2026-05-01")
    assert out["price_model"] == "gpt-6.1-sol"                     # 去掉日期後綴才對得上條目
    assert out["previous"]["tokens"] == 10000                      # 13000 −（1000＋1000＋1000）
    assert out["previous"]["cost"] == pytest.approx(10000 * 3.0 / 2000)


def test_cost_is_none_without_a_usable_price():
    """查無定價、本機沒有該模型紀錄、沒有估價模型 → 金額 None（前端顯示「—」）。"""
    win = {"acc-1": [PREV, CUR]}
    priced = [_cx("2026-06-05 12:00", 10, 0, cost=1.0)]
    assert _ua([_cx("2026-06-05 12:00", 10, 0, model="gpt-x", missing=True)], ACC, FIN, win,
               price_model="gpt-x")["previous"]["cost"] is None
    assert _ua([_cx("2026-06-05 12:00", 10, 0, model="gpt-6-astra", cost=1.0)], ACC, FIN, win)["previous"]["cost"] is None
    out = _ua(priced, ACC, FIN, win, price_model=None)
    assert out["previous"]["cost"] is None and out["price_model"] is None

import json
import os
from pathlib import Path

import pytest


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FLEDGE_ACCOUNT_ACTIVITY", str(tmp_path / "activity.jsonl"))
    from fledge_sidecar.usage import account_activity as aa
    aa.mark_process_start(1000.0)   # 本測試固定 process_start
    return aa


def test_record_open_close_pairs_into_closed_span(store):
    store.record_open("/proj/a", "work", "s1", now=1100.0)
    store.record_close("s1", now=1200.0)
    spans = store.load_sessions(now=1300.0, live_session_ids=set())
    assert len(spans) == 1
    s = spans[0]
    assert s.account == "work" and s.open_ts == 1100.0 and s.close_ts == 1200.0
    assert s.project == str(Path("/proj/a").resolve())


def test_open_no_close_in_live_set_is_live(store):
    store.record_open("/proj/a", "work", "s1", now=1100.0)
    spans = store.load_sessions(now=1300.0, live_session_ids={"s1"})
    assert spans[0].close_ts is None   # 真 live


def test_open_no_close_not_live_current_process_closes_at_now(store):
    # open_ts >= process_start(1000) 且不在存活集合（close 事件遺失/spawn 失敗）→ 關於 now
    store.record_open("/proj/a", "work", "s1", now=1100.0)
    spans = store.load_sessions(now=1300.0, live_session_ids=set())
    assert spans[0].close_ts == 1300.0


def test_open_no_close_previous_process_closes_at_process_start(store):
    # open_ts < process_start(1000) → 前一進程殘留 → 關於 process_start
    store.record_open("/proj/a", "work", "s_old", now=900.0)
    spans = store.load_sessions(now=1300.0, live_session_ids=set())
    assert spans[0].close_ts == 1000.0


def test_record_is_fail_open(tmp_path, monkeypatch):
    # log 路徑指向一個「父層是檔案」的非法位置 → 寫入必失敗，但不得拋例外
    bad_parent = tmp_path / "afile"
    bad_parent.write_text("x")
    monkeypatch.setenv("FLEDGE_ACCOUNT_ACTIVITY", str(bad_parent / "sub" / "activity.jsonl"))
    from fledge_sidecar.usage import account_activity as aa
    aa.record_open("/p", "work", "s1", now=1.0)   # 不拋＝通過
    aa.record_close("s1", now=2.0)


def test_log_file_is_owner_only_0600(store, tmp_path):
    store.record_open("/proj/a", "work", "s1", now=1100.0)
    p = tmp_path / "activity.jsonl"
    assert (p.stat().st_mode & 0o777) == 0o600


def test_load_skips_torn_and_bad_lines(store, tmp_path):
    store.record_open("/proj/a", "work", "s1", now=1100.0)
    # 手動 append 一行殘缺 JSON（torn write 模擬）
    with open(tmp_path / "activity.jsonl", "a") as f:
        f.write('{"ts": 1200, "event": "open"')   # 無結尾
    spans = store.load_sessions(now=1300.0, live_session_ids={"s1"})
    assert len(spans) == 1   # 壞行跳過、好的 open 仍在


def test_retention_drops_old_closed_spans(store):
    store.record_open("/proj/a", "work", "s1", now=100.0)
    store.record_close("s1", now=200.0)        # close_ts 200，遠早於 now-保留
    spans = store.load_sessions(now=100.0 + 40 * 86400, live_session_ids=set())
    assert spans == []


def _span(project, account, open_ts, close_ts):
    from fledge_sidecar.usage.account_activity import SessionSpan
    return SessionSpan(project=project, account=account, open_ts=open_ts, close_ts=close_ts)


def test_attribute_basic_interval(store):
    spans = [_span("/proj/a", "work", 100.0, 200.0)]
    assert store.attribute(spans, "/proj/a", 150.0) == "work"


def test_attribute_before_open_or_after_close_is_none(store):
    spans = [_span("/proj/a", "work", 100.0, 200.0)]
    assert store.attribute(spans, "/proj/a", 50.0) is None     # 早於 open
    assert store.attribute(spans, "/proj/a", 250.0) is None    # 晚於 close


def test_attribute_live_span_has_no_upper_bound(store):
    spans = [_span("/proj/a", "work", 100.0, None)]
    assert store.attribute(spans, "/proj/a", 9_999.0) == "work"


def test_attribute_containment_subdir_cwd(store):
    # cwd 是 launched 專案的子目錄（使用者於 session 內 cd）
    spans = [_span("/proj/a", "work", 100.0, 200.0)]
    assert store.attribute(spans, "/proj/a/sub/x", 150.0) == "work"


def test_attribute_prefix_false_positive_not_matched(store):
    spans = [_span("/proj/a", "work", 100.0, 200.0)]
    assert store.attribute(spans, "/proj/abc", 150.0) is None   # /proj/abc 不算落在 /proj/a


def test_attribute_deepest_project_wins(store):
    # 巢狀已登記專案：cwd 在 /proj/a/pkg → 取最深匹配 /proj/a/pkg
    spans = [_span("/proj/a", "work", 100.0, 300.0),
             _span("/proj/a/pkg", "personal", 110.0, 300.0)]
    assert store.attribute(spans, "/proj/a/pkg/f", 150.0) == "personal"


def test_attribute_same_depth_tiebreak_latest_open(store):
    # 同專案、兩 span 不同帳號、皆涵蓋 → open_ts 最大者勝（切走再切回語義）
    spans = [_span("/proj/a", "work", 100.0, 300.0),
             _span("/proj/a", "personal", 200.0, None)]
    assert store.attribute(spans, "/proj/a", 250.0) == "personal"


def test_attribute_reverts_to_live_earlier_span_after_other_closes(store):
    # SC2：切 personal → 關 personal → 回仍 live 的 work tab。personal 區間外歸回 work。
    spans = [_span("/proj/a", "work", 100.0, None),        # work 仍 live
             _span("/proj/a", "personal", 200.0, 250.0)]   # personal 已關
    assert store.attribute(spans, "/proj/a", 220.0) == "personal"  # personal 區間內
    assert store.attribute(spans, "/proj/a", 300.0) == "work"      # personal 關閉後 → 回 work


def test_app_lifespan_calls_mark_process_start(tmp_path, monkeypatch):
    # create_app 的 lifespan 啟動後，process_start_ts 應為非 0（被 mark）
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    from fastapi.testclient import TestClient
    from fledge_sidecar.app import create_app
    from fledge_sidecar.usage import account_activity as aa
    aa.mark_process_start(0.0)                      # 先歸零
    with TestClient(create_app()):
        assert aa._process_start_ts > 0.0           # lifespan startup 已 mark

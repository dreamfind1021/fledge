# sidecar/tests/test_usage_perf.py
"""效能煙囪：合成 worst-case fixture（design §15/§16.1）。
門檻寬鬆訂在 CI 可過的水位；實機 <15s 驗收於手動清單做。"""
import json
import time
from pathlib import Path

import pytest

from fledge_sidecar.usage.cache import UsageCache


@pytest.mark.slow
def test_cold_scan_synthetic_fixture(tmp_path: Path):
    line = json.dumps({"type": "assistant", "timestamp": "2026-06-10T01:00:00Z",
                       "cwd": "/p", "sessionId": "s", "requestId": "r",
                       "message": {"id": "m", "model": "claude-opus-4-8",
                                   "usage": {"input_tokens": 1, "output_tokens": 1}}})
    big = tmp_path / "big.jsonl"
    # 注意：每行 requestId 唯一——同 key 的 fixture 會被 dedup 收斂成 1 條，
    # build_dashboard 的計時就測不到東西（Task 7 審查抓到的 fixture 盲點）
    lines = [line.replace('"requestId": "r"', f'"requestId": "r{i}"') for i in range(200_000)]
    big.write_text("\n".join(lines), encoding="utf-8")   # ~70MB 單檔
    smalls = []
    for i in range(300):                                  # 檔數 fanout
        f = tmp_path / f"s{i}.jsonl"
        f.write_text(line, encoding="utf-8")
        smalls.append(f)
    cache = UsageCache(l2_path=tmp_path / "l2.json")
    t0 = time.monotonic()
    r = cache.refresh(claude=[big] + smalls, codex=[])
    cold = time.monotonic() - t0
    assert len(r.entries) == 200_300
    assert cold < 30.0, f"冷掃 {cold:.1f}s 超出煙囪門檻"
    t0 = time.monotonic()
    cache.refresh(claude=[big] + smalls, codex=[])
    assert time.monotonic() - t0 < 0.5, "增量（無變動）應 <500ms"
    # 單檔變動（活躍 coding 的穩態路徑）：含重 parse 大檔＋全量 L2 重寫
    with open(big, "a", encoding="utf-8") as fh:
        fh.write("\n" + line)
    t0 = time.monotonic()
    r = cache.refresh(claude=[big] + smalls, codex=[])
    assert time.monotonic() - t0 < 3.0, "單檔變動 refresh 超標（考慮 guard 免重讀/落盤節流）"
    # 聚合計時（Task 7 審查：200k 條 datetime 工作曾佔 477-705ms；900s memo 後應 <500ms）。
    # now 取資料內最大 ts＋60——確保條目都在 horizon 內、計時不因測試執行日期而失真
    from fledge_sidecar.usage.aggregator import build_dashboard
    now = max(e.ts for e in r.entries) + 60
    t0 = time.monotonic()
    payload = build_dashboard(r.entries, [], now=now)
    assert time.monotonic() - t0 < 0.5, "build_dashboard 超標"
    assert payload["daily"], "fixture 條目應落在 horizon 內（計時才有效）"

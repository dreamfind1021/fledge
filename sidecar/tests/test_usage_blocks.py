from fledge_sidecar.usage.blocks import build_blocks
from fledge_sidecar.usage.parser import UsageEntry

H = 3600.0
BASE = 1_780_000_000.0 - (1_780_000_000.0 % H)  # 對齊整點，方便斷言


def _e(ts: float, tokens: int = 100) -> UsageEntry:
    return UsageEntry(ts=ts, source="claude", model="claude-opus-4-8",
                      input_tokens=tokens, output_tokens=0, cache_read_tokens=0,
                      cache_create_5m=0, cache_create_1h=0, cost=0.001,
                      project="/p", session_id="s", dedup_key="", sidechain=False,
                      missing_pricing=False)


def test_floor_to_hour_and_dual_break_conditions():
    entries = [
        _e(BASE + 600),            # block1 起點 floor → BASE
        _e(BASE + 600 + 6 * H),    # 距上一條 >5h → gap + block2（且 ≥ end_time）
        _e(BASE + 600 + 6 * H + 60),
    ]
    result = build_blocks(entries, now=BASE + 600 + 6 * H + 120)
    blocks = [b for b in result.blocks if not b.is_gap]
    gaps = [b for b in result.blocks if b.is_gap]
    assert len(blocks) == 2 and len(gaps) == 1
    assert blocks[0].start_ts == BASE                      # floor 到整點
    assert blocks[0].end_ts == BASE + 5 * H


def test_is_active_requires_recent_entry_and_within_window():
    entries = [_e(BASE + 60)]
    # 距末條 <5h 且 now < end → active
    assert build_blocks(entries, now=BASE + 2 * H).blocks[0].is_active is True
    # now 超過 end_time → closed
    assert build_blocks(entries, now=BASE + 5 * H + 1).blocks[0].is_active is False


def test_projection_null_when_too_short_and_p90_null_when_few_blocks():
    entries = [_e(BASE + 60), _e(BASE + 120)]  # 歷時 1 分鐘 <5min
    r = build_blocks(entries, now=BASE + 180)
    assert r.blocks[0].projection is None       # design §8.5
    assert r.limit_p90 is None                  # 歷史 block <5 個（design §8.6）


def test_burn_rate_and_projection_math():
    entries = [_e(BASE + 0, 1000), _e(BASE + 600, 1000)]  # 10 分鐘 2000 tokens
    r = build_blocks(entries, now=BASE + 600)
    b = r.blocks[0]
    assert abs(b.burn_rate_tpm - 200.0) < 1e-9            # 2000/10
    # 剩餘 (5h-10min)=290min → projection = 2000 + 200*290
    assert abs(b.projection - (2000 + 200 * 290)) < 1.0


def test_p90_from_closed_blocks():
    entries = []
    for i in range(6):  # 6 個 closed blocks（彼此相隔 >5h），tokens 100..600
        entries.append(_e(BASE + i * 6 * H, (i + 1) * 100))
    r = build_blocks(entries, now=BASE + 6 * 6 * H + 10 * H)  # 全部 closed
    assert r.limit_p90 is not None and 500 <= r.limit_p90 <= 600

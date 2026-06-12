"""Claude 5hr block 演算法（design §8；移植 Usage-Monitor、ccusage 語義交叉驗證）。
全部以 epoch 秒（UTC）計算；顯示層才轉本地時區。"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from fledge_sidecar.usage.parser import UsageEntry

SESSION_SECONDS = 5 * 3600
MIN_PROJECTION_MINUTES = 5.0
MIN_BLOCKS_FOR_P90 = 5


@dataclass
class Block:
    start_ts: float
    end_ts: float
    is_gap: bool = False
    is_active: bool = False
    first_entry_ts: float = 0.0
    last_entry_ts: float = 0.0
    total_tokens: int = 0
    cost: float = 0.0
    entry_count: int = 0
    burn_rate_tpm: float | None = None   # tokens per minute
    projection: float | None = None      # 投影至 block 結束的 total tokens


@dataclass
class BlocksResult:
    blocks: list[Block] = field(default_factory=list)
    limit_p90: float | None = None


def _floor_hour(ts: float) -> float:
    return ts - (ts % 3600)


def _entry_tokens(e: UsageEntry) -> int:
    return (e.input_tokens + e.output_tokens + e.cache_read_tokens
            + e.cache_create_5m + e.cache_create_1h)


def build_blocks(entries: list[UsageEntry], now: float) -> BlocksResult:
    result = BlocksResult()
    items = sorted(entries, key=lambda e: e.ts)
    cur: Block | None = None
    for e in items:
        if cur is not None and (e.ts >= cur.end_ts or e.ts - cur.last_entry_ts >= SESSION_SECONDS):
            if e.ts - cur.last_entry_ts >= SESSION_SECONDS:  # 插 gap block（僅視覺化）
                result.blocks.append(Block(start_ts=cur.last_entry_ts, end_ts=e.ts, is_gap=True))
            cur = None
        if cur is None:
            start = _floor_hour(e.ts)
            cur = Block(start_ts=start, end_ts=start + SESSION_SECONDS,
                        first_entry_ts=e.ts, last_entry_ts=e.ts)
            result.blocks.append(cur)
        cur.last_entry_ts = e.ts
        cur.total_tokens += _entry_tokens(e)
        cur.cost += e.cost
        cur.entry_count += 1
    closed_tokens: list[int] = []
    for b in result.blocks:
        if b.is_gap:
            continue
        # is_active 雙條件 AND（design §8.4）
        b.is_active = (now - b.last_entry_ts < SESSION_SECONDS) and (now < b.end_ts)
        if not b.is_active:
            closed_tokens.append(b.total_tokens)
        elapsed_min = max(1.0, (b.last_entry_ts - b.first_entry_ts) / 60.0)  # 防除零（design §8.5）
        b.burn_rate_tpm = b.total_tokens / elapsed_min
        if b.is_active and elapsed_min >= MIN_PROJECTION_MINUTES:
            remaining_min = max(0.0, (b.end_ts - now) / 60.0)
            b.projection = b.total_tokens + b.burn_rate_tpm * remaining_min
    if len(closed_tokens) >= MIN_BLOCKS_FOR_P90:   # P90 限額估計（design §8.6）
        s = sorted(closed_tokens)
        idx = min(len(s) - 1, max(0, math.ceil(0.9 * len(s)) - 1))
        result.limit_p90 = float(s[idx])
    return result

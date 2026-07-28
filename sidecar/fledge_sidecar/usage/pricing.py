"""計價公式與模型名正規化。定價表在 pricing_table.py（公式統一 ÷ 1_000_000，design §7）。

定價更新流程：改 pricing_table.py → 遞增 `TABLE_VERSION` → L2 快取自動只重算 cost（cache.py）。
"""
from __future__ import annotations

import re

from fledge_sidecar.usage.pricing_table import (CLAUDE_PRICING,  # noqa: F401 —— 對外沿用 pricing.* 入口
                                                CODEX_PRICING, TABLE_VERSION)

PRICING_VERSION = TABLE_VERSION

_MTOK = 1_000_000

# 別名＝同代正價近似（opus 4.x 全代同價，誤差可忽略）；裸別名指向各系列最新款
_CLAUDE_ALIASES = {"opus": "claude-opus-4-8", "sonnet": "claude-sonnet-5", "haiku": "claude-haiku-4-5"}
_CLAUDE_DATE_SUFFIX = re.compile(r"-\d{8}$")
_CODEX_DATE_SUFFIX = re.compile(r"-\d{4}-\d{2}-\d{2}$")
# 獨立價格帶後綴（尺寸 mini/nano、tier sol/terra/luna）不是同系列變體——prefix walk
# 不得跨越，否則未知變體會被默默用其他價格帶計（nano 差 25×），
# 違反 design §7 寧可標示不完整不默默算錯
_CODEX_SIZE_SEGMENTS = {"mini", "nano", "sol", "terra", "luna"}


def normalize_claude_model(raw: str) -> str | None:
    """別名映射＋去 8 位日期後綴；<synthetic> 回 None（排除計價）。"""
    if raw == "<synthetic>":
        return None
    if raw in _CLAUDE_ALIASES:
        return _CLAUDE_ALIASES[raw]
    return _CLAUDE_DATE_SUFFIX.sub("", raw)


def normalize_codex_model(raw: str) -> str:
    """去 ISO 日期後綴；再逐段去尾比對表 key（gpt-5.1-codex-max → gpt-5.1）。

    去尾段若是獨立價格帶後綴（mini/nano/sol/terra/luna）則停止——未知變體走 missing 而非錯價。
    """
    name = _CODEX_DATE_SUFFIX.sub("", raw)
    probe = name
    while probe:
        if probe in CODEX_PRICING:
            return probe
        if "-" not in probe:
            break
        probe, dropped = probe.rsplit("-", 1)
        if dropped in _CODEX_SIZE_SEGMENTS:
            break  # 不跨價格帶：未知獨立價格帶款（mini/nano/sol/terra/luna）回 missing 而非錯價
    return name  # 查無 → 保留原名，計價層回 missing


def claude_cost(model: str, input_tokens: int, output_tokens: int,
                cache_5m: int, cache_1h: int, cache_read: int) -> tuple[float, bool]:
    """回 (cost_usd, missing)。input_tokens 不含 cache tokens（API 語義，design §7）。"""
    price = CLAUDE_PRICING.get(model)
    if price is None:
        return 0.0, True
    p_in, p_out = price
    cost = (input_tokens * p_in + output_tokens * p_out
            + cache_5m * 1.25 * p_in + cache_1h * 2.0 * p_in
            + cache_read * 0.1 * p_in) / _MTOK
    return cost, False


def codex_cost(model: str, input_tokens: int, cached_input: int,
               output_tokens: int) -> tuple[float, bool]:
    """cached_input ⊆ input_tokens（本機資料驗證，design §7）。"""
    price = CODEX_PRICING.get(model)
    if price is None:
        return 0.0, True
    p_in, p_cached, p_out = price
    # max(0, ...) — cached ⊆ input 是觀察到的不變量，防上游壞行造成負成本污染聚合
    cost = (max(0, input_tokens - cached_input) * p_in + cached_input * p_cached
            + output_tokens * p_out) / _MTOK
    return cost, False

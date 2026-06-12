"""定價表與計價。單位一律 USD per MTok；公式統一 ÷ 1_000_000（design §7）。

定價更新流程：改表 → 遞增 PRICING_VERSION → L2 快取自動只重算 cost（cache.py）。
數字來源：Claude＝claude-api 參考（2026-06）；gpt-5 系列＝LiteLLM 表釘住（2026-06-12）。
"""
from __future__ import annotations

import re

PRICING_VERSION = "2026-06-12.2"

_MTOK = 1_000_000

# Claude：(input, output)；cache 用統一倍率（write 5m=1.25x、1h=2x、read=0.1x input）
CLAUDE_PRICING: dict[str, tuple[float, float]] = {
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-opus-4-5": (5.0, 25.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-fable-5": (10.0, 50.0),
}
# 別名＝同代正價近似（opus 4.x 全代同價，誤差可忽略）
_CLAUDE_ALIASES = {"opus": "claude-opus-4-8", "sonnet": "claude-sonnet-4-6", "haiku": "claude-haiku-4-5"}
_CLAUDE_DATE_SUFFIX = re.compile(r"-\d{8}$")

# Codex：(input, cached_input, output)
CODEX_PRICING: dict[str, tuple[float, float, float]] = {
    "gpt-5.5": (5.0, 0.5, 30.0),
    "gpt-5.4": (2.5, 0.25, 15.0),
    "gpt-5.3": (1.75, 0.175, 14.0),
    "gpt-5.2": (1.75, 0.175, 14.0),
    "gpt-5.1": (1.25, 0.125, 10.0),
    "gpt-5": (1.25, 0.125, 10.0),
    # 尺寸變體（LiteLLM 2026-06-12 釘價）——與全尺寸版本不同價格帶
    "gpt-5.1-codex-mini": (0.25, 0.025, 2.0),
    "gpt-5-mini": (0.25, 0.025, 2.0),
    "gpt-5-nano": (0.05, 0.005, 0.4),
    "gpt-5.4-mini": (0.75, 0.075, 4.5),
    "gpt-5.4-nano": (0.2, 0.02, 1.25),
}
_CODEX_DATE_SUFFIX = re.compile(r"-\d{4}-\d{2}-\d{2}$")
# 尺寸後綴是不同價格帶而非同系列變體——prefix walk 不得跨越，
# 否則未知 mini/nano 會被默默用全尺寸價計（nano 差 25×），
# 違反 design §7 寧可標示不完整不默默算錯
_CODEX_SIZE_SEGMENTS = {"mini", "nano"}


def normalize_claude_model(raw: str) -> str | None:
    """別名映射＋去 8 位日期後綴；<synthetic> 回 None（排除計價）。"""
    if raw == "<synthetic>":
        return None
    if raw in _CLAUDE_ALIASES:
        return _CLAUDE_ALIASES[raw]
    return _CLAUDE_DATE_SUFFIX.sub("", raw)


def normalize_codex_model(raw: str) -> str:
    """去 ISO 日期後綴；再逐段去尾比對表 key（gpt-5.1-codex-max → gpt-5.1）。

    去尾段若是尺寸後綴（mini/nano）則停止——未知尺寸款走 missing 而非錯價。
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
            break  # 不跨尺寸帶：未知 mini/nano 款回 missing 而非走全尺寸價
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

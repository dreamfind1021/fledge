"""定價表：自動生成，請勿手改（單位一律 USD per MTok）。

由 `python admin/sync_pricing.py` 從 LiteLLM model_prices_and_context_window.json 重生；
表 key 已套用 pricing.py 的正規化（剝日期後綴），故等同 runtime 查表用的 key。
計價公式與正規化在 pricing.py；刻意偏離上游的項目與理由記在 pricing.py 的 PINNED / EXCLUDED。
"""
from __future__ import annotations

# <生成日期>.<表內容 sha256 前 8 碼>：內容一變就變，改表不可能忘記遞增。
# cache.py 只做相等比對，不解析內容。
TABLE_VERSION = "2026-07-28.559227cd"

# Claude：(input, output, cache_5m_write, cache_1h_write, cache_read)——三層 cache 存
# 上游真價而非倍率（倍率只對現行世代成立，claude-3-haiku 實為 1.2x/0.12x）；
# 上游缺哪層才由 sync 用 1.25x/2x/0.1x 推導。
CLAUDE_PRICING: dict[str, tuple[float, float, float, float, float]] = {
    "claude-3-7-sonnet": (3.0, 15.0, 3.75, 6.0, 0.3),
    "claude-3-haiku": (0.25, 1.25, 0.3, 6.0, 0.03),
    "claude-3-opus": (15.0, 75.0, 18.75, 6.0, 1.5),
    "claude-4-opus": (15.0, 75.0, 18.75, 30.0, 1.5),
    "claude-4-sonnet": (3.0, 15.0, 3.75, 6.0, 0.3),
    "claude-fable-5": (10.0, 50.0, 12.5, 20.0, 1.0),
    "claude-haiku-4-5": (1.0, 5.0, 1.25, 2.0, 0.1),
    "claude-opus-4": (15.0, 75.0, 18.75, 30.0, 1.5),
    "claude-opus-4-1": (15.0, 75.0, 18.75, 30.0, 1.5),
    "claude-opus-4-5": (5.0, 25.0, 6.25, 10.0, 0.5),
    "claude-opus-4-6": (5.0, 25.0, 6.25, 10.0, 0.5),
    "claude-opus-4-7": (5.0, 25.0, 6.25, 10.0, 0.5),
    "claude-opus-4-8": (5.0, 25.0, 6.25, 10.0, 0.5),
    "claude-opus-5": (5.0, 25.0, 6.25, 10.0, 0.5),
    "claude-sonnet-4": (3.0, 15.0, 3.75, 6.0, 0.3),
    "claude-sonnet-4-5": (3.0, 15.0, 3.75, 6.0, 0.3),
    "claude-sonnet-4-6": (3.0, 15.0, 3.75, 6.0, 0.3),
    "claude-sonnet-5": (3.0, 15.0, 3.75, 6.0, 0.3),
}

# Codex：(input, cached_input, output)
CODEX_PRICING: dict[str, tuple[float, float, float]] = {
    "gpt-5": (1.25, 0.125, 10.0),
    "gpt-5-chat": (1.25, 0.125, 10.0),
    "gpt-5-chat-latest": (1.25, 0.125, 10.0),
    "gpt-5-codex": (1.25, 0.125, 10.0),
    "gpt-5-mini": (0.25, 0.025, 2.0),
    "gpt-5-nano": (0.05, 0.005, 0.4),
    "gpt-5-pro": (15.0, 15.0, 120.0),
    "gpt-5-search-api": (1.25, 0.125, 10.0),
    "gpt-5.1": (1.25, 0.125, 10.0),
    "gpt-5.1-chat-latest": (1.25, 0.125, 10.0),
    "gpt-5.1-codex": (1.25, 0.125, 10.0),
    "gpt-5.1-codex-max": (1.25, 0.125, 10.0),
    "gpt-5.1-codex-mini": (0.25, 0.025, 2.0),
    "gpt-5.2": (1.75, 0.175, 14.0),
    "gpt-5.2-chat-latest": (1.75, 0.175, 14.0),
    "gpt-5.2-codex": (1.75, 0.175, 14.0),
    "gpt-5.2-pro": (21.0, 21.0, 168.0),
    "gpt-5.3-chat-latest": (1.75, 0.175, 14.0),
    "gpt-5.3-codex": (1.75, 0.175, 14.0),
    "gpt-5.4": (2.5, 0.25, 15.0),
    "gpt-5.4-mini": (0.75, 0.075, 4.5),
    "gpt-5.4-nano": (0.2, 0.02, 1.25),
    "gpt-5.4-pro": (30.0, 3.0, 180.0),
    "gpt-5.5": (5.0, 0.5, 30.0),
    "gpt-5.5-pro": (30.0, 3.0, 180.0),
    "gpt-5.6-luna": (1.0, 0.1, 6.0),
    "gpt-5.6-sol": (5.0, 0.5, 30.0),
    "gpt-5.6-terra": (2.5, 0.25, 15.0),
}

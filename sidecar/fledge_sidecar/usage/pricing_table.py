"""定價表：自動生成，請勿手改（單位一律 USD per MTok）。

由 `python admin/sync_pricing.py` 從 LiteLLM model_prices_and_context_window.json 重生；
表 key 已套用 pricing.py 的正規化（剝日期後綴），故等同 runtime 查表用的 key。
計價公式與正規化在 pricing.py；刻意偏離上游的項目與理由記在 pricing.py 的 PINNED / EXCLUDED。
"""
from __future__ import annotations

# <生成日期>.<表內容 sha256 前 8 碼>：內容一變就變，改表不可能忘記遞增。
# cache.py 只做相等比對，不解析內容。
TABLE_VERSION = "2026-07-28.dede773b"

# Claude：(input, output)；cache 用統一倍率（write 5m=1.25x、1h=2x、read=0.1x input），
# 倍率由 sync 對上游逐款驗證，不符會警示。
CLAUDE_PRICING: dict[str, tuple[float, float]] = {
    "claude-3-7-sonnet": (3.0, 15.0),
    "claude-3-haiku": (0.25, 1.25),
    "claude-3-opus": (15.0, 75.0),
    "claude-4-opus": (15.0, 75.0),
    "claude-4-sonnet": (3.0, 15.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-opus-4": (15.0, 75.0),
    "claude-opus-4-1": (15.0, 75.0),
    "claude-opus-4-5": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-4": (3.0, 15.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-sonnet-5": (3.0, 15.0),
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

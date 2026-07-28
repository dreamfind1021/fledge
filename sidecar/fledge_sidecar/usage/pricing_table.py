"""定價表：純資料模組，不放邏輯也不放決策敘事（單位一律 USD per MTok）。

計價公式與正規化在 pricing.py。本檔整檔可重生，故不得手寫任何無法從上游還原的資訊。

數字來源：Claude＝Anthropic 官方定價頁（sonnet-5 用標準價非促銷價）；
gpt-5 系列＝LiteLLM model_prices_and_context_window.json 釘住（2026-06-12）。
"""
from __future__ import annotations

# L2 快取失效信號（cache.py 只做相等比對，不解析內容）
TABLE_VERSION = "2026-07-28.1"

# Claude：(input, output)；cache 用統一倍率（write 5m=1.25x、1h=2x、read=0.1x input）
CLAUDE_PRICING: dict[str, tuple[float, float]] = {
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-opus-4-5": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-fable-5": (10.0, 50.0),
}

# Codex：(input, cached_input, output)
CODEX_PRICING: dict[str, tuple[float, float, float]] = {
    "gpt-5.6-sol": (5.0, 0.5, 30.0),
    "gpt-5.6-terra": (2.5, 0.25, 15.0),
    "gpt-5.6-luna": (1.0, 0.1, 6.0),
    "gpt-5.5": (5.0, 0.5, 30.0),
    "gpt-5.4": (2.5, 0.25, 15.0),
    "gpt-5.4-mini": (0.75, 0.075, 4.5),
    "gpt-5.4-nano": (0.2, 0.02, 1.25),
    "gpt-5.3": (1.75, 0.175, 14.0),
    "gpt-5.2": (1.75, 0.175, 14.0),
    "gpt-5.1": (1.25, 0.125, 10.0),
    "gpt-5.1-codex-mini": (0.25, 0.025, 2.0),
    "gpt-5": (1.25, 0.125, 10.0),
    "gpt-5-mini": (0.25, 0.025, 2.0),
    "gpt-5-nano": (0.05, 0.005, 0.4),
}

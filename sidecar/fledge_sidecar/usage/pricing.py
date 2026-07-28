"""計價公式與模型名正規化。定價表在 pricing_table.py（公式統一 ÷ 1_000_000，design §7）。

定價更新流程：改 pricing_table.py → 遞增 `TABLE_VERSION` → L2 快取自動只重算 cost（cache.py）。
"""
from __future__ import annotations

import re

from fledge_sidecar.usage.pricing_table import (CLAUDE_PRICING, CODEX_PRICING,
                                                TABLE_VERSION)

PRICING_VERSION = TABLE_VERSION

_MTOK = 1_000_000

# 別名＝同代正價近似（opus 4.x 全代同價，誤差可忽略）；裸別名指向各系列最新款
_CLAUDE_ALIASES = {"opus": "claude-opus-4-8", "sonnet": "claude-sonnet-5", "haiku": "claude-haiku-4-5"}
_CLAUDE_DATE_SUFFIX = re.compile(r"-\d{8}$")
_CODEX_DATE_SUFFIX = re.compile(r"-\d{4}-\d{2}-\d{2}$")

# ---- sync 例外清單（key → 理由）----------------------------------------------
# 只影響 admin/sync_pricing.py 的寫入決策，不參與 runtime 查表——runtime 一律以
# pricing_table.py 為準。理由留在這裡而非表裡，因為表整檔可重生、留不住敘事。

# 刻意不跟上游現價：key → (我們用的價, 理由)。sync 寫入這個值並報告上游差異。
# 價與理由放在一起，是為了不依賴「前一版表的內容」——表是生成物，欄位數改了就對不上。
PINNED: dict[str, tuple[tuple[float, ...], str]] = {
    # (input, output, cache_5m, cache_1h, cache_read)，取自 Anthropic 官方定價頁的標準價欄
    "claude-sonnet-5": ((3.0, 15.0, 3.75, 6.0, 0.3),
                        "釘標準價 $3/$15。Anthropic 官方：促銷價 $2/$10 至 2026-08-31，"
                        "9/1 起標準價生效；上游追促銷價。靜態表不追時間，且 Net ROI 需跨月可比。"),
}

# 刻意不入表：查無定價會走 missing 警示，比默默用近似價安全。
EXCLUDED: dict[str, str] = {
    "gpt-5.6": "OpenAI 官方定價頁只列 sol/terra/luna 三個 tier，裸 gpt-5.6 是上游自造（＝sol 價）。"
               "若實跑 luna 會錯 5×，寧可 missing。",
}


def normalize_claude_model(raw: str) -> str | None:
    """別名映射＋去 8 位日期後綴；<synthetic> 回 None（排除計價）。"""
    if raw == "<synthetic>":
        return None
    if raw in _CLAUDE_ALIASES:
        return _CLAUDE_ALIASES[raw]
    return _CLAUDE_DATE_SUFFIX.sub("", raw)


def normalize_codex_model(raw: str) -> str:
    """只去 ISO 日期後綴。查無 → 保留原名，計價層回 missing。

    刻意不做 prefix walk：`-pro` 與全尺寸差 12×（gpt-5.4-pro $30/$180 vs gpt-5.4 $2.5/$15）、
    `-nano` 差 25×，而「哪些後綴是獨立價格帶」是追不完的 allowlist（sol/terra/luna 之後又有
    spark）。表由 admin/sync_pricing.py 從上游整批同步，變體本來就都在表內；表外的未知款
    寧可 missing 也不猜（design §7 寧可標示不完整不默默算錯）。
    """
    return _CODEX_DATE_SUFFIX.sub("", raw)


def claude_cost(model: str, input_tokens: int, output_tokens: int,
                cache_5m: int, cache_1h: int, cache_read: int) -> tuple[float, bool]:
    """回 (cost_usd, missing)。input_tokens 不含 cache tokens（API 語義，design §7）。

    cache 三層讀表內真價，不套寫死倍率——倍率(1.25/2/0.1)只對現行世代成立，
    claude-3-haiku 實際是 1.2×/0.12×。倍率改由 sync 在上游缺該層時當推導 fallback。
    """
    price = CLAUDE_PRICING.get(model)
    if price is None:
        return 0.0, True
    p_in, p_out, p_5m, p_1h, p_read = price
    cost = (input_tokens * p_in + output_tokens * p_out
            + cache_5m * p_5m + cache_1h * p_1h + cache_read * p_read) / _MTOK
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

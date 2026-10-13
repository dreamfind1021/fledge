import pytest
from fledge_sidecar.usage import pricing


def test_normalize_claude_alias_and_suffix():
    assert pricing.normalize_claude_model("opus") == "claude-opus-5-5"  # 裸別名指向現役 opus
    assert pricing.normalize_claude_model("sonnet") == "claude-sonnet-5-5"  # 裸別名指向最新 sonnet
    assert pricing.normalize_claude_model("haiku") == "claude-haiku-5-5"  # 裸別名指向現役 haiku
    assert pricing.normalize_claude_model("claude-haiku-4-5-20251001") == "claude-haiku-4-5"
    assert pricing.normalize_claude_model("claude-fable-5") == "claude-fable-5"
    assert pricing.normalize_claude_model("<synthetic>") is None  # 不可計價


def test_claude_sonnet_5_priced_at_standard_rate():
    # sonnet-5 的標準價是 $2/$10：原訂 9/1 漲到 $3/$15 已被官方取消，1M in + 1M out = 2 + 10
    cost, missing = pricing.claude_cost("claude-sonnet-5", 1_000_000, 1_000_000, 0, 0, 0)
    assert missing is False
    assert abs(cost - 12.0) < 1e-9


def test_claude_cost_per_mtok_with_cache_tiers():
    # 1M input + 1M output + 1M cache_5m + 1M cache_1h + 1M cache_read（opus 4.8: $5/$25）
    cost, missing = pricing.claude_cost("claude-opus-4-8", 1_000_000, 1_000_000,
                                        1_000_000, 1_000_000, 1_000_000)
    # 5 + 25 + 5*1.25 + 5*2 + 5*0.1 = 46.75
    assert missing is False
    assert abs(cost - 46.75) < 1e-9


def test_claude_cost_unknown_model_is_zero_and_missing():
    cost, missing = pricing.claude_cost("claude-unknown-9", 1000, 1000, 0, 0, 0)
    assert cost == 0.0 and missing is True



_BASE = (1.0, 2.0, 3.0, 4.0, 5.0)
_TIER = (10.0, 30.0, 50.0, 70.0, 90.0)   # 各欄倍數不同：「整組乘同一個倍數」的錯算也抓得到


@pytest.fixture
def long_context_tables(monkeypatch):
    """假款：claude-tier-9 有分段（門檻 1M）、claude-flat-9 沒有。數字選成容易手算。"""
    monkeypatch.setattr(pricing, "CLAUDE_PRICING", {"claude-tier-9": _BASE, "claude-flat-9": _BASE})
    monkeypatch.setattr(pricing, "CLAUDE_LONG_CONTEXT", {"claude-tier-9": (1_000_000, _TIER)})


def _cost(model, inp=0, out=0, c5m=0, c1h=0, read=0):
    cost, missing = pricing.claude_cost(model, inp, out, c5m, c1h, read)
    assert missing is False
    return cost


def test_long_context_starts_strictly_above_the_threshold(long_context_tables):
    """官方：「for prompts over 100,000 tokens」——剛好等於門檻仍是基本價。"""
    assert _cost("claude-tier-9", inp=1_000_000) == pytest.approx(1.0)
    assert _cost("claude-tier-9", inp=1_000_001) == pytest.approx(10.00001)


@pytest.mark.parametrize("field, expected", [
    ("inp", 10.00001), ("c5m", 50.00005), ("c1h", 70.00007), ("read", 90.00009)],
    ids=["input", "cache_5m", "cache_1h", "cache_read"])
def test_each_prompt_component_alone_can_cross_the_threshold(long_context_tables, field, expected):
    """長度＝input＋兩種 cache 寫入＋cache 讀取（官方：counts all of its input tokens, including
    cache reads and cache writes）。每項單獨越線都要換價，少算任何一項，對應那條會紅。"""
    assert _cost("claude-tier-9", **{field: 1_000_001}) == pytest.approx(expected)


def test_components_add_up_to_cross_the_threshold(long_context_tables):
    """每項單獨都沒越線、加起來才越線：長度是四項相加，不是取最大的那一項（Codex plan R1）。"""
    cost = _cost("claude-tier-9", inp=250_001, c5m=250_000, c1h=250_000, read=250_000)
    assert cost == pytest.approx((250_001 * 10.0 + 250_000 * (50.0 + 70.0 + 90.0)) / 1e6)


def test_output_does_not_count_toward_prompt_length(long_context_tables):
    assert _cost("claude-tier-9", inp=1_000_000, out=5_000_000) == pytest.approx(1.0 + 10.0)


def test_crossing_the_threshold_switches_all_five_columns(long_context_tables):
    cost = _cost("claude-tier-9", inp=1_000_000, out=1_000_000, c5m=1_000_000, c1h=1_000_000,
                 read=1_000_000)
    assert cost == pytest.approx(10.0 + 30.0 + 50.0 + 70.0 + 90.0)   # output 也換成分段價


def test_model_without_long_context_keeps_base_price(long_context_tables):
    assert _cost("claude-flat-9", inp=5_000_000) == pytest.approx(5.0)


def test_haiku_5_5_long_context_matches_official_pricing():
    """官方定價頁（2026-10-13）：prompt 超過 100,000 時五欄全 ×5。上游改了這組數字，同步後這條
    會紅，逼人回官方頁核對（同 gpt-5.6 三 tier 的釘價做法）。"""
    assert pricing.CLAUDE_LONG_CONTEXT["claude-haiku-5-5"] == (100000, (0.5, 2.5, 0.625, 1.0, 0.05))

def test_normalize_codex_only_strips_date_suffix():
    assert pricing.normalize_codex_model("gpt-5.5-2026-04-23") == "gpt-5.5"
    assert pricing.normalize_codex_model("unknown-codex") == "unknown-codex"
    # 不做 prefix walk：變體名原樣保留，由表決定有沒有價
    assert pricing.normalize_codex_model("gpt-5.1-codex-max") == "gpt-5.1-codex-max"


def test_codex_cost_cached_subset_of_input():
    # gpt-5.5: in $5 / cached $0.5 / out $30；input 含 cached（規格 §7）
    cost, missing = pricing.codex_cost("gpt-5.5", input_tokens=1_000_000,
                                       cached_input=400_000, output_tokens=100_000)
    # (1M-0.4M)*5 + 0.4M*0.5 + 0.1M*30 → (3.0 + 0.2 + 3.0) = 6.2
    assert missing is False
    assert abs(cost - 6.2) < 1e-9


def test_pricing_version_exists():
    assert isinstance(pricing.PRICING_VERSION, str) and pricing.PRICING_VERSION


def test_normalize_codex_size_variants_never_get_fullsize_price():
    # 已知 mini/nano → 自己的價格帶；未知 mini/nano → missing（不得落到全尺寸價）
    assert pricing.normalize_codex_model("gpt-5.1-codex-mini") == "gpt-5.1-codex-mini"
    assert pricing.normalize_codex_model("gpt-5-nano") == "gpt-5-nano"
    name = pricing.normalize_codex_model("gpt-5.5-mini")   # 表中無此款
    assert pricing.codex_cost(name, 1000, 0, 0) == (0.0, True)


def test_normalize_codex_gpt56_tiers_have_own_price_bands():
    # gpt-5.6 以 sol/terra/luna tier 命名＝各自獨立價格帶（LiteLLM 2026-08-26 釘價）
    assert pricing.normalize_codex_model("gpt-5.6-sol") == "gpt-5.6-sol"
    assert pricing.normalize_codex_model("gpt-5.6-terra-2026-07-09") == "gpt-5.6-terra"
    # 三欄全鎖（in/cached/out）：1M in 含 0.4M cached + 0.1M out
    for model, (p_in, p_cached, p_out) in [("gpt-5.6-sol", (4.0, 0.4, 20.0)),
                                           ("gpt-5.6-terra", (2.0, 0.2, 12.0)),
                                           ("gpt-5.6-luna", (0.2, 0.02, 1.2))]:
        cost, missing = pricing.codex_cost(model, 1_000_000, 400_000, 100_000)
        assert missing is False, model
        assert abs(cost - (0.6 * p_in + 0.4 * p_cached + 0.1 * p_out)) < 1e-9, model


def test_normalize_codex_unknown_variant_is_missing_not_guessed():
    # 表外的變體一律 missing——不得落到同系列其他價格帶（pro 差 12×、nano 差 25×）
    for raw in ("gpt-5.5-sol",          # 未知 tier
                "gpt-5.3-codex-spark",  # 未知 tier（上游無此 key，無從查證真價）
                "gpt-5.9-pro"):         # 未來款
        name = pricing.normalize_codex_model(raw)
        assert pricing.codex_cost(name, 1000, 0, 0) == (0.0, True), raw

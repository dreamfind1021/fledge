from fledge_sidecar.usage import pricing


def test_normalize_claude_alias_and_suffix():
    assert pricing.normalize_claude_model("opus") == "claude-opus-4-8"
    assert pricing.normalize_claude_model("sonnet") == "claude-sonnet-5"  # 裸別名指向最新 sonnet
    assert pricing.normalize_claude_model("claude-haiku-4-5-20251001") == "claude-haiku-4-5"
    assert pricing.normalize_claude_model("claude-fable-5") == "claude-fable-5"
    assert pricing.normalize_claude_model("<synthetic>") is None  # 不可計價


def test_claude_sonnet_5_priced_at_standard_rate():
    # sonnet-5 用標準價 $3/$15（非促銷 $2/$10）：1M in + 1M out = 3 + 15
    cost, missing = pricing.claude_cost("claude-sonnet-5", 1_000_000, 1_000_000, 0, 0, 0)
    assert missing is False
    assert abs(cost - 18.0) < 1e-9


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


def test_normalize_codex_strips_date_suffix_and_prefix_matches():
    assert pricing.normalize_codex_model("gpt-5.5-2026-04-23") == "gpt-5.5"
    assert pricing.normalize_codex_model("gpt-5.1-codex-max") == "gpt-5.1"
    assert pricing.normalize_codex_model("unknown-codex") == "unknown-codex"


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
    # 已知 mini/nano → 自己的價格帶；未知 mini/nano → missing（不得 walk 到全尺寸價）
    assert pricing.normalize_codex_model("gpt-5.1-codex-mini") == "gpt-5.1-codex-mini"
    assert pricing.normalize_codex_model("gpt-5-nano") == "gpt-5-nano"
    name = pricing.normalize_codex_model("gpt-5.5-mini")   # 表中無此款
    assert pricing.codex_cost(name, 1000, 0, 0) == (0.0, True)


def test_normalize_codex_gpt56_tiers_have_own_price_bands():
    # gpt-5.6 以 sol/terra/luna tier 命名＝各自獨立價格帶（LiteLLM 2026-07-18 釘價）
    assert pricing.normalize_codex_model("gpt-5.6-sol") == "gpt-5.6-sol"
    assert pricing.normalize_codex_model("gpt-5.6-terra-2026-07-09") == "gpt-5.6-terra"
    # 三欄全鎖（in/cached/out）：1M in 含 0.4M cached + 0.1M out
    for model, (p_in, p_cached, p_out) in [("gpt-5.6-sol", (5.0, 0.5, 30.0)),
                                           ("gpt-5.6-terra", (2.5, 0.25, 15.0)),
                                           ("gpt-5.6-luna", (1.0, 0.1, 6.0))]:
        cost, missing = pricing.codex_cost(model, 1_000_000, 400_000, 100_000)
        assert missing is False, model
        assert abs(cost - (0.6 * p_in + 0.4 * p_cached + 0.1 * p_out)) < 1e-9, model


def test_normalize_codex_tier_suffix_never_crosses_band():
    # 未知 tier 款（表中無）不得 walk 到其他價格帶（比照 mini/nano 護欄）
    name = pricing.normalize_codex_model("gpt-5.5-sol")
    assert pricing.codex_cost(name, 1000, 0, 0) == (0.0, True)
    # spark 刻意沿用 walk 映射 gpt-5.3——三欄同價（$1.75/$0.175/$14，2026-07-18 查證）
    assert pricing.normalize_codex_model("gpt-5.3-codex-spark") == "gpt-5.3"

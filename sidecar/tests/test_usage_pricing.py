from fledge_sidecar.usage import pricing


def test_normalize_claude_alias_and_suffix():
    assert pricing.normalize_claude_model("opus") == "claude-opus-4-8"
    assert pricing.normalize_claude_model("claude-haiku-4-5-20251001") == "claude-haiku-4-5"
    assert pricing.normalize_claude_model("claude-fable-5") == "claude-fable-5"
    assert pricing.normalize_claude_model("<synthetic>") is None  # 不可計價


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

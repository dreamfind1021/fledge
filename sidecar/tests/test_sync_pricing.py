"""admin/sync_pricing.py 的表建構與渲染（不連外、不掃本機用量）。

腳本在 sidecar 套件外，故以 importlib 由路徑載入。
"""
import importlib.util
from pathlib import Path

import pytest
from fledge_sidecar.usage import pricing

_ADMIN = Path(__file__).resolve().parents[2] / "admin" / "sync_pricing.py"
_spec = importlib.util.spec_from_file_location("sync_pricing", _ADMIN)
sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync)


def _claude(p_in, p_out, *, c5m=None, c1h=None, cread=None):
    entry = {"input_cost_per_token": p_in, "output_cost_per_token": p_out}
    for field, value in (("cache_creation_input_token_cost", c5m),
                         ("cache_creation_input_token_cost_above_1hr", c1h),
                         ("cache_read_input_token_cost", cread)):
        if value is not None:
            entry[field] = value
    return entry


UPSTREAM = {
    # 裸 key 與其日期版 → 同一個表 key，價格一致故不算衝突
    "claude-opus-9": _claude(5e-06, 2.5e-05, c5m=6.25e-06, c1h=1e-05, cread=5e-07),
    "claude-opus-9-20260101": _claude(5e-06, 2.5e-05),
    # provider 前綴／路徑／Bedrock 版本尾綴都是區域價，不得混入第一方表
    "anthropic.claude-opus-9": _claude(9e-06, 9e-05),
    "us.anthropic.claude-opus-9": _claude(9e-06, 9e-05),
    "vertex_ai/claude-opus-9": _claude(9e-06, 9e-05),
    "claude-opus-9-20260101-v1:0": _claude(9e-06, 9e-05),
    # 無 input 價 → 無從計價，跳過
    "claude-noprice": {"output_cost_per_token": 1e-05},
    # cached 為 0 與缺欄位：兩種「上游未提供」都要退回 input 價
    "gpt-5.9": {"input_cost_per_token": 5e-06, "cache_read_input_token_cost": 0,
                "output_cost_per_token": 3e-05},
    "gpt-5.9-pro": {"input_cost_per_token": 3e-05, "output_cost_per_token": 1.8e-04},
    "gpt-5.9-mini": {"input_cost_per_token": 7.5e-07, "cache_read_input_token_cost": 7.5e-08,
                     "output_cost_per_token": 4.5e-06},
    # 非兩源前綴
    "gpt-4o": {"input_cost_per_token": 2.5e-06, "output_cost_per_token": 1e-05},
}


@pytest.fixture(autouse=True)
def _no_real_exceptions(monkeypatch):
    """測試不綁真實 PINNED/EXCLUDED 內容——那是會隨定價變動的資料，不是契約。"""
    monkeypatch.setattr(pricing, "PINNED", {})
    monkeypatch.setattr(pricing, "EXCLUDED", {})
    monkeypatch.setattr(sync.current, "CLAUDE_PRICING", {})
    monkeypatch.setattr(sync.current, "CODEX_PRICING", {})


def test_only_bare_first_party_keys_enter_table():
    claude, codex, _, conflicts, _ = sync.build_tables(UPSTREAM)
    assert conflicts == []
    # 日期版併入裸 key；provider 前綴/路徑/`:` 版本尾綴全濾掉，故區域價不會蓋掉第一方價
    assert claude == {"claude-opus-9": (5.0, 25.0)}
    assert set(codex) == {"gpt-5.9", "gpt-5.9-pro", "gpt-5.9-mini"}
    assert "gpt-4o" not in codex and "claude-noprice" not in claude


def test_missing_cached_price_falls_back_to_input_not_free():
    _, codex, _, _, _ = sync.build_tables(UPSTREAM)
    # 上游填 0 與整個沒有該欄，都代表「未提供」——當免費會低估，故退回 input 價
    assert codex["gpt-5.9"] == (5.0, 5.0, 30.0)
    assert codex["gpt-5.9-pro"] == (30.0, 30.0, 180.0)
    # 有真值時照收
    assert codex["gpt-5.9-mini"] == (0.75, 0.075, 4.5)


def test_same_normalized_key_with_different_prices_is_a_conflict():
    raw = dict(UPSTREAM)
    raw["claude-opus-9-20260202"] = _claude(7e-06, 3.5e-05)   # 與裸 key 不同價
    _, _, _, conflicts, _ = sync.build_tables(raw)
    assert any("claude-opus-9" in c for c in conflicts)


def test_excluded_key_never_enters_table(monkeypatch):
    monkeypatch.setattr(pricing, "EXCLUDED", {"gpt-5.9": "測試用理由"})
    _, codex, notes, _, _ = sync.build_tables(UPSTREAM)
    assert "gpt-5.9" not in codex
    assert any("測試用理由" in n for n in notes)


def test_pinned_key_keeps_current_value_and_reports_upstream(monkeypatch):
    monkeypatch.setattr(pricing, "PINNED", {"claude-opus-9": "測試用釘價"})
    monkeypatch.setattr(sync.current, "CLAUDE_PRICING", {"claude-opus-9": (99.0, 999.0)})
    claude, _, notes, _, _ = sync.build_tables(UPSTREAM)
    assert claude["claude-opus-9"] == (99.0, 999.0)          # 不被上游覆寫
    assert any("測試用釘價" in n and "(5.0, 25.0)" in n for n in notes)   # 上游值仍報告出來


def test_pinned_key_absent_from_current_table_falls_back_to_upstream(monkeypatch):
    monkeypatch.setattr(pricing, "PINNED", {"claude-opus-9": "測試用釘價"})
    claude, _, notes, _, _ = sync.build_tables(UPSTREAM)
    assert claude["claude-opus-9"] == (5.0, 25.0)
    assert any("現有表沒有它" in n for n in notes)


def test_cache_multiplier_issues_reported_per_model():
    raw = {"claude-odd-9": _claude(1e-06, 5e-06, c5m=1.2e-06, cread=1e-07)}   # 5m 1.2× 非 1.25×
    _, _, _, _, issues = sync.build_tables(raw)
    assert "claude-odd-9" in issues
    assert any("1.2" in line for line in issues["claude-odd-9"])
    # 上游沒給的層不算不符（above_1hr 缺席），已給且吻合的層也不報
    assert not any("above_1hr" in line or "cache_read" in line
                   for line in issues["claude-odd-9"])


def test_rendered_table_is_importable_and_round_trips():
    claude, codex, _, _, _ = sync.build_tables(UPSTREAM)
    namespace: dict = {}
    exec(compile(sync.render_table(claude, codex), "pricing_table.py", "exec"), namespace)
    assert namespace["CLAUDE_PRICING"] == claude
    assert namespace["CODEX_PRICING"] == codex
    assert namespace["TABLE_VERSION"].count(".") == 1


def test_table_version_tracks_content_not_time():
    claude, codex, _, _, _ = sync.build_tables(UPSTREAM)
    same = sync.render_table(claude, codex)
    assert sync.render_table(dict(claude), dict(codex)) == same    # 同內容 → 同版本
    changed = sync.render_table({**claude, "claude-opus-9": (1.0, 2.0)}, codex)
    assert _version_of(changed) != _version_of(same)               # 改一個價 → 版本必變


def _version_of(rendered: str) -> str:
    for line in rendered.splitlines():
        if line.startswith("TABLE_VERSION"):
            return line
    raise AssertionError("渲染結果沒有 TABLE_VERSION")

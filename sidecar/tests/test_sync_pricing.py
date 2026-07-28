"""admin/sync_pricing.py 的表建構與渲染（不連外、不掃本機用量）。

腳本在 sidecar 套件外，故以 importlib 由路徑載入。
"""
import importlib.util
import sys
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
    claude, codex, _, conflicts = sync.build_tables(UPSTREAM)
    assert conflicts == []
    # 日期版併入裸 key；provider 前綴/路徑/`:` 版本尾綴全濾掉，故區域價不會蓋掉第一方價
    assert claude == {"claude-opus-9": (5.0, 25.0, 6.25, 10.0, 0.5)}
    assert set(codex) == {"gpt-5.9", "gpt-5.9-pro", "gpt-5.9-mini"}
    assert "gpt-4o" not in codex and "claude-noprice" not in claude


def test_missing_cached_price_falls_back_to_input_not_free():
    _, codex, _, _ = sync.build_tables(UPSTREAM)
    # 上游填 0 與整個沒有該欄，都代表「未提供」——當免費會低估，故退回 input 價
    assert codex["gpt-5.9"] == (5.0, 5.0, 30.0)
    assert codex["gpt-5.9-pro"] == (30.0, 30.0, 180.0)
    # 有真值時照收
    assert codex["gpt-5.9-mini"] == (0.75, 0.075, 4.5)


def test_same_normalized_key_with_different_prices_is_a_conflict():
    raw = dict(UPSTREAM)
    raw["claude-opus-9-20260202"] = _claude(7e-06, 3.5e-05)   # 與裸 key 不同價
    _, _, _, conflicts = sync.build_tables(raw)
    assert any("claude-opus-9" in c for c in conflicts)


def test_excluded_key_never_enters_table(monkeypatch):
    monkeypatch.setattr(pricing, "EXCLUDED", {"gpt-5.9": "測試用理由"})
    _, codex, notes, _ = sync.build_tables(UPSTREAM)
    assert "gpt-5.9" not in codex
    assert any("測試用理由" in n for n in notes)


def test_pinned_value_wins_over_upstream_and_upstream_is_reported(monkeypatch):
    pinned = (99.0, 999.0, 123.75, 198.0, 9.9)
    monkeypatch.setattr(pricing, "PINNED", {"claude-opus-9": (pinned, "測試用釘價")})
    claude, _, notes, _ = sync.build_tables(UPSTREAM)
    assert claude["claude-opus-9"] == pinned                 # 不被上游覆寫
    # 上游值仍報告出來供複核——釘住不等於不看上游
    assert any("測試用釘價" in n and "(5.0, 25.0, 6.25, 10.0, 0.5)" in n for n in notes)


def test_pinned_value_with_wrong_arity_is_refused_not_silently_used(monkeypatch):
    """表的欄位數改過而 PINNED 忘了跟上時，不得寫進長度不對的 tuple（runtime 解包會炸）。"""
    monkeypatch.setattr(pricing, "PINNED", {"claude-opus-9": ((99.0, 999.0), "欄位數過時")})
    claude, _, notes, _ = sync.build_tables(UPSTREAM)
    assert claude["claude-opus-9"] == (5.0, 25.0, 6.25, 10.0, 0.5)   # 改採上游值
    assert any("欄位數不符" in n for n in notes)


def test_claude_cache_layers_use_upstream_price_and_derive_only_what_is_missing():
    """cache 存真價：上游給了就照收（哪怕不是 1.25×），沒給的層才用倍率推導。"""
    claude, _, _, _ = sync.build_tables({
        # 5m 是 1.2×（claude-3-haiku 的真實情況）、read 給 0.1×、1h 完全沒給
        "claude-odd-9": _claude(1e-06, 5e-06, c5m=1.2e-06, cread=1e-07),
    })
    assert claude["claude-odd-9"] == (1.0, 5.0, 1.2, 2.0, 0.1)
    #                                        ↑ 上游真價   ↑ 缺 → 由 2× 推導


def test_empty_or_non_mapping_upstream_is_refused(tmp_path):
    """合法但殘缺的 JSON 不得生出空表整檔覆蓋（Codex 審查 finding #1）。"""
    for payload in ("{}", "[]", "null"):
        snapshot = tmp_path / "upstream.json"
        snapshot.write_text(payload, encoding="utf-8")
        with pytest.raises(ValueError):
            sync.fetch_upstream(str(snapshot))


def test_missing_or_nonfinite_price_is_refused():
    """缺 output 價會被 _mtok 轉成 0.0＝output token 免費，是最貴那欄的靜默低估。"""
    claude, codex, _, _ = sync.build_tables({
        "claude-broken-9": {"input_cost_per_token": 5e-06},              # 缺 output
        "gpt-5.9-broken": {"input_cost_per_token": 5e-06,
                           "output_cost_per_token": float("inf")},
    })
    bad = sync.invalid_prices(claude, codex)
    assert any("claude-broken-9" in line for line in bad)
    assert any("gpt-5.9-broken" in line for line in bad)
    # 正常表不得誤報
    ok_claude, ok_codex, _, _ = sync.build_tables(UPSTREAM)
    assert sync.invalid_prices(ok_claude, ok_codex) == []


def test_rendered_table_is_importable_and_round_trips():
    claude, codex, _, _ = sync.build_tables(UPSTREAM)
    namespace: dict = {}
    exec(compile(sync.render_table(claude, codex), "pricing_table.py", "exec"), namespace)
    assert namespace["CLAUDE_PRICING"] == claude
    assert namespace["CODEX_PRICING"] == codex
    assert namespace["TABLE_VERSION"].count(".") == 1


def test_table_version_tracks_content_not_time():
    claude, codex, _, _ = sync.build_tables(UPSTREAM)
    same = sync.render_table(claude, codex)
    assert sync.render_table(dict(claude), dict(codex)) == same    # 同內容 → 同版本
    changed = sync.render_table({**claude, "claude-opus-9": (1.0, 2.0, 1.25, 2.0, 0.1)}, codex)
    assert _version_of(changed) != _version_of(same)               # 改一個價 → 版本必變


def test_removing_existing_models_requires_explicit_flag(monkeypatch, tmp_path):
    """上游殘缺時表會整批縮水，而 diff 看起來只是「少了幾行」（Codex 審查 finding #1）。"""
    target = tmp_path / "pricing_table.py"
    monkeypatch.setattr(sync, "fetch_upstream", lambda local: UPSTREAM)
    monkeypatch.setattr(sync, "TABLE_PATH", target)
    monkeypatch.setattr(sync.current, "CLAUDE_PRICING",
                        {"claude-gone-9": (1.0, 2.0, 1.25, 2.0, 0.1)})

    monkeypatch.setattr(sys, "argv", ["sync_pricing.py", "--no-check-local"])
    assert sync.main() == 1
    assert not target.exists()          # 擋下時不得留下半套的表

    monkeypatch.setattr(sys, "argv", ["sync_pricing.py", "--no-check-local", "--allow-removals"])
    assert sync.main() == 0
    assert "claude-opus-9" in target.read_text(encoding="utf-8")


def test_write_happens_only_after_all_blocking_checks(monkeypatch, tmp_path):
    """整檔覆蓋是破壞性的：價格不合法時不得先寫檔再回報（Codex 審查 finding #1）。"""
    target = tmp_path / "pricing_table.py"
    monkeypatch.setattr(sync, "fetch_upstream",
                        lambda local: {"claude-broken-9": {"input_cost_per_token": 5e-06}})
    monkeypatch.setattr(sync, "TABLE_PATH", target)
    monkeypatch.setattr(sys, "argv", ["sync_pricing.py", "--no-check-local"])
    assert sync.main() == 1
    assert not target.exists()


def _version_of(rendered: str) -> str:
    for line in rendered.splitlines():
        if line.startswith("TABLE_VERSION"):
            return line
    raise AssertionError("渲染結果沒有 TABLE_VERSION")

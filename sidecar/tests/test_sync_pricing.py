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
                "output_cost_per_token": 3e-05, "mode": "chat"},
    "gpt-5.9-pro": {"input_cost_per_token": 3e-05, "output_cost_per_token": 1.8e-04,
                    "mode": "responses"},
    "gpt-5.9-mini": {"input_cost_per_token": 7.5e-07, "cache_read_input_token_cost": 7.5e-08,
                     "output_cost_per_token": 4.5e-06, "mode": "chat"},
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


def test_new_codex_generation_is_collected_not_silently_skipped():
    """收錄前綴寫死世代號，新世代發布時會被靜默略過（gpt-6-astra 的實況）。

    但不能放寬成 `gpt-`：那會把 gpt-4o／音訊／圖像／embedding 一起吃進來——Codex 不跑
    那些款，而它們的價格欄位形狀不同（常缺 output），會讓 invalid_prices 擋掉整檔寫入。
    """
    _, codex, _, _ = sync.build_tables({
        "gpt-6-astra": {"input_cost_per_token": 1e-05, "cache_read_input_token_cost": 1e-06,
                        "output_cost_per_token": 5e-05, "mode": "chat"},
        "gpt-4o": {"input_cost_per_token": 2.5e-06, "output_cost_per_token": 1e-05,
                   "mode": "chat"},
    })
    assert codex["gpt-6-astra"] == (10.0, 1.0, 50.0)
    assert "gpt-4o" not in codex


def test_missing_model_explanation_distinguishes_its_four_causes(monkeypatch):
    """查無定價的原因有四種，該做的事完全不同——寫死成「上游也還沒收錄」會把人導錯方向。

    EXCLUDED 是刻意排除（別動前綴）、前綴沒涵蓋是我們的問題（改前綴）、上游缺價欄
    無從計價、上游真的沒有才是等上游。EXCLUDED 必須優先於前綴判定，否則刻意排除的款
    會被說成「前綴漏收」。
    """
    monkeypatch.setattr(pricing, "EXCLUDED", {"gpt-5.9": "測試用：刻意排除"})
    raw = {
        "gpt-5.9": {"input_cost_per_token": 5e-06, "output_cost_per_token": 3e-05},
        "gpt-7-nova": {"input_cost_per_token": 1e-05},        # 上游有，收錄前綴沒涵蓋
        "gpt-5.8": {"output_cost_per_token": 3e-05},          # 上游有，但缺 input 價
    }
    assert "EXCLUDED" in sync.explain_missing("gpt-5.9", raw)
    assert "_CODEX_KEY_RE" in sync.explain_missing("gpt-7-nova", raw)
    assert "缺 input 價" in sync.explain_missing("gpt-5.8", raw)
    assert sync.explain_missing("codex-auto-review", raw) == "上游也還沒收錄"


def test_codex_prefix_requires_a_generation_boundary():
    """字首比對要有世代邊界，否則 gpt-60／gpt-6a 這種不同世代也會被收進來。"""
    _, codex, _, _ = sync.build_tables({
        "gpt-6-astra": {"input_cost_per_token": 1e-05, "output_cost_per_token": 5e-05,
                        "mode": "chat"},
        "gpt-5.6-sol": {"input_cost_per_token": 4e-06, "output_cost_per_token": 2e-05,
                        "mode": "chat"},
        "gpt-60-hypothetical": {"input_cost_per_token": 1e-06, "output_cost_per_token": 2e-06,
                                "mode": "chat"},
        "gpt-6a-nonsense": {"input_cost_per_token": 1e-06, "output_cost_per_token": 2e-06,
                            "mode": "chat"},
    })
    assert set(codex) == {"gpt-6-astra", "gpt-5.6-sol"}


_AUDIO = {"gpt-6-audio-preview": {"input_cost_per_token": 1e-06,
                                  "output_cost_per_token": 2e-06,
                                  "mode": "audio_transcription"}}


def test_non_text_products_are_excluded_by_declared_mode():
    """名字看不出「是不是 Codex 會跑的款」。

    Codex CLI 記錄的是 gpt-5.5、gpt-5.6-sol 這種純模型名，沒有 -codex 字樣，所以任何
    名字 allowlist 都得追 OpenAI 每次出的 tier，漏列＝使用者實際在用的款不計成本。
    改用上游自帶的 mode 分辨產品類型，且是 fail-closed：缺漏或不認得的 mode 一律不收。
    放行未知等於讓上游 schema 漂移把非文字產品無聲收進表，日後以文字 token 三元組
    算出錯帳；擋下來則是看得見的失敗（面板警示 ＋ explain_missing 說明原因）。
    """
    _, codex, notes, _ = sync.build_tables({
        "gpt-6-astra": {"input_cost_per_token": 1e-05, "output_cost_per_token": 5e-05,
                        "mode": "chat"},
        "gpt-6-thinky": {"input_cost_per_token": 1e-05, "output_cost_per_token": 5e-05,
                         "mode": "responses"},
        "gpt-6-nomode": {"input_cost_per_token": 1e-06, "output_cost_per_token": 2e-06},
        **_AUDIO,
    })
    assert set(codex) == {"gpt-6-astra", "gpt-6-thinky"}
    # 擋掉要出聲，否則「表裡怎麼少一款」無從查起
    assert any("gpt-6-audio-preview" in n and "audio_transcription" in n for n in notes)
    assert any("gpt-6-nomode" in n and "None" in n for n in notes)


def test_missing_model_explanation_covers_the_mode_filter():
    """被 mode 擋掉的款若出現在本機用量，訊息要指向 mode，不能落到「非預期」。"""
    reason = sync.explain_missing("gpt-6-audio-preview", _AUDIO)
    assert "mode" in reason and "audio_transcription" in reason


def test_missing_model_explanation_ignores_keys_the_table_never_considers():
    """診斷必須用與建表相同的候選，否則同名的日期版會把判定推進「非預期」分支。

    Codex 第二輪 finding 2 的情境：有價的非文字款被 mode 擋掉，同名日期版缺 input 價
    （建表根本不看它）。若把兩者一起聚合，mode 集合含 None 會讓判定失敗，訊息就變成
    「通過收錄條件卻沒進表 → 請查 build_tables」，把人導向錯的地方。
    """
    raw = dict(_AUDIO)
    raw["gpt-6-audio-preview-2026-09-01"] = {"output_cost_per_token": 2e-06}   # 缺 input 價
    assert sync._normalized_name("gpt-6-audio-preview-2026-09-01") == "gpt-6-audio-preview"
    reason = sync.explain_missing("gpt-6-audio-preview", raw)
    assert "audio_transcription" in reason
    assert "非預期" not in reason


def test_missing_codex_cached_price_is_derived_not_free_and_not_input(monkeypatch):
    """缺值一律按 0.1× 推導（Codex 審查 round 4）。

    留 0 會把 cached token 當免費＝低估；退回 input 價則讓「上游剛好有值」與
    「上游剛好沒值」的同 tier 模型差 10 倍——官方對四個 pro 同樣標「—」，
    差異來自資料缺漏而非定價。
    """
    _, codex, _, _ = sync.build_tables(UPSTREAM)
    assert codex["gpt-5.9"] == (5.0, 0.5, 30.0)          # 上游填 0
    assert codex["gpt-5.9-pro"] == (30.0, 3.0, 180.0)     # 上游整個沒有該欄
    assert codex["gpt-5.9-mini"] == (0.75, 0.075, 4.5)    # 上游有真值 → 照收


def test_codex_cached_price_is_kept_however_far_from_the_multiplier():
    """Codex 側套用同一條規則：上游正數照收，不因偏離 0.1× 就被覆寫。"""
    _, codex, notes, _ = sync.build_tables({
        "gpt-5.9": {"input_cost_per_token": 5e-06, "cache_read_input_token_cost": 4e-06,
                    "output_cost_per_token": 3e-05, "mode": "chat"},
    })
    assert codex["gpt-5.9"][1] == 4.0              # 上游值（0.8× input），非 0.5
    assert not any("非有限正數" in n for n in notes)


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


def test_positive_upstream_cache_price_is_kept_however_far_from_the_multiplier():
    """上游給的有限正數一律照收，不再用比例猜測覆寫（Codex 第二輪 high finding）。

    原本「偏離標準倍率逾 2 倍就視同損壞」分不出資料錯誤與供應商合法調價：
    Fable 5.1 把 cache read 降到 0.025× 就被它當成損壞、改寫成 4 倍估價還照常寫檔。
    立案依據（claude-3-haiku 的 24×、claude-3-opus 的 0.4×）上游已修正，實測開關它
    對現行表零影響。刻意偏離上游改走 PINNED／EXCLUDED——那是人決定且寫得出理由的。
    """
    claude, _, notes, _ = sync.build_tables({
        "claude-far-hi": _claude(2.5e-07, 1.25e-06, c1h=6e-06),    # 1h = 24× input
        "claude-far-lo": _claude(1.5e-05, 7.5e-05, c1h=6e-06),     # 1h = 0.4× input
        "claude-cheapread": _claude(1e-05, 5e-05, cread=2.5e-07),  # read = 0.025×
    })
    assert claude["claude-far-hi"][3] == 6.0       # 上游值，非 2× 推導的 0.5
    assert claude["claude-far-lo"][3] == 6.0       # 上游值，非 2× 推導的 30.0
    assert claude["claude-cheapread"][4] == 0.25   # 上游值，非 0.1× 推導的 1.0
    assert not any("非有限正數" in n for n in notes)


def test_nonpositive_upstream_cache_price_is_derived_and_flagged():
    """非有限正數是真的壞掉——這不是猜的。改用估價並要人去看上游。"""
    claude, _, notes, _ = sync.build_tables({
        "claude-bad-9": _claude(1e-06, 5e-06, c5m=-1e-06),
    })
    assert claude["claude-bad-9"][2] == 1.25       # 1.25× input 的估價
    assert any("非有限正數" in n and "claude-bad-9" in n for n in notes)



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
        "gpt-5.9-broken": {"input_cost_per_token": 5e-06, "mode": "chat",
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


def test_price_change_line_shows_old_and_new_values(monkeypatch, tmp_path, capsys):
    """改價要看得出改成什麼（Codex 第三輪 finding 的實際防線）。

    砍掉比例猜測後，「上游把某款的價寫壞」的防線是寫檔前的人工審查——腳本自己就說
    「請審 git diff 後 commit」，而 main() 會把價格變動列成「改價」清單。但只印模型名的話，
    12 倍的錯價與四捨五入的差異長得一模一樣，人根本審不出來。要讓這道防線真的成立，
    就得把舊值與新值一起印出來。這不是新增護欄，是讓既有的人工關卡可用。
    """
    monkeypatch.setattr(sync, "fetch_upstream", lambda local: UPSTREAM)
    monkeypatch.setattr(sync, "TABLE_PATH", tmp_path / "pricing_table.py")
    monkeypatch.setattr(sync.current, "CLAUDE_PRICING",
                        {"claude-opus-9": (5.0, 25.0, 6.25, 0.5, 0.5)})   # 1h 舊值 0.5
    monkeypatch.setattr(sys, "argv",
                        ["sync_pricing.py", "--no-check-local", "--dry-run", "--allow-removals"])
    assert sync.main() == 0
    out = capsys.readouterr().out
    assert "改價 claude-opus-9" in out
    assert "(5.0, 25.0, 6.25, 0.5, 0.5)" in out        # 舊值
    assert "(5.0, 25.0, 6.25, 10.0, 0.5)" in out       # 新值，20 倍的差異一眼看得到


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

"""admin/derive_theme.py：從午夜藍推導其他主題、跟 src/index.css 逐條比對（票 37）。

腳本在 sidecar 套件外，故以 importlib 由路徑載入（同 test_sync_pricing.py）。
負對照（改壞一份 CSS 副本、check 要點名）每條都先寫、先看它紅在斷言，再補 check 對應的那段判斷（spec §5）。
"""
import importlib.util
import re
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("derive_theme", _REPO / "admin" / "derive_theme.py")
dt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dt)

CSS = (_REPO / "src" / "index.css").read_text(encoding="utf-8")
NF = ':root, [data-theme="nightfall"]'


def _in_block(css, selector, pattern, repl):
    """只在那一塊裡改：pattern 在那一塊必須恰好出現一次（不會改到別的主題）。"""
    start = css.index(selector + " {")
    end = css.index("}", start)
    block, n = re.subn(pattern, repl, css[start:end])
    if n != 1:   # 丟例外、不用 assert：改錯地方要顯示成例外，不能被當成「紅在斷言」
        raise ValueError((selector, pattern, n))
    return css[:start] + block + css[end:]


def _block_text(css, selector):
    start = css.index(selector + " {")
    return css[start:css.index("}", start) + 1]


def test_real_css_matches():
    assert dt.check_css(CSS) == []


# 淺色配方的 primary（主色換成指定色，spec docs/superpowers/specs/2026-10-03-cherry-blossom-theme-design.md §3.2）。
# 期望值寫字面、不在測試裡重算同一條公式：test_real_css_matches 只比「推導＝CSS」，規則寫錯後重產 CSS 時兩邊一起錯而全綠，
# 這條把規則的輸出釘在 spec 附錄 A
def test_primary_recipe_literals():
    t = dt.derive("daylight-cherry", dt.nightfall_tokens(dt.strip_comments(CSS)))
    assert {k: t[k] for k in ("--primary", "--primary-ink", "--focus", "--primary-text")} == {
        "--primary": "#FBCEE1", "--primary-ink": "#3C1C2C",
        "--focus": "color-mix(in srgb, #FA8BC0 60%, transparent)", "--primary-text": "#7D5768"}


# 推導不改傳進來的基準（check_css 對每個配方共用同一份 nf，Codex spec R1），沒寫 primary 的配方照抄午夜藍。
# 用同一份 nf 先推櫻花粉、再推其他淺色；期望值從 CSS 重新讀一份，不用那份 nf
def test_primary_does_not_leak():
    nf = dt.nightfall_tokens(dt.strip_comments(CSS))
    before = dict(nf)
    dt.derive("daylight-cherry", nf)
    assert nf == before
    fresh = dt.nightfall_tokens(dt.strip_comments(CSS))
    keys = ("--primary", "--primary-ink", "--focus")
    for theme in ("daylight-cool", "daylight-warm"):
        t = dt.derive(theme, nf)
        assert [t[k] for k in keys] == [fresh[k] for k in keys], theme


def test_cli_check_ok(capsys):
    assert dt.main(["check"]) == 0
    assert capsys.readouterr().out.splitlines()[-1] == "OK"


def test_cli_check_mismatch(tmp_path, monkeypatch, capsys):
    p = tmp_path / "index.css"
    p.write_text(_in_block(CSS, ':root[data-theme="daylight-cool"]', re.escape("--term-cursor-accent: #EDF0F6;"),
                           "--term-cursor-accent: #FFFFFF;"), encoding="utf-8")
    monkeypatch.setattr(dt, "CSS_PATH", p)
    assert dt.main(["check"]) == 1
    assert "MISMATCH" in capsys.readouterr().out


@pytest.mark.parametrize("theme", list(dt.RECIPES))
def test_one_changed_value_is_named(theme):
    css = _in_block(CSS, dt.theme_selector(theme), r"--bg: #[0-9A-F]{6};", "--bg: #123456;")
    problems = dt.check_css(css)
    assert len(problems) == 1 and problems[0].startswith(f"{theme} --bg："), problems


def test_missing_block_is_named():
    css = CSS.replace(_block_text(CSS, ':root[data-theme="daylight-warm"]'), "")
    assert any(p.startswith("daylight-warm") for p in dt.check_css(css))


def test_empty_css():
    assert dt.check_css("") != []


def test_print_block(capsys):
    assert dt.main(["nightfall-iron"]) == 0
    assert ':root[data-theme="nightfall-iron"] {' in capsys.readouterr().out


def test_nightfall_is_not_derived():
    assert dt.main(["nightfall"]) == 2


# ── 結構防線（spec §3.5 第 1、2、3、5、6 條）：每條先寫、先看它紅在斷言，再補 check 的判斷 ──
COOL = ':root[data-theme="daylight-cool"]'


def test_color_scheme_is_compared():
    problems = dt.check_css(_in_block(CSS, COOL, re.escape("color-scheme: light;"), "color-scheme: dark;"))
    assert any(p.startswith("daylight-cool color-scheme：") for p in problems), problems


@pytest.mark.parametrize("selector,label", [(NF, "nightfall"), (':root[data-theme="daylight-warm"]', "daylight-warm")])
def test_duplicated_block_is_named(selector, label):
    problems = dt.check_css(CSS + "\n" + _block_text(CSS, selector) + "\n")
    assert f"{label}：區塊出現 2 次（要恰好 1 次）" in problems, problems


def test_block_without_recipe_is_named():
    problems = dt.check_css(CSS + '\n:root[data-theme="no-recipe"] { color-scheme: dark; }\n')
    assert any(p.startswith("no-recipe：沒有配方") for p in problems), problems


def test_nonstandard_selector_is_named():
    # Codex spec R1：權重跟標準寫法相同、寫在後面就生效
    problems = dt.check_css(CSS + '\n[data-theme="daylight-cool"]:root { --term-cursor-accent: #056D5F; }\n')
    assert '非標準的 data-theme 選擇器：[data-theme="daylight-cool"]:root' in problems, problems


@pytest.mark.parametrize("decl,name", [("--term-cursor-accent: #EDF0F6;", "--term-cursor-accent"),
                                       ("color-scheme: light;", "color-scheme")])
def test_repeated_declaration_is_named(decl, name):
    # 值跟原宣告相同：只有「重複」這一點不合格
    problems = dt.check_css(_in_block(CSS, COOL, re.escape(decl), decl + " " + decl))
    assert f"daylight-cool：{name} 宣告了 2 次" in problems, problems


def test_important_in_nightfall_is_named():
    # Codex spec R3：午夜藍的值不比對、推導主題的輸出也不變，但它同時掛在 :root，!important 會蓋過每個主題
    css = _in_block(CSS, NF, re.escape("--session-text: var(--session);"), "--session-text: var(--session) !important;")
    assert "nightfall：不合格的宣告 '--session-text: var(--session) !important'" in dt.check_css(css)


def test_nested_rule_keeps_outer_selector():
    # Codex plan R1：CSS nesting 合法；只抓最內層規則的話，外層的非標準選擇器整個被丟掉、check 回空清單
    problems = dt.check_css(CSS + '\n[data-theme="daylight-cool"]:root { --term-cursor-accent: #056D5F; '
                                  '@media (min-width: 0px) { --term-bg: #EDF0F6; } }\n')
    assert '非標準的 data-theme 選擇器：[data-theme="daylight-cool"]:root' in problems, problems


def test_nested_content_in_theme_block_is_named():
    css = _in_block(CSS, COOL, re.escape("--term-cursor-accent: #EDF0F6;"),
                    "--term-cursor-accent: #EDF0F6; @media (min-width: 0px) { --term-bg: #FFFFFF; }")
    problems = dt.check_css(css)
    assert any(p.startswith("daylight-cool：不合格的宣告 '@media") for p in problems), problems


def test_theme_block_inside_at_rule_is_named():
    warm = _block_text(CSS, ':root[data-theme="daylight-warm"]')
    problems = dt.check_css(CSS.replace(warm, "@media (min-width: 9999px) {\n" + warm + "\n}"))
    assert "daylight-warm：主題區塊要寫在最外層，不能包在 @media 等 @ 規則裡" in problems, problems


def test_data_theme_in_nested_rule_is_named():
    problems = dt.check_css(CSS + '\n.app { [data-theme="daylight-cool"] & { --term-bg: #FFFFFF; } }\n')
    assert "data-theme 出現在最外層選擇器以外的地方 1 處（例如巢狀子規則或 @ 規則的條件裡）" in problems, problems


WARM_OPEN = ':root[data-theme="daylight-warm"] {'


def _before_warm(css, text):
    if css.count(WARM_OPEN) != 1:   # 同 _in_block：對不到錨點要顯示成例外
        raise ValueError(WARM_OPEN)
    return css.replace(WARM_OPEN, text + "\n" + WARM_OPEN)


def test_stray_text_before_selector_is_named():
    # Codex plan R2：選擇器前面誤留一條宣告，瀏覽器會讓整塊失效（柔潤黃退回午夜藍）；不能略過分號前的文字
    problems = dt.check_css(_before_warm(CSS, "--orphan: red;"))
    assert any(p.startswith("非標準的 data-theme 選擇器：--orphan: red;") for p in problems), problems


@pytest.mark.parametrize("statement,at_top", [('@import url("fonts.css");', True), ("@layer base, components;", False)],
                         ids=["import", "layer"])
def test_semicolon_at_statement_is_unsupported(statement, at_top):
    # Codex plan R4（選 B）：分號式 @ 敘述一律不支援、直接點名。「怎麼略過它」連三輪各打一個方向，而 index.css 現況 0 處。
    # 放棄的保證：合法的 @import／@layer a, b; 寫進 src/index.css 也會被判不一致（其他 CSS 檔不受影響）
    css = statement + "\n" + CSS if at_top else _before_warm(CSS, statement)
    problems = dt.check_css(css)
    assert any(p.startswith("不支援分號式的 @ 敘述") for p in problems), problems


@pytest.mark.parametrize("prefix", ["@layer base(", "@layer base(;", "@layer base[", ".x:is(", '@import "x'],
                         ids=["paren", "paren-semicolon", "bracket", "selector-paren", "quote"])
def test_unclosed_delimiter_is_named(prefix):
    # Codex plan R5：檔首多一個沒寫完的 `@layer base(`，瀏覽器把後面整份吞掉（jsdom 解析出 0 條規則），
    # 只靠大括號切規則的話 check 照樣印 OK。這一類一次用「整份檔的括號與引號要配對」擋掉；
    # paren-semicolon 是 R4 的假綠例子（只認分號結尾的正規式看不懂括號）
    problems = dt.check_css(prefix + "\n" + CSS)
    assert any(p.startswith("src/index.css 的括號或引號沒有配對好") for p in problems), problems


def test_braces_inside_parens_are_named():
    # Codex plan R6：檔首 `@layer base(`、檔尾 `)`——括號配對完整，但整份 CSS 都在圓括號裡（jsdom 解析出 0 條規則），
    # 只靠大括號切規則的話照樣印 OK
    problems = dt.check_css("@layer base(\n" + CSS + "\n)")
    assert any(p.startswith("src/index.css 的括號或引號沒有配對好（大括號出現在") for p in problems), problems


@pytest.mark.parametrize("extra,expected", [
    (':root[data-Theme="daylight-cool"] { --term-cursor-accent: #056D5F; }',
     '非標準的 data-theme 選擇器：:root[data-Theme="daylight-cool"]'),
    ('.app { [DATA-THEME="daylight-cool"] & { --term-bg: #FFFFFF; } }', "data-theme 出現在最外層選擇器以外的地方 1 處"),
], ids=["selector", "nested"])
def test_mixed_case_data_theme_is_named(extra, expected):
    # Codex plan R7：HTML 的屬性名稱不分大小寫，data-Theme 一樣生效（jsdom 實測，游標上的字跟游標同色）；
    # 這是合法 CSS、大小寫手誤就會出現，辨識與清點都要不分大小寫
    problems = dt.check_css(CSS + "\n" + extra + "\n")
    assert any(p.startswith(expected) for p in problems), problems


def test_missing_middle_semicolon_is_named():
    # Codex plan R8：午夜藍中段漏一個分號，下一條宣告被併進值裡（--session-text 消失）；午夜藍的值不比對、
    # 推導主題又重算這兩格，只有「值裡不准有冒號」擋得到
    css = _in_block(CSS, NF, re.escape("--primary-text: var(--primary);"), "--primary-text: var(--primary)")
    problems = dt.check_css(css)
    assert any(p.startswith("nightfall：不合格的宣告 '--primary-text: var(--primary) --session-text") for p in problems), problems


def test_deleted_nightfall_declaration_is_named():
    # 刪掉午夜藍的一條宣告：推導主題自己算 --session-text、CSS 也有，兩邊照樣一致，午夜藍卻少了那格
    css = _in_block(CSS, NF, re.escape("--session-text: var(--session);"), "")
    assert "nightfall：少了 --session-text（推導主題都有這格，token 集合照午夜藍）" in dt.check_css(css)


@pytest.mark.parametrize("ch", ["\u3000", "\u00a0"], ids=["fullwidth-space", "nbsp"])
def test_non_css_whitespace_before_declaration_is_named(ch):
    # Codex plan R9：中文輸入或貼上時多一個全形空白／NBSP，CSS 不把它當空白、那條宣告整條失效
    # （jsdom 實測冷調灰的游標字色退回 #000000）；Python 的 \s 與 strip() 卻會吞掉它
    css = _in_block(CSS, COOL, re.escape("--term-cursor-accent: #EDF0F6;"), ch + "--term-cursor-accent: #EDF0F6;")
    problems = dt.check_css(css)
    assert any(p.startswith("daylight-cool：含 CSS 不認得的字元") for p in problems), problems


def test_non_css_whitespace_before_selector_is_named():
    # 同一類落在選擇器前面：整塊柔潤黃失效，strip() 卻會把選擇器還原成標準寫法
    problems = dt.check_css(_before_warm(CSS, "\u3000"))
    assert any(p.startswith("非標準的 data-theme 選擇器：\u3000") for p in problems), problems


def test_missing_last_semicolon_is_named():
    # Codex spec R4：把午夜藍的 color-scheme 移到最後、拿掉分號——不重複、不改值，只有結尾殘留
    css = _in_block(CSS, NF, re.escape("color-scheme: dark;"), "")
    css = _in_block(css, NF, re.escape("--term-bright-white:#F1F4F9;"), "--term-bright-white:#F1F4F9;\n  color-scheme: dark")
    assert "nightfall：最後一個分號之後還有 'color-scheme: dark'" in dt.check_css(css)


@pytest.mark.parametrize("theme", list(dt.RECIPES))
def test_printed_block_pastes_back(theme):
    # 新增主題的流程是「印區塊、整塊貼進 src/index.css」：印出來的格式要過得了白名單、比對得一致
    nf = dt.nightfall_tokens(dt.strip_comments(CSS))
    css = CSS.replace(_block_text(CSS, dt.theme_selector(theme)), dt.render_block(theme, dt.derive(theme, nf)))
    assert dt.check_css(css) == []


def test_backslash_outside_string_is_named():
    # Codex 最終審查 R1：檔首共用 :root 的結尾 } 誤打成 \}，CSS 把它當跳脫字元、那一塊沒有結束，
    # 瀏覽器把後面整份吞進去（jsdom 實測規則從 10 條剩 1 條），這裡照原始字元切規則卻印 OK
    anchor = "--item-py: 7px;\n}"
    if CSS.count(anchor) != 1:   # 丟例外、不用 assert：錨點不對要顯示成例外
        raise ValueError(anchor)
    problems = dt.check_css(CSS.replace(anchor, "--item-py: 7px;\n\\}"))
    assert problems == ["src/index.css 的括號或引號沒有配對好（字串外有反斜線，CSS 跳脫會讓緊接的括號、引號不算數，"
                        "src/index.css 不支援）：瀏覽器會把後面整段吞掉，先修好語法再比對"], problems


def test_backslash_inside_string_is_allowed():
    # 不支援的只有字串外的反斜線；字串裡的跳脫（例如 content 的 Unicode 碼）照樣合格
    assert dt.check_css(CSS + '\n.x::before { content: "\\2014"; }\n') == []

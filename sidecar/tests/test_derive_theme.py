"""admin/derive_theme.py：從午夜藍推導四個主題、跟 src/index.css 逐條比對（票 37）。

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
    assert n == 1, (selector, pattern, n)
    return css[:start] + block + css[end:]


def _block_text(css, selector):
    start = css.index(selector + " {")
    return css[start:css.index("}", start) + 1]


def test_real_css_matches():
    assert dt.check_css(CSS) == []


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

"""主題色值推導工具（票 37，spec docs/superpowers/specs/2026-10-02-derive-theme-script-design.md）。

午夜藍以外的主題，色值都由這裡的規則從午夜藍推出來。要調色時改配方（RECIPES）或規則再重產，
不手改 src/index.css 的單格——票 07 的淺色在臨時腳本之後又被手調、腳本沒跟上，票 37 只好反推參數。

用法（只用 Python 內建模組，macOS 內建的 python3 3.9 就能跑）：
  python3 admin/derive_theme.py <主題代號>   印出該主題的整塊 CSS＋對比報告，不改任何檔案
  python3 admin/derive_theme.py check        逐條比對 src/index.css：一致印 OK（結束碼 0），
                                              不一致列出差異、印 MISMATCH（結束碼 1）
"""
import math
import re
import sys
from pathlib import Path

# admin/ 進 git，每個 worktree 有自己的一份，resolve() 不會跳回主目錄（同 admin/sync_pricing.py）
CSS_PATH = Path(__file__).resolve().parent.parent / "src" / "index.css"
NF_SELECTOR = ':root, [data-theme="nightfall"]'

# ── 配方：每個主題的輸入參數。規則在下面，這裡只放「這個主題選了什麼」 ─────────────────
# 深色：色票（sRGB）。淺色：色相、表面彩度、文字彩度、卡片（OKLCH 亮度, 彩度）、陰影底色（rgba 的 RGB）
RECIPES = {
    "nightfall-cocoa": {"scheme": "dark", "swatch": "#59443E"},   # Pantone Chocolate Martini
    "nightfall-iron": {"scheme": "dark", "swatch": "#766F69"},    # Pantone Hematite
    "daylight-cool": {"scheme": "light", "hue": 263, "c_surface": 0.008, "c_text": 0.030,
                      "card": (1.0, 0.0), "shade": "18,25,39"},
    "daylight-warm": {"scheme": "light", "hue": 75, "c_surface": 0.012, "c_text": 0.018,
                      "card": (0.996, 0.004), "shade": "40,30,18"},
}

SURFACES = ["--bg", "--sidebar", "--surface", "--surface-2", "--hover", "--active", "--term-bg", "--term-elev"]
INKS = ["--text", "--text-2", "--dim", "--faint"]
TEXT_BACKDROPS = ["--bg", "--sidebar", "--surface", "--surface-2", "--hover"]
ANSI_NEUTRAL = ["--term-black", "--term-bright-black", "--term-white", "--term-bright-white"]
ANSI_COLOR = [p + c for p in ("--term-", "--term-bright-") for c in ("red", "green", "yellow", "blue", "magenta", "cyan")]
FUNCTIONAL = ["primary", "session", "ai", "warning", "error"]
GLOW = "0 0 8px 0 color-mix(in srgb, var(--text) 6%, transparent)"


# ── 色彩計算：OKLCH ↔ sRGB、WCAG 對比 ──────────────────────────────────────────
# 搜尋的步長與方向是規則的一部分（spec §3.4）：改了結果會差一階
def hex2rgb(h):
    if not isinstance(h, str):
        return list(h)   # 已經是 0～1 的小數通道（mix 不取整）
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def rgb2hex(c):
    return "#" + "".join(f"{max(0, min(255, round(x * 255))):02X}" for x in c)


def _lin(x):
    return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4


def _delin(x):
    return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055


def _luminance(h):
    r, g, b = (_lin(x) for x in hex2rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted([_luminance(a), _luminance(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def to_oklch(h):
    r, g, b = (_lin(x) for x in hex2rgb(h))
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = (math.copysign(abs(v) ** (1 / 3), v) for v in (l, m, s))
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return L, math.hypot(A, B), math.degrees(math.atan2(B, A)) % 360


def _from_oklch(L, C, H):
    A = C * math.cos(math.radians(H))
    B = C * math.sin(math.radians(H))
    l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]


def oklch_hex(L, C, H):
    # 超出 sRGB 色域就降彩度（保色相、保亮度）
    c = C
    while c > 0 and not all(-1e-4 <= x <= 1 + 1e-4 for x in _from_oklch(L, c, H)):
        c -= 0.002
    return rgb2hex([_delin(max(0, min(1, x))) for x in _from_oklch(L, max(c, 0), H)])


def mix(a, b, p):
    # a 佔 p、b 佔 1-p，在 sRGB 的 0～1 數值上內插。回傳小數通道、不取整：取整會把貼著 4.5 的對比算成過關
    # （票 40 Codex 最終審查 R1：濃巧棕的 KMS 徽章照小數 4.4995、取整 4.5068）。src/testing/cssRules.ts 是同一條規則
    A, B = hex2rgb(a), hex2rgb(b)
    return [x * p + y * (1 - p) for x, y in zip(A, B)]


def lightest_passing(bg, target, C, H):
    # 淺底上的字：亮度從 1.0 往下，取第一個對 bg 夠 target 的（最淡但夠）
    L = 1.0
    while L > 0.0:
        h = oklch_hex(L, C, H)
        if contrast(h, bg) >= target:
            return h
        L -= 0.001
    return "#000000"


def darkest_passing(C, H, ok):
    # 深底上的字：亮度從 0 往上，取第一個符合條件的（最暗但夠）
    L = 0.0
    while L <= 1.0:
        h = oklch_hex(L, C, H)
        if ok(h):
            return h
        L += 0.001
    return oklch_hex(1.0, C, H)


def darken_to(hexc, bg, target):
    # 保色相、彩度，從原亮度往暗調到對 bg ≥ target
    L, C, H = to_oklch(hexc)
    while L > 0:
        h = oklch_hex(L, C, H)
        if contrast(h, bg) >= target:
            return h
        L -= 0.002
    return "#000000"


def lighten_to(hexc, bg, target):
    # 保色相、彩度，從原亮度往亮調到對 bg ≥ target
    L, C, H = to_oklch(hexc)
    while L <= 1.0:
        h = oklch_hex(L, C, H)
        if contrast(h, bg) >= target:
            return h
        L += 0.002
    return "#FFFFFF"


# ── 推導規則（spec §3.4）。nf＝午夜藍區塊的宣告；沒有規則的 token 照抄午夜藍 ───────────────
def derive_dark(nf, swatch):
    # 票 40 spec §3.2：表面亮度照午夜藍、色相取色票、彩度 × k，k 讓底色的灰度（C/L）等於色票的灰度
    t = dict(nf)
    sL, sC, sH = to_oklch(swatch)
    nL, nC, _ = to_oklch(nf["--bg"])
    k = sC * (nL / sL) / nC
    for s in SURFACES:
        L, C, _ = to_oklch(nf[s])
        t[s] = oklch_hex(L, C * k, sH)

    def worst(h):
        return min(contrast(h, t[b]) for b in TEXT_BACKDROPS)

    for ink in INKS:
        # 對 --bg 照抄午夜藍，且對五種文字底色都 ≥ 4.5（只照抄的話深鐵黑的 --faint 對 --surface-2 是 4.4991）
        _, C, _ = to_oklch(nf[ink])
        target = contrast(nf[ink], nf["--bg"])
        t[ink] = darkest_passing(C * k, sH, lambda h: contrast(h, t["--bg"]) >= target and worst(h) >= 4.5)
    for ink in ("--term-text", "--term-dim"):
        _, C, _ = to_oklch(nf[ink])
        target = contrast(nf[ink], nf["--term-bg"])
        t[ink] = darkest_passing(C * k, sH, lambda h: contrast(h, t["--term-bg"]) >= target)
    for a in ANSI_NEUTRAL:
        L, C, _ = to_oklch(nf[a])
        t[a] = oklch_hex(L, C * k, sH)
    for a in ANSI_COLOR:
        t[a] = nf[a] if contrast(nf[a], t["--term-bg"]) >= 4.5 else lighten_to(nf[a], t["--term-bg"], 4.5)
    for f in FUNCTIONAL:
        # 對「--X 18% 疊在 --active」≥ 4.5 就寫別名，否則保色相往亮調到剛好 4.5
        x = nf["--" + f]
        backdrop = mix(x, t["--active"], 0.18)
        t[f"--{f}-text"] = f"var(--{f})" if contrast(x, backdrop) >= 4.5 else lighten_to(x, backdrop, 4.5)
    # 遮罩：午夜藍的 rgba 換色相、彩度 × k，透明度照抄
    r, g, b, alpha = re.fullmatch(r"rgba\((\d+),(\d+),(\d+),([^)]+)\)", nf["--overlay"]).groups()
    oL, oC, _ = to_oklch([int(r) / 255, int(g) / 255, int(b) / 255])
    t["--overlay"] = "rgba(%d,%d,%d,%s)" % (*(round(x * 255) for x in hex2rgb(oklch_hex(oL, oC * k, sH))), alpha)
    t["color-scheme"] = "dark"
    return t


def derive_light(nf, r):
    # daylight spec §3.2 五條，加上審查手調、寫成規則的部分（spec §3.4 表中標 ＊ 的）
    H, Cn, Ct = r["hue"], r["c_surface"], r["c_text"]
    t = dict(nf)
    lightness = {"--surface": r["card"][0], "--sidebar": 0.977, "--bg": 0.962,
                 "--hover": 0.946, "--surface-2": 0.938, "--active": 0.912}
    chroma = {"--surface": r["card"][1], "--sidebar": Cn * 0.8, "--bg": Cn,
              "--hover": Cn * 1.3, "--surface-2": Cn * 1.3, "--active": Cn * 1.8}
    for s in lightness:
        t[s] = oklch_hex(lightness[s], chroma[s], H)
    for ink in INKS:
        t[ink] = lightest_passing(t["--bg"], contrast(nf[ink], nf["--bg"]), Ct, H)
    for f in FUNCTIONAL:
        x = nf["--" + f]
        t[f"--{f}-text"] = darken_to(x, mix(x, t["--active"], 0.18), 4.5)
    tb = oklch_hex(0.955, Cn, H)
    t["--term-bg"] = tb
    t["--term-elev"] = oklch_hex(0.975, Cn * 0.8, H)
    for ink in ("--term-text", "--term-dim"):
        t[ink] = lightest_passing(tb, contrast(nf[ink], nf["--term-bg"]), Ct, H)
    for a in ANSI_COLOR:
        t[a] = darken_to(nf[a], tb, 4.5)
    for a, target, c in (("--term-black", 12.0, Ct), ("--term-bright-black", 4.6, Ct * 0.8),
                         ("--term-white", 5.2, Ct * 0.5), ("--term-bright-white", 4.5, Ct * 0.5)):
        t[a] = lightest_passing(tb, target, c, H)
    t["--term-cursor"] = t["--session-text"]
    t["--term-cursor-accent"] = tb
    t["--term-min-contrast"] = "4.5"
    shade = lambda alpha: f"rgba({r['shade']},{alpha})"
    t["--overlay"] = shade(".32")
    t["--border"] = shade(".12")
    t["--divider"] = shade(".08")
    t["--shadow"] = f"{GLOW}, 0 1px 2px {shade('.06')}, 0 12px 32px {shade('.10')}"
    t["--shadow-sm"] = f"{GLOW}, 0 4px 14px {shade('.08')}"
    t["--modal-shadow"] = f"{GLOW}, 0 24px 60px {shade('.20')}"
    t["--term-border"] = shade(".10")
    t["--term-divider"] = shade(".07")
    t["color-scheme"] = "light"
    # 選取色只在淺色定義：--term-blue 30% 疊在 --term-bg，寫成畫出來的色碼（輸出的 token 值才取整），放在 --term-cursor-accent 之後
    selection = rgb2hex(mix(t["--term-blue"], tb, 0.30))
    out = {}
    for k, v in t.items():
        out[k] = v
        if k == "--term-cursor-accent":
            out["--term-selection"] = selection
    return out


def derive(theme, nf):
    r = RECIPES[theme]
    return derive_dark(nf, r["swatch"]) if r["scheme"] == "dark" else derive_light(nf, r)


# ── 讀 CSS、印區塊 ──────────────────────────────────────────────────────────────
RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}")
DECL_RE = re.compile(r"(--[a-z0-9-]+)\s*:\s*([^;]+);")


def strip_comments(css):
    # 換成一個空格、不直接刪：保留註解前後兩段的邊界（Codex spec R4）
    return re.sub(r"/\*.*?\*/", " ", css, flags=re.S)


def rules(css):
    # 最內層的每條規則 (選擇器, 內容)。@media 裡的規則也會被找到（外層的 @media 那一段不算選擇器）
    return [(s.strip(), b) for s, b in RULE_RE.findall(css)]


def declarations(body):
    return {k: re.sub(r"\s+", " ", v.strip()) for k, v in DECL_RE.findall(body)}


def theme_selector(theme):
    return f':root[data-theme="{theme}"]'


def render_block(theme, t):
    lines = [f"{theme_selector(theme)} {{", f"  color-scheme: {t['color-scheme']};"]
    for k, v in t.items():
        if k != "color-scheme":
            lines.append(f"  {k}: {v};")
    lines.append("}")
    return "\n".join(lines)


def nightfall_tokens(css):
    bodies = [b for s, b in rules(css) if s == NF_SELECTOR]
    return declarations(bodies[0]) if bodies else None


def check_css(css):
    # 回傳問題清單，空清單＝一致（spec §3.5）。午夜藍基準從同一份 css 讀，測試可以餵改過的 CSS
    css = strip_comments(css)
    nf = nightfall_tokens(css)
    if nf is None:
        return [f"nightfall：找不到午夜藍區塊（{NF_SELECTOR}）"]
    found = rules(css)
    problems = []
    for theme in RECIPES:
        got = {}
        for s, b in found:
            if s == theme_selector(theme):
                got.update(declarations(b))
        # 比的是印出來的區塊解析回來的結果：貼進 CSS 的是印出來的東西，漏印一條要被抓到
        exp = declarations(render_block(theme, derive(theme, nf)))
        for k in sorted(set(got) | set(exp)):
            if got.get(k) != exp.get(k):
                problems.append(f"{theme} {k}：CSS {got.get(k)!r}，推導 {exp.get(k)!r}")
    return problems


def report(theme, t):
    # 只給人看，不是關卡——對比的關卡是 vitest 的 index.contrast.test.ts 與規則層樣式測試
    lines = [f"== {theme} 的對比"]
    for ink in INKS:
        worst = min(contrast(t[ink], t[b]) for b in TEXT_BACKDROPS)
        lines.append(f"  {ink:22s} {t[ink]}  對 --bg {contrast(t[ink], t['--bg']):5.2f}  五種文字底最低 {worst:5.2f}")
    for f in FUNCTIONAL:
        v = t[f"--{f}-text"]
        ink = t["--" + f] if v.startswith("var(") else v
        lines.append(f"  --{f + '-text':20s} {v:14s} 對「--{f} 18% 疊 --active」{contrast(ink, mix(t['--' + f], t['--active'], 0.18)):5.2f}")
    for k in ["--term-text", "--term-dim"] + ANSI_NEUTRAL + ANSI_COLOR:
        lines.append(f"  {k:22s} {t[k]}  對 --term-bg {contrast(t[k], t['--term-bg']):5.2f}")
    if "--term-selection" in t:
        lines.append(f"  --term-selection       {t['--term-selection']}  --term-text 對它 {contrast(t['--term-text'], t['--term-selection']):5.2f}")
    return "\n".join(lines)


def main(argv):
    if argv == ["check"]:
        problems = check_css(CSS_PATH.read_text(encoding="utf-8"))
        for p in problems:
            print(p)
        print("MISMATCH" if problems else "OK")
        return 1 if problems else 0
    if len(argv) == 1 and argv[0] in RECIPES:
        nf = nightfall_tokens(strip_comments(CSS_PATH.read_text(encoding="utf-8")))
        if nf is None:
            print(f"找不到午夜藍區塊（{NF_SELECTOR}）", file=sys.stderr)
            return 1
        t = derive(argv[0], nf)
        print(render_block(argv[0], t))
        print()
        print(report(argv[0], t))
        return 0
    print("用法：python3 admin/derive_theme.py <主題代號> | check\n認得的主題代號：" + "、".join(RECIPES)
          + "（午夜藍 nightfall 是推導的基準，不推導）", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

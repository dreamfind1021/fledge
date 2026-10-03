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
# 深色：色票（sRGB）。淺色：色相、表面彩度、文字彩度、卡片（OKLCH 亮度, 彩度）、陰影底色（rgba 的 RGB）、主色（選填，見 derive_light）
RECIPES = {
    "nightfall-cocoa": {"scheme": "dark", "swatch": "#59443E"},   # Pantone Chocolate Martini
    "nightfall-iron": {"scheme": "dark", "swatch": "#766F69"},    # Pantone Hematite
    "daylight-cool": {"scheme": "light", "hue": 263, "c_surface": 0.008, "c_text": 0.030,
                      "card": (1.0, 0.0), "shade": "18,25,39"},
    "daylight-warm": {"scheme": "light", "hue": 75, "c_surface": 0.012, "c_text": 0.018,
                      "card": (0.996, 0.004), "shade": "40,30,18"},
    # 色相取使用者給的色票 #FBCEE1（Mac 螢幕截圖 Display P3 換算），主色就是色票本身
    "daylight-cherry": {"scheme": "light", "hue": 351, "c_surface": 0.030, "c_text": 0.020,
                        "card": (0.996, 0.004), "shade": "45,24,35", "primary": "#FBCEE1"},
}

SURFACES = ["--bg", "--sidebar", "--surface", "--surface-2", "--hover", "--active", "--term-bg", "--term-elev"]
INKS = ["--text", "--text-2", "--dim", "--faint"]
TEXT_BACKDROPS = ["--bg", "--sidebar", "--surface", "--surface-2", "--hover"]
ANSI_NEUTRAL = ["--term-black", "--term-bright-black", "--term-white", "--term-bright-white"]
ANSI_COLOR = [p + c for p in ("--term-", "--term-bright-") for c in ("red", "green", "yellow", "blue", "magenta", "cyan")]
FUNCTIONAL = ["primary", "session", "ai", "warning", "error"]
GLOW = "0 0 8px 0 color-mix(in srgb, var(--text) 6%, transparent)"
LIGHT_ONLY = {"--term-selection"}   # 只在淺色定義的 token，同 src/index.contrast.test.ts 的 LIGHT_ONLY
# CSS 認得的空白只有這幾個。Python 的 strip() 與 \s 還會吞掉全形空白（U+3000）、NBSP（U+00A0），瀏覽器卻把它們當一般字元，
# 宣告或選擇器前多一個就整條失效（Codex plan R9）
CSS_WS = " \t\r\n\f"


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
    if "primary" in r:
        # 主色換成指定色（spec docs/superpowers/specs/2026-10-03-cherry-blossom-theme-design.md §3.2）。先複製再換：
        # check_css 對每個配方共用同一份 nf，直接改的話之後推的主題會拿到這個主色（Codex spec R1）。
        # 按鈕上的字、焦點外圈：午夜藍那一格的亮度與彩度、換成這個色相（主色本身可能太淡，外圈不用它）
        nf = dict(nf)
        pL, pC, _ = to_oklch(nf["--primary"])
        focus = oklch_hex(pL, pC, H)
        iL, iC, _ = to_oklch(nf["--primary-ink"])
        nf["--primary"], nf["--primary-ink"] = r["primary"], oklch_hex(iL, iC, H)
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
    if "primary" in r:
        t["--focus"] = f"color-mix(in srgb, {focus} 60%, transparent)"
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
DECL_RE = re.compile(r"(--[a-z0-9-]+|color-scheme)[ \t\r\n\f]*:[ \t\r\n\f]*([^;]+);")
THEME_SELECTOR_RE = re.compile(r':root\[data-theme="([^"]+)"\]')
GOOD_DECL_RE = re.compile(r"[ \t\r\n\f]*(--[a-z0-9-]+|color-scheme)[ \t\r\n\f]*:[ \t\r\n\f]*([^!:;{}]+?)[ \t\r\n\f]*")


def strip_comments(css):
    # 換成一個空格、不直接刪：保留註解前後兩段的邊界（Codex spec R4）
    return re.sub(r"/\*.*?\*/", " ", css, flags=re.S)


def rules(css, in_at_rule=False):
    # 以大括號配對切出每條規則 (選擇器, 內容, 是否包在 @ 規則裡)。內容保留巢狀的大括號：CSS nesting 的子規則
    # 留在父規則的內容裡（白名單判它不合格），不會吃掉外層的選擇器（Codex plan R1：只抓最內層的正規式會把
    # [data-theme="x"]:root { …; @media (…) { … } } 的外層選擇器整個丟掉）。@media 等 @ 規則往內遞迴。
    # 選擇器前面的文字原樣保留：誤留的宣告會跟著選擇器被當成非標準寫法擋下（Codex plan R2）。
    # 分號式的 @ 敘述（@import、@layer a, b;）不支援：前面帶分號的 @ 不往內遞迴、原樣列出，由 check 點名。
    # 「怎麼略過它」連三輪各打一個方向（R1～R3），R4 選擇直接不支援——放棄合法寫法也能通過的保證，現況 0 處
    out, i = [], 0
    while True:
        j = css.find("{", i)
        if j < 0:
            return out
        selector = css[i:j].strip(CSS_WS)
        depth, k = 1, j + 1
        while k < len(css) and depth:
            depth += {"{": 1, "}": -1}.get(css[k], 0)
            k += 1
        body = css[j + 1:k - 1] if depth == 0 else css[j + 1:]
        if selector.startswith("@") and ";" not in selector:
            out += rules(body, True)
        else:
            out.append((selector, body, in_at_rule))
        i = k


def declarations(body):
    return {k: re.sub(r"[ \t\r\n\f]+", " ", v.strip(CSS_WS)) for k, v in DECL_RE.findall(body)}


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
    bodies = [b for s, b, _ in rules(css) if s == NF_SELECTOR]
    return declarations(bodies[0]) if bodies else None


def unbalanced(css):
    # 語法的前提（Codex plan R5）：整份檔（已去掉註解）的 () [] {} 與引號要正確配對。未閉合的括號、引號會讓瀏覽器
    # 把後面整段吞掉（jsdom 實測檔首多一個 `@layer base(` 就解析出 0 條規則），這裡切出來的規則跟瀏覽器看到的就不同了。
    # 只做配對、不模擬瀏覽器的錯誤恢復：R1～R4 在「怎麼切」上一個寫法補一次，這條一次擋掉整類「沒寫完」。
    # 大括號也不得出現在還沒閉合的 ( 或 [ 裡（Codex plan R6：檔首 `@layer base(`、檔尾 `)` 配對完整，整份 CSS 卻都在圓括號裡）——
    # rules() 靠大括號切規則，這兩條就是它的前提。保證範圍到此為止（使用者 2026-10-03 決定）：只保證正常編輯會出現的寫法，
    # 刻意構造的 CSS（字串裡藏 /* */ 或假的主題區塊之類）不在範圍，那需要真正的 CSS 解析器
    pairs = {")": "(", "]": "[", "}": "{"}
    stack, quote, i = [], None, 0
    while i < len(css):
        ch = css[i]
        if quote:
            if ch == "\\":
                i += 1   # 跳脫的下一個字不算引號
            elif ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "\\":
            # 字串外的反斜線是 CSS 跳脫：`\}` 讓那個 } 不算區塊結尾，瀏覽器把後面整份吞進那一塊（Codex 最終審查 R1：
            # 檔首共用 :root 的 } 誤打成 \}，jsdom 實測規則從 10 條剩 1 條），這裡卻照原始字元切規則。現況 0 處，直接不支援
            return "字串外有反斜線，CSS 跳脫會讓緊接的括號、引號不算數，src/index.css 不支援"
        elif ch in "([{":
            if ch == "{" and any(c in "([" for c in stack):
                return "大括號出現在還沒閉合的 ( 或 [ 裡"
            stack.append(ch)
        elif ch in ")]}":
            if not stack or stack.pop() != pairs[ch]:
                return f"多出一個 {ch}"
        i += 1
    if quote:
        return f"引號 {quote} 沒有閉合"
    return f"{''.join(stack)} 沒有閉合" if stack else None


def block_problems(label, body):
    # 白名單（spec §3.5 第 6 條）：主題區塊只准由「屬性: 值;」組成——屬性是 --* 或 color-scheme、值裡沒有 ! 與 :
    # （中段漏一個分號時，下一條宣告會被併進值裡，Codex plan R8）、以分號結尾、同一屬性只出現一次。一條擋下 !important、重複宣告、漏分號的最後一條（解析時會被跳過）、混進來的其他屬性。
    # 列舉「不准的寫法」連三輪各漏一種（Codex spec R1～R3），所以改成「只准一種寫法」
    *segments, tail = body.split(";")
    problems, names = [], []
    odd = sorted({c for c in body if ord(c) > 127})
    if odd:
        # 主題區塊（去掉註解後）只會有 ASCII；全形空白、NBSP 這類瀏覽器不當空白，那條宣告會失效（Codex plan R9）
        problems.append(f"{label}：含 CSS 不認得的字元 {'、'.join(f'U+{ord(c):04X}' for c in odd)}（全形空白、NBSP 之類，瀏覽器不當空白）")
    for seg in segments:
        m = GOOD_DECL_RE.fullmatch(seg)
        if m:
            names.append(m.group(1))
        else:
            problems.append(f"{label}：不合格的宣告 {seg.strip()!r}")
    for name in sorted(set(names)):
        if names.count(name) > 1:
            problems.append(f"{label}：{name} 宣告了 {names.count(name)} 次")
    if tail.strip(CSS_WS):
        problems.append(f"{label}：最後一個分號之後還有 {tail.strip(CSS_WS)!r}")
    return problems


def check_css(css):
    # 回傳問題清單，空清單＝一致（spec §3.5）。午夜藍基準從同一份 css 讀，測試可以餵改過的 CSS。
    # 保證範圍只到 src/index.css 的主題區塊與 data-theme 選擇器；不含 data-theme 的選擇器、其他 CSS 檔覆寫 token 不管
    css = strip_comments(css)
    broken = unbalanced(css)
    if broken:
        return [f"src/index.css 的括號或引號沒有配對好（{broken}）：瀏覽器會把後面整段吞掉，先修好語法再比對"]
    found = rules(css)
    nf_bodies = [b for s, b, _ in found if s == NF_SELECTOR]
    if len(nf_bodies) != 1:
        # 找不到就沒有基準；不只一塊時瀏覽器每塊都套、這裡只讀一塊，比對沒有意義
        return [f"nightfall：區塊出現 {len(nf_bodies)} 次（要恰好 1 次）"]
    problems = block_problems("nightfall", nf_bodies[0])
    nf = declarations(nf_bodies[0])
    for s, b, in_at_rule in found:
        if s.startswith("@"):
            problems.append(f"不支援分號式的 @ 敘述（@import、@layer a, b; 這類），src/index.css 裡不要寫：{s.split(';', 1)[0]};")
        m = THEME_SELECTOR_RE.fullmatch(s)
        if in_at_rule and (m or s == NF_SELECTOR):
            # 包在 @media 等規則裡就只在某些條件下生效，條件不成立時這個主題沒有任何顏色
            problems.append(f"{m.group(1) if m else 'nightfall'}：主題區塊要寫在最外層，不能包在 @media 等 @ 規則裡")
        if m:
            problems += block_problems(m.group(1), b)   # 不論有沒有配方都要合格
            if m.group(1) not in RECIPES:
                problems.append(f"{m.group(1)}：沒有配方（src/index.css 有這塊，admin/derive_theme.py 的 RECIPES 沒有）")
        elif "data-theme" in s.lower() and s != NF_SELECTOR:
            # 例如 [data-theme="x"]:root：權重跟標準寫法相同、寫在後面就生效（Codex spec R1）
            problems.append(f"非標準的 data-theme 選擇器：{s}")
    # 每個 data-theme 都要落在某條規則的選擇器上；落在別處的（巢狀子規則的選擇器、@ 規則的條件）上面兩條看不到。
    # 辨識與清點都不分大小寫：HTML 的屬性名稱不分大小寫，data-Theme 一樣生效（Codex plan R7）；標準寫法仍要求固定格式
    stray = css.lower().count("data-theme") - sum(s.lower().count("data-theme") for s, _, _ in found)
    if stray:
        problems.append(f"data-theme 出現在最外層選擇器以外的地方 {stray} 處（例如巢狀子規則或 @ 規則的條件裡）")
    # 推導主題輸出的每個 token 午夜藍都要有：午夜藍的值不比對、--X-text 這類又是推導主題自己算的，
    # 刪掉午夜藍的一條宣告時推導主題照樣一致，午夜藍卻少了那格（Claude 自查，Codex plan R8 那一類的延伸）
    derived = {theme: derive(theme, nf) for theme in RECIPES}
    for k in sorted(set().union(*derived.values()) - set(nf) - LIGHT_ONLY):
        problems.append(f"nightfall：少了 {k}（推導主題都有這格，token 集合照午夜藍）")
    for theme in RECIPES:
        bodies = [b for s, b, _ in found if s == theme_selector(theme)]
        if len(bodies) != 1:
            problems.append(f"{theme}：區塊出現 {len(bodies)} 次（要恰好 1 次）")
            continue
        got = declarations(bodies[0])
        # 比的是印出來的區塊解析回來的結果：貼進 CSS 的是印出來的東西，漏印一條要被抓到
        exp = declarations(render_block(theme, derived[theme]))
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

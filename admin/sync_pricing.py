#!/usr/bin/env python3
"""從 LiteLLM 的定價表重生 sidecar/fledge_sidecar/usage/pricing_table.py。

    python admin/sync_pricing.py                 # 抓上游 → 印差異 → 寫表 → 掃本機用量報缺漏
    python admin/sync_pricing.py --dry-run       # 只印差異，不寫檔
    python admin/sync_pricing.py --from t.json   # 用本機快照（離線／重現同一次審查）
    python admin/sync_pricing.py --no-check-local  # 跳過本機 jsonl 覆蓋率掃描

離開碼：0＝表已是最新且本機模型全有價；1＝有缺漏或同步失敗（供 shell 判斷）。

為何是 build-time 同步而非執行期抓取上游，見 docs/adr/0005-build-time-pricing-vendoring.md。
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO / "sidecar"))

from fledge_sidecar.app_config import AppConfig  # noqa: E402
from fledge_sidecar.usage import parser, pricing, scanner  # noqa: E402
from fledge_sidecar.usage import pricing_table as current  # noqa: E402

UPSTREAM_URL = ("https://raw.githubusercontent.com/BerriAI/litellm/main/"
                "model_prices_and_context_window.json")
TABLE_PATH = _REPO / "sidecar" / "fledge_sidecar" / "usage" / "pricing_table.py"

# Claude cache 三層一律存上游真價；**只有上游沒給某層時**才用這組倍率推導成估價
# （目前 28 筆裡只有 2 筆缺 above_1hr）。倍率只是估值來源，不拿來反過來判斷
# 上游給的值對不對——那條比例猜測已於 Codex 第二輪裁決後移除，見 _cache_layer_price。
_CACHE_FALLBACK_MULTIPLIERS = (("cache_creation_input_token_cost", 1.25),
                               ("cache_creation_input_token_cost_above_1hr", 2.0),
                               ("cache_read_input_token_cost", 0.1))
# Codex 的 cached input 標準折扣。實測上游 28 款裡 26 款精確等於 0.1×，是普遍規則；
# 缺值的那兩款（gpt-5-pro 無欄位、gpt-5.2-pro 為 0）沒有理由自成一格——官方頁對四個 pro
# 都標「—」，只因上游資料有沒有缺就給出相差 10 倍的待遇，是規則不一致而非定價差異。
_CODEX_CACHED_MULTIPLIER = 0.1
# Codex 側的收錄條件之一：世代。世代號寫死是刻意的——放寬成 `gpt-` 會把 gpt-4o、
# 音訊／圖像／embedding 一起吃進來。世代號後面必須接結尾、`.` 或 `-`，否則
# `gpt-60…`、`gpt-6a…` 這種不同世代也會被純字首收進來（Codex 第一輪 finding 3）。
# 新世代發布要來加一筆；漏加時由 `explain_missing()` 指出是我們沒收、不是上游沒有。
_CODEX_KEY_RE = re.compile(r"^gpt-[56](?:[.-]|$)")
# 條件之二：必須是文字模型。名字分辨不出「是不是 Codex 會跑的款」——Codex CLI 記錄的是
# gpt-5.5、gpt-5.6-sol 這種純模型名，沒有 -codex 字樣，所以名字 allowlist 得追 OpenAI
# 每次出的 tier（sol/terra/luna 之後又有 spark），漏列＝使用者實際在用的款不計成本。
# 上游自帶的 mode 是資料驅動的判準：新文字模型自動通過、新的非文字產品自動擋掉。
# **fail-closed**：mode 缺漏或不認得一律不收（Codex 第二輪 finding 3）。放行未知等於
# 讓上游 schema 漂移把非文字產品無聲收進表，日後以文字 token 三元組算出錯帳；
# 擋下來則是看得見的失敗——面板警示 ＋ `explain_missing()` 說明原因。
_CODEX_MODES = ("chat", "responses")


def fetch_upstream(local: str | None) -> dict:
    """取上游 JSON。合法但空/非 mapping 的回應要當失敗擋下——否則會生出空表整檔覆蓋。"""
    if local:
        payload = json.loads(Path(local).expanduser().read_text(encoding="utf-8"))
    else:
        req = urllib.request.Request(UPSTREAM_URL, headers={"User-Agent": "fledge-sync-pricing"})
        with urllib.request.urlopen(req, timeout=30) as resp:   # noqa: S310 —— 固定 https 常數 URL
            payload = json.loads(resp.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"上游回應不是 mapping（得到 {type(payload).__name__}）")
    if not payload:
        raise ValueError("上游回應是空 mapping —— 視為殘缺，不以空表覆蓋")
    return payload


def _is_bare(key: str) -> bool:
    """只收第一方 API 的裸 key。

    `/`＝vertex_ai/、azure_ai/ 等路徑式 provider；`:`＝Bedrock 版本尾綴（-v1:0）——
    兩者都是區域／代管價，與第一方不同帶。點號式 provider 前綴（anthropic.、us.…）
    不必在此擋，它們過不了下游的 claude-／gpt-5 前綴比對。
    """
    return "/" not in key and ":" not in key


def _mtok(value: float | None) -> float:
    """per-token → per-MTok。round 消 float 乘法噪音（5e-06*1e6 = 5.000000000000001）。"""
    return round((value or 0.0) * 1_000_000, 6)


def _cache_layer_price(entry: dict, p_in: float, field: str, multiplier: float,
                       key: str) -> tuple[float, str | None]:
    """單一 cache 層的價：上游給了有限正數就照收，缺值或壞值才用倍率推導並標明是估價。

    刻意**不**用「偏離標準倍率就視同損壞」的比例猜測（Codex 第二輪 high finding）：
    那條規則分不出「上游資料壞掉」與「供應商合法調價」——Fable 5.1 把 cache read 降到
    input 的 0.025×（官方 $0.25/MTok）就被它當成損壞、改寫成 4 倍的估價，還照常寫檔成功。
    它的立案依據（claude-3-haiku 的 24×、claude-3-opus 的 0.4×）上游早已修正，
    實測開關它對現行表零影響；今年唯一一次實際動作就是那個誤判。
    刻意偏離上游的項目改走 `PINNED`／`EXCLUDED`——那是人決定的、寫得出理由的。

    推導而非留 0，是因為 0 會被當成「該層免費」造成低估。
    """
    raw = entry.get(field)
    if raw and math.isfinite(raw) and raw > 0:
        return _mtok(raw), None
    derived = p_in * multiplier
    if raw:      # 有值卻不是有限正數＝真的壞掉，這不是猜的，要人去看上游
        return _mtok(derived), (f"{key}：{field} 上游值 {raw!r} 非有限正數 → "
                                f"以 {multiplier}× input 估價 {_mtok(derived)}，請複核上游")
    return _mtok(derived), (f"{key}：上游未提供 {field} → 以 {multiplier}× input "
                            f"估價 {_mtok(derived)}（估值，非官方價）")


def _claude_cache_prices(entry: dict, p_in: float,
                         key: str) -> tuple[tuple[float, float, float], list[str]]:
    """(5m write, 1h write, read) 三層價 + 異常說明。缺層在上游很常見（claude-4-opus
    就沒有 above_1hr），故一律走 `_cache_layer_price`。"""
    prices, notes = [], []
    for field, multiplier in _CACHE_FALLBACK_MULTIPLIERS:
        price, note = _cache_layer_price(entry, p_in, field, multiplier, key)
        prices.append(price)
        if note:
            notes.append(note)
    return (prices[0], prices[1], prices[2]), notes


def _normalized_name(key: str) -> str | None:
    """上游裸 key → Fledge 查表用的名字。與 `build_tables` 用同一組 normalize。"""
    if key.startswith("claude-"):
        return pricing.normalize_claude_model(key)
    return pricing.normalize_codex_model(key)


def _table_candidates(raw: dict) -> dict[str, dict]:
    """會被 `build_tables()` 納入考慮的上游 key → entry（裸 key、是 mapping、有 input 價）。

    `explain_missing()` 必須用同一組候選，否則診斷會對著建表根本不看的 key 下結論：
    同名的日期版若缺 input 價，會把 mode 判定推進「非預期」分支（Codex 第二輪 finding 2）。
    """
    return {k: e for k, e in raw.items()
            if isinstance(e, dict) and _is_bare(k) and e.get("input_cost_per_token")}


def explain_missing(name: str, raw: dict) -> str:
    """本機用過、但表裡查無定價的款，說明它為什麼不在表裡。

    原本這句訊息寫死「上游也還沒收錄」，那是沒查過的斷言。四種原因該做的事完全不同：
    EXCLUDED 是刻意的安全決策（別去改前綴）、收錄條件沒涵蓋是我們的問題（改 `_CODEX_KEY_RE`）、
    上游缺價欄則無從計價，只有最後一種才是等上游。**EXCLUDED 必須先判**，否則刻意排除的款
    會被說成「前綴漏收」，把人導向錯的修法（Codex 審查 finding 2）。
    """
    if name in pricing.EXCLUDED:
        return f"上游有此款但刻意排除（EXCLUDED）：{pricing.EXCLUDED[name]}"
    candidates = {k: e for k, e in _table_candidates(raw).items()
                  if _normalized_name(k) == name}
    if not candidates:
        # 分辨「上游完全沒有」與「上游有、但缺 input 價所以建表根本不看它」
        seen = any(isinstance(e, dict) and _is_bare(k) and _normalized_name(k) == name
                   for k, e in raw.items())
        return "上游有此款，但缺 input 價，無從計價" if seen else "上游也還沒收錄"
    if not any(k.startswith("claude-") or _CODEX_KEY_RE.match(k) for k in candidates):
        return "上游有此款但不符收錄條件 → 可能是新世代，請複核 _CODEX_KEY_RE"
    modes = {e.get("mode") for k, e in candidates.items() if not k.startswith("claude-")}
    if modes and all(m not in _CODEX_MODES for m in modes):
        return (f"上游有此款，但 mode={'／'.join(sorted(repr(m) for m in modes))} "
                f"不在 _CODEX_MODES，刻意不收")
    return "上游有此款且通過收錄條件，卻沒進表 → 非預期，請查 build_tables"


def build_tables(raw: dict) -> tuple[dict, dict, list[str], list[str]]:
    """回 (claude_table, codex_table, notes, conflicts)。

    表 key＝上游裸 key 餵進 Fledge 自己的 normalize——保證「表裡的 key」與
    「runtime 查表時用的 key」由同一段程式產生，不會各自漂移。
    """
    claude: dict[str, tuple[float, float, float, float, float]] = {}
    codex: dict[str, tuple[float, float, float]] = {}
    seen: dict[str, dict[str, tuple]] = {}      # 正規化 key → {上游 key: price}
    notes: list[str] = []
    warnings: list[str] = []

    for key, entry in sorted(_table_candidates(raw).items()):
        p_in = entry["input_cost_per_token"]
        if key.startswith("claude-"):
            norm = pricing.normalize_claude_model(key)
            if norm is None:
                continue
            cache_prices, anomalies = _claude_cache_prices(entry, p_in, key)
            warnings.extend(anomalies)
            price: tuple = (_mtok(p_in), _mtok(entry.get("output_cost_per_token")),
                            *cache_prices)
            table = claude
        elif _CODEX_KEY_RE.match(key):
            mode = entry.get("mode")
            if mode not in _CODEX_MODES:
                notes.append(f"跳過 {key}（mode={mode!r}）：只收 {_CODEX_MODES} 這類文字模型。"
                             f"未宣告或不認得的 mode 一律不收——放行未知會讓非文字產品"
                             f"無聲進表、日後以文字 token 三元組算出錯帳")
                continue
            norm = pricing.normalize_codex_model(key)
            cached, note = _cache_layer_price(entry, p_in, "cache_read_input_token_cost",
                                              _CODEX_CACHED_MULTIPLIER, key)
            if note:
                warnings.append(note)
            price = (_mtok(p_in), cached, _mtok(entry.get("output_cost_per_token")))
            table = codex
        else:
            continue

        if norm in pricing.EXCLUDED:
            notes.append(f"跳過 {norm}（EXCLUDED）：{pricing.EXCLUDED[norm]}")
            continue
        seen.setdefault(norm, {})[key] = price
        table[norm] = price

    # 同一正規化 key 被多個上游 key 指到且價格不一致 → 不猜，中止寫入
    conflicts = [f"{norm}：{sources}" for norm, sources in seen.items()
                 if len({v for v in sources.values()}) > 1]

    # PINNED：寫入我們自己決定的價，並把上游值報出來供複核
    for key, (held, reason) in pricing.PINNED.items():
        for table in (claude, codex):
            if key not in table:
                continue
            if len(held) != len(table[key]):
                warnings.append(f"{key} 的 PINNED 值有 {len(held)} 欄、上游有 {len(table[key])} 欄 → "
                                f"欄位數不符，改採上游值 {table[key]}，請更新 PINNED")
                continue
            if held != table[key]:
                notes.append(f"保留 {key} = {held}（PINNED，上游為 {table[key]}）：{reason}")
            table[key] = held

    for key in pricing.EXCLUDED:
        if key not in raw:
            warnings.append(f"EXCLUDED 的 {key} 已不在上游 → 該例外可能已過期，請複核")
    for key in pricing.PINNED:
        if key not in claude and key not in codex:
            warnings.append(f"PINNED 的 {key} 已不在上游 → 該例外可能已過期，請複核")
    return claude, codex, notes + warnings, conflicts


def invalid_prices(claude: dict, codex: dict) -> list[str]:
    """回價格不合法的項目描述。

    上游缺 `output_cost_per_token` 會被 `_mtok` 轉成 0.0＝output token 免費，
    那是最貴的一欄，靜默低估幅度極大。任何非有限或非正數一律擋下不寫——
    真有上游資料爛掉的款，請人工加進 EXCLUDED 並寫理由，不由腳本猜。
    """
    bad = []
    for label, table in (("claude", claude), ("codex", codex)):
        for key, price in sorted(table.items()):
            for value in price:
                if not math.isfinite(value) or value <= 0:
                    bad.append(f"{label} {key} = {price}")
                    break
    return bad


def render_table(claude: dict, codex: dict) -> str:
    payload = json.dumps({"claude": claude, "codex": codex}, sort_keys=True)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]
    version = f"{datetime.date.today().isoformat()}.{digest}"
    lines = [
        '"""定價表：自動生成，請勿手改（單位一律 USD per MTok）。',
        "",
        "由 `python admin/sync_pricing.py` 從 LiteLLM model_prices_and_context_window.json 重生；",
        "表 key 已套用 pricing.py 的正規化（剝日期後綴），故等同 runtime 查表用的 key。",
        "計價公式與正規化在 pricing.py；刻意偏離上游的項目與理由記在 pricing.py 的 PINNED / EXCLUDED。",
        '"""',
        "from __future__ import annotations",
        "",
        "# <生成日期>.<表內容 sha256 前 8 碼>：內容一變就變，改表不可能忘記遞增。",
        "# cache.py 只做相等比對，不解析內容。",
        f'TABLE_VERSION = "{version}"',
        "",
        "# Claude：(input, output, cache_5m_write, cache_1h_write, cache_read)——三層 cache 存",
        "# 上游真價而非倍率（倍率只對現行世代成立，claude-3-haiku 實為 1.2x/0.12x）；",
        "# 上游缺哪層才由 sync 用 1.25x/2x/0.1x 推導。",
        "CLAUDE_PRICING: dict[str, tuple[float, float, float, float, float]] = {",
    ]
    lines += [f'    "{k}": {v!r},' for k, v in sorted(claude.items())]
    lines += [
        "}",
        "",
        "# Codex：(input, cached_input, output)",
        "CODEX_PRICING: dict[str, tuple[float, float, float]] = {",
    ]
    lines += [f'    "{k}": {v!r},' for k, v in sorted(codex.items())]
    lines += ["}", ""]
    return "\n".join(lines)


def scan_local_models() -> set[str]:
    """本機用量檔實際出現過的模型名（已正規化）。

    刻意走 sidecar 自己的 scanner + parser，不自行解析 jsonl——重寫解析等於重新踩
    「grep 到 Agent tool 參數而非 message.model」那類坑。
    """
    config = AppConfig.load()
    codex_home = Path(os.environ.get("FLEDGE_CODEX_HOME") or (Path.home() / ".codex"))
    models: set[str] = set()
    for path in scanner.claude_files(config):
        for entry in parser.parse_claude_file(path)[0]:
            models.add(entry.model)
    for path in scanner.codex_files(codex_home):
        for entry in parser.parse_codex_file(path).entries:
            models.add(entry.model)
    # <synthetic> 是排除計價非查無定價；unknown-codex 是檔內缺 turn_context，不是定價缺口
    return models - {"<synthetic>", "unknown-codex"}


def main() -> int:
    ap = argparse.ArgumentParser(description="從 LiteLLM 重生 pricing_table.py")
    ap.add_argument("--from", dest="local", help="改讀本機 JSON 快照，不連外")
    ap.add_argument("--dry-run", action="store_true", help="只印差異不寫檔")
    ap.add_argument("--no-check-local", action="store_true", help="跳過本機用量覆蓋率掃描")
    ap.add_argument("--allow-removals", action="store_true",
                    help="允許本次同步從表中移除既有模型（預設拒絕，防上游殘缺整批清空）")
    args = ap.parse_args()

    try:
        raw = fetch_upstream(args.local)
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
        print(f"上游取得失敗：{exc}", file=sys.stderr)
        return 1

    claude, codex, notes, conflicts = build_tables(raw)
    # 整檔覆蓋是破壞性操作：所有「會生出壞表」的檢查都必須在 os.replace 之前擋掉
    if conflicts:
        print("同一模型名對到不同價格，不猜、中止寫入：", file=sys.stderr)
        for line in conflicts:
            print(f"  ✗ {line}", file=sys.stderr)
        return 1
    bad = invalid_prices(claude, codex)
    if bad:
        print("價格非有限正數（上游缺欄或資料損壞），中止寫入：", file=sys.stderr)
        for line in bad:
            print(f"  ✗ {line}", file=sys.stderr)
        return 1

    for line in notes:
        print(f"  ℹ {line}")

    added = sorted(set(claude) - set(current.CLAUDE_PRICING)) + \
        sorted(set(codex) - set(current.CODEX_PRICING))
    removed = sorted(set(current.CLAUDE_PRICING) - set(claude)) + \
        sorted(set(current.CODEX_PRICING) - set(codex))
    previous = {**current.CLAUDE_PRICING, **current.CODEX_PRICING}
    latest = {**claude, **codex}
    changed = [k for k, v in latest.items() if k in previous and previous[k] != v]
    for label, keys in (("新增", added), ("移除", removed)):
        for k in keys:
            print(f"  {label} {k}")
    # 改價印出舊值→新值。砍掉比例猜測後，擋「上游把價寫壞」的防線就是寫檔前的人工審查
    # （下面那句「請審 git diff 後 commit」）；只印模型名的話，12 倍的錯價與四捨五入的
    # 差異長得一模一樣，人審不出來。這不是新增護欄，是讓既有的人工關卡真的可用。
    for k in changed:
        print(f"  改價 {k}：{previous[k]} → {latest[k]}")
    print(f"  表：claude {len(claude)} 款、codex {len(codex)} 款")

    # 移除既有模型要顯式同意：上游殘缺／改 schema 時，表會整批縮水而 diff 看起來只是「少了幾行」
    if removed and not args.allow_removals:
        print(f"\n本次會移除 {len(removed)} 款既有模型；確認上游真的下架了，再加 --allow-removals 重跑。",
              file=sys.stderr)
        return 1

    if not args.dry_run:
        rendered = render_table(claude, codex)
        tmp = TABLE_PATH.with_name(TABLE_PATH.name + ".tmp")
        tmp.write_text(rendered, encoding="utf-8")
        os.replace(tmp, TABLE_PATH)
        # relpath 而非 Path.relative_to：後者對 repo 外的路徑會拋例外（測試會把 TABLE_PATH 導到 tmp）
        print(f"  已寫入 {os.path.relpath(TABLE_PATH, _REPO)}（請審 git diff 後 commit）")

    if args.no_check_local:
        return 0
    local = scan_local_models()
    missing = sorted(m for m in local if m not in claude and m not in codex)
    if missing:
        print("\n本機用量出現、但新表仍查無定價的模型：", file=sys.stderr)
        for m in missing:
            print(f"  ⚠ {m}（{explain_missing(m, raw)}）", file=sys.stderr)
        return 1
    print(f"  本機用量出現過的 {len(local)} 款模型全數有價")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

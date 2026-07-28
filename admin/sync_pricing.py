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

# Claude cache 三層存真價；上游沒給某層時才用這組倍率推導（現行世代皆吻合，
# 舊款如 claude-3-haiku 實為 1.2×/0.12×，正是不能一律套倍率的原因）
_CACHE_FALLBACK_MULTIPLIERS = (("cache_creation_input_token_cost", 1.25),
                               ("cache_creation_input_token_cost_above_1hr", 2.0),
                               ("cache_read_input_token_cost", 0.1))


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


def _claude_cache_prices(entry: dict, p_in: float) -> tuple[float, float, float]:
    """(5m write, 1h write, read) 的真價；上游缺哪層就用該層的標準倍率由 input 價推導。

    推導而非跳過，是因為缺層在上游很常見（claude-4-opus 就沒有 above_1hr），
    而 0 會被當成「該層免費」造成低估。
    """
    return tuple(_mtok(entry.get(field) or p_in * multiplier)          # type: ignore[return-value]
                 for field, multiplier in _CACHE_FALLBACK_MULTIPLIERS)


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

    for key, entry in sorted(raw.items()):
        if not isinstance(entry, dict) or not _is_bare(key):
            continue
        p_in = entry.get("input_cost_per_token")
        if not p_in:
            continue
        if key.startswith("claude-"):
            norm = pricing.normalize_claude_model(key)
            if norm is None:
                continue
            price: tuple = (_mtok(p_in), _mtok(entry.get("output_cost_per_token")),
                            *_claude_cache_prices(entry, p_in))
            table = claude
        elif key.startswith("gpt-5"):
            norm = pricing.normalize_codex_model(key)
            # 上游對 pro 系列的 cached 價不一致（有的填 0、有的填 0.1×），官方頁標「—」＝未提供。
            # 填 0 會把 cached token 當免費＝低估，故退回 input 價（寧可高估不低估）。
            cached = entry.get("cache_read_input_token_cost") or p_in
            price = (_mtok(p_in), _mtok(cached), _mtok(entry.get("output_cost_per_token")))
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
    changed = [k for k, v in {**claude, **codex}.items()
               if k in {**current.CLAUDE_PRICING, **current.CODEX_PRICING}
               and {**current.CLAUDE_PRICING, **current.CODEX_PRICING}[k] != v]
    for label, keys in (("新增", added), ("移除", removed), ("改價", changed)):
        for k in keys:
            print(f"  {label} {k}")
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
        print("\n本機用量出現、但新表仍查無定價的模型（上游也還沒收錄）：", file=sys.stderr)
        for m in missing:
            print(f"  ⚠ {m}", file=sys.stderr)
        return 1
    print(f"  本機用量出現過的 {len(local)} 款模型全數有價")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

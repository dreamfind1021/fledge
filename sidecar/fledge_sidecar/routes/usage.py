# sidecar/fledge_sidecar/routes/usage.py
"""GET /usage/dashboard——single-flight＋to_thread＋last-good 語義（design §10/§14）。"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from fledge_sidecar.app_config import AppConfig, default_config_path
from fledge_sidecar.paths import resolve_best_effort
from fledge_sidecar.routes.sessions import live_session_ids
from fledge_sidecar.usage import account_activity
from fledge_sidecar.usage.aggregator import build_dashboard
from fledge_sidecar.usage.cache import UsageCache
from fledge_sidecar.usage.scanner import _scan_claude, codex_files

logger = logging.getLogger(__name__)
router = APIRouter()

SCAN_TIMEOUT = 120.0
STALE_AFTER = 25.0   # 上次掃描超過此秒數才再觸發（30s 輪詢 → 每輪都新鮮）

_state: dict = {}


def reset_state_for_tests() -> None:
    """測試隔離：清掉模組級 snapshot/lock。"""
    _state.clear()


def _codex_home() -> Path:
    return Path(os.environ.get("FLEDGE_CODEX_HOME") or (Path.home() / ".codex"))


def _l2_path() -> Path:
    override = os.environ.get("FLEDGE_USAGE_CACHE")
    if override:
        return Path(override)
    return default_config_path().parent / "cache" / "usage-v1.json"


def _scan_sync(days: int) -> dict:
    config = AppConfig.load()
    cache: UsageCache | None = _state.get("cache")
    if cache is None:   # 不用 setdefault——其 default 是 eager 求值，會每輪重建並整份重讀 L2
        cache = _state["cache"] = UsageCache(l2_path=_l2_path())
    t0 = time.monotonic()
    cl, account_map = _scan_claude(config)
    cx = codex_files(_codex_home())
    r = cache.refresh(claude=cl, codex=cx)
    now = time.time()
    # 逐 UsageEntry 按活動 log 區間歸屬（account_activity.attribute）；涵蓋不到 fallback
    # 到 scanner canonical（account_map）並標 partial。
    spans = account_activity.load_sessions(now, live_session_ids())
    by_account: dict[str, list] = {}
    partial: dict[str, bool] = {}
    for rp, file_entries in r.claude_by_file.items():
        canon = account_map.get(rp)              # scanner canonical（fallback）
        for e in file_entries:
            proj = (e.project or "").strip()
            acct = (account_activity.attribute(spans, resolve_best_effort(proj), e.ts)
                    if os.path.isabs(proj) else None)   # 只對絕對 cwd attribute（防誤命中）
            if acct is None:                     # 涵蓋不到 / 非絕對 cwd → fallback canonical
                acct = canon
                if acct is not None:
                    partial[acct] = True
            if acct is None:
                continue
            by_account.setdefault(acct, []).append(e)
    labels = {k: v.get("label", k) for k, v in config.accounts.items()}
    payload = build_dashboard(r.entries, r.codex_rate_limits,
                              config.subscriptions, now=now, days=days,
                              roots=[r["path"] for r in config.roots],
                              claude_entries_by_account=by_account, account_labels=labels,
                              account_partial=partial)
    payload["scan_meta"].update({
        "state": "ok", "generation": r.generation, "files": r.total_files,
        "skipped_lines": r.skipped_lines, "scanned_at": now, "error": None,
        "cold_scan_ms": int((time.monotonic() - t0) * 1000), "days": days,
        "sources": {"claude": "ok" if cl else "missing", "codex": "ok" if cx else "missing"},
    })
    return payload


async def _ensure_scan(days: int) -> None:
    if _state.get("scanning"):
        return
    last = _state.get("scanned_at", 0.0)
    fresh = time.time() - last < STALE_AFTER
    same_days = _state.get("days") == days
    # error 視為立即 retry trigger（design §14）；days 變更視為 stale
    if fresh and same_days and _state.get("snapshot") is not None and not _state.get("error"):
        return
    _state["scanning"] = True
    _state["days"] = days

    async def _run():
        try:
            snap = await asyncio.wait_for(asyncio.to_thread(_scan_sync, days),
                                          timeout=SCAN_TIMEOUT)
            _state["snapshot"] = snap
            _state["scanned_at"] = time.time()
            _state["error"] = None
        except Exception as exc:  # noqa: BLE001 —— 掃描失敗回報、下次輪詢重試（design §14）
            logger.warning("usage 掃描失敗：%s", exc)
            _state["error"] = str(exc)
        finally:
            _state["scanning"] = False

    _state["task"] = asyncio.create_task(_run())


@router.get("/usage/dashboard")
async def usage_dashboard(days: int = 30):
    """days 與 single-flight 的 contract（plan R2 裁定）：掃描進行中，任何 days 的請求
    一律回 last-good snapshot（其 scan_meta.days 可能與請求不符——以 scan_meta.days 為準）
    或 202（無 snapshot）；days 變更會把狀態視為 stale，於下一輪掃描收斂。
    v1 前端固定 days=30，此邊界僅為 contract 完備。"""
    days = max(1, min(365, days))
    # 請求抵達當下是否已有 in-flight 掃描——design §10 原意：「抵達時已有」才算 scanning；
    # 否則 STALE_AFTER(25s) < 輪詢(30s)，每輪自觸發 rescan、第二輪起永遠標 scanning
    was_scanning = bool(_state.get("scanning"))
    await _ensure_scan(days)
    snap = _state.get("snapshot")
    if snap is None:
        if _state.get("error"):
            return JSONResponse({"scan_meta": {"state": "error", "error": _state["error"],
                                               "missing_pricing": []}},
                                status_code=200)
        return JSONResponse({"scan_meta": {"state": "scanning"}}, status_code=202,
                            headers={"Retry-After": "2"})
    out = dict(snap)
    meta = dict(out["scan_meta"])
    if was_scanning:
        meta["state"] = "scanning"     # 抵達當下已有 in-flight 掃描（design §10）
    if _state.get("error"):
        meta["state"] = "error"
        meta["error"] = _state["error"]
    out["scan_meta"] = meta
    return out

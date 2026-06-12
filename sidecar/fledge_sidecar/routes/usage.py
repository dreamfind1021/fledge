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
from fledge_sidecar.usage.aggregator import build_dashboard
from fledge_sidecar.usage.cache import UsageCache
from fledge_sidecar.usage.scanner import claude_files, codex_files

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
    cache: UsageCache = _state.setdefault("cache", UsageCache(l2_path=_l2_path()))
    t0 = time.monotonic()
    cl = claude_files(config)
    cx = codex_files(_codex_home())
    r = cache.refresh(claude=cl, codex=cx)
    now = time.time()
    payload = build_dashboard(r.entries, r.codex_rate_limits,
                              config.subscriptions, now=now, days=days)
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
    await _ensure_scan(days)
    snap = _state.get("snapshot")
    if snap is None:
        if _state.get("error"):
            return JSONResponse({"scan_meta": {"state": "error", "error": _state["error"]}},
                                status_code=200)
        return JSONResponse({"scan_meta": {"state": "scanning"}}, status_code=202,
                            headers={"Retry-After": "2"})
    out = dict(snap)
    meta = dict(out["scan_meta"])
    if _state.get("scanning"):
        meta["state"] = "scanning"     # last-good＋stale 指示（design §10）
    if _state.get("error"):
        meta["state"] = "error"
        meta["error"] = _state["error"]
    out["scan_meta"] = meta
    return out

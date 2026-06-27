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

from fledge_sidecar.api.codex_usage import fetch_codex_usage
from fledge_sidecar.app_config import AppConfig, default_config_path
from fledge_sidecar.usage.aggregator import build_dashboard
from fledge_sidecar.usage.cache import UsageCache
from fledge_sidecar.usage.scanner import _scan_claude, codex_files

logger = logging.getLogger(__name__)
router = APIRouter()

SCAN_TIMEOUT = 120.0
STALE_AFTER = 25.0   # 上次掃描超過此秒數才再觸發（30s 輪詢 → 每輪都新鮮）
# Codex 實時額度後端合併 floor：前端 force-on-open 可能因多視窗/重掛短時間多次觸發，
# 此 floor 內沿用快取、不重打未公開端點（Codex 對抗式審查 finding #1）
CODEX_USAGE_MIN_INTERVAL_SEC = 60.0
# 失敗結果用遠短的 TTL——使用者登入 codex 後能很快恢復（finding #2）
CODEX_USAGE_FAIL_INTERVAL_SEC = 10.0

_state: dict = {}
_codex_state: dict = {}        # {result, fetched_at}——codex 實時額度的合併快取
_codex_lock = asyncio.Lock()   # 序列化冷啟並發 miss：先進者填快取、後到者沿用（finding #1）


def reset_state_for_tests() -> None:
    """測試隔離：清掉模組級 snapshot/lock。"""
    _state.clear()
    _codex_state.clear()


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
    cl, _ = _scan_claude(config)
    cx = codex_files(_codex_home())
    r = cache.refresh(claude=cl, codex=cx)
    now = time.time()
    payload = build_dashboard(r.entries, config.subscriptions, now=now, days=days,
                              roots=[r["path"] for r in config.roots])
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


def _codex_floor_fresh(now: float) -> bool:
    """快取是否仍在 floor 內（live 用 60s、失敗用 10s——失敗快恢復）。"""
    res = _codex_state.get("result")
    if res is None:
        return False
    floor = (CODEX_USAGE_MIN_INTERVAL_SEC if res.get("source") == "live"
             else CODEX_USAGE_FAIL_INTERVAL_SEC)
    return now - _codex_state.get("fetched_at", 0.0) < floor


@router.get("/usage/codex")
async def usage_codex():
    """Codex 實時額度（live）。節奏由前端控制（開啟即抓、開著每 15 分鐘、重開強制重抓）；
    後端以 source-aware floor 合併爆量請求。失敗回 typed unavailable，**不 fallback 陳舊本地快照**
    （會重現原失準 bug）——前端據 source/failure_reason 誠實呈現。"""
    if _codex_floor_fresh(time.time()):
        return _codex_state["result"]
    # 取鎖後重檢——冷啟並發 miss 由先進者填快取、後到者直接沿用，不各打一次上游（finding #1）
    async with _codex_lock:
        if _codex_floor_fresh(time.time()):
            return _codex_state["result"]
        now = time.time()
        result = await asyncio.to_thread(fetch_codex_usage, _codex_home(), now)
        _codex_state["result"] = result
        _codex_state["fetched_at"] = now
        return result

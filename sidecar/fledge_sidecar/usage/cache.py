"""L1/L2 瘦條目快取（design §9）。

失效信號 (st_size, st_mtime_ns)；假設兩源 jsonl 在本機 APFS、append-only。
size 縮小或 mtime 倒退 → 視為重寫、整檔重解析。
L2 schema version 不符/損壞 → 刪除重建；pricing_version 不符 → 只重算 cost 不重 parse。
寫入 atomic（tmp + os.replace）、generation 單調遞增。
"""
from __future__ import annotations

import dataclasses
import json
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from fledge_sidecar.usage import pricing
from fledge_sidecar.usage.parser import (CodexFileResult, UsageEntry,
                                         parse_claude_file, parse_codex_file)

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1


@dataclass
class FileCacheEntry:
    size: int
    mtime_ns: int
    source: str                      # 'claude' | 'codex'
    entries: list[UsageEntry] = field(default_factory=list)
    skipped: int = 0
    rate_limits: dict | None = None  # codex 檔內最後 rate_limits
    rate_limits_ts: float = 0.0


@dataclass
class RefreshResult:
    entries: list[UsageEntry]
    skipped_lines: int
    parsed_files: int
    total_files: int
    codex_rate_limits: dict | None   # 全源最新一筆
    generation: int


class UsageCache:
    """執行緒安全：refresh（含 _save_l2）以 _lock 序列化——同 process 內 read-check-write
    無交錯（封 TOCTOU）。跨 process（兩個 app 實例）僅 best-effort：atomic os.replace 保證
    不毀檔、generation 比對降低舊蓋新機率；單實例假設見 memory fledge-single-instance-assumption。"""

    def __init__(self, l2_path: Path):
        self._l2_path = l2_path
        self._files: dict[str, FileCacheEntry] = {}
        self._generation = 0
        self._lock = threading.Lock()
        self._load_l2()

    # ---- L2 ----
    def _load_l2(self) -> None:
        try:
            data = json.loads(self._l2_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if data.get("version") != SCHEMA_VERSION:
            logger.warning("usage L2 schema 不符，重建")
            return
        self._generation = int(data.get("generation") or 0)
        reprice = data.get("pricing_version") != pricing.PRICING_VERSION
        for rp, fc in (data.get("files") or {}).items():
            entries = [UsageEntry(**e) for e in fc.get("entries", [])]
            if reprice:
                entries = [self._reprice(e) for e in entries]
            self._files[rp] = FileCacheEntry(
                size=fc["size"], mtime_ns=fc["mtime_ns"], source=fc["source"],
                entries=entries, skipped=fc.get("skipped", 0),
                rate_limits=fc.get("rate_limits"), rate_limits_ts=fc.get("rate_limits_ts", 0.0))
        if reprice:
            logger.info("pricing_version 更新 → 已重算 %d 檔 cost（未重 parse）", len(self._files))

    @staticmethod
    def _reprice(e: UsageEntry) -> UsageEntry:
        """定價更新：保留 token 欄位、僅重算 cost（design §9）。"""
        if e.source == "claude":
            norm = pricing.normalize_claude_model(e.model)
            if norm is None:
                return dataclasses.replace(e, cost=0.0, missing_pricing=True)
            cost, missing = pricing.claude_cost(norm, e.input_tokens, e.output_tokens,
                                                e.cache_create_5m, e.cache_create_1h,
                                                e.cache_read_tokens)
        else:
            if e.model == "unknown-codex":
                return dataclasses.replace(e, cost=0.0, missing_pricing=True)
            cost, missing = pricing.codex_cost(e.model, e.input_tokens,
                                               e.cache_read_tokens, e.output_tokens)
        return dataclasses.replace(e, cost=cost, missing_pricing=missing)

    def _save_l2(self) -> None:
        # 防舊蓋新（design §9）：磁碟上 generation 較大（如另一 sidecar 實例已寫入）→ 跳過
        try:
            disk = json.loads(self._l2_path.read_text(encoding="utf-8"))
            if int(disk.get("generation") or 0) >= self._generation:
                logger.warning("usage L2 磁碟 generation 較新，跳過落盤")
                return
        except (OSError, json.JSONDecodeError, ValueError):
            pass
        payload = {
            "version": SCHEMA_VERSION,
            "pricing_version": pricing.PRICING_VERSION,
            "generation": self._generation,
            "files": {rp: {
                "size": fc.size, "mtime_ns": fc.mtime_ns, "source": fc.source,
                "skipped": fc.skipped, "rate_limits": fc.rate_limits,
                "rate_limits_ts": fc.rate_limits_ts,
                "entries": [dataclasses.asdict(e) for e in fc.entries],
            } for rp, fc in self._files.items()},
        }
        self._l2_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._l2_path.with_name(self._l2_path.name + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._l2_path)

    # ---- refresh ----
    def refresh(self, claude: list[Path], codex: list[Path]) -> RefreshResult:
        with self._lock:
            return self._refresh_locked(claude, codex)

    def _refresh_locked(self, claude: list[Path], codex: list[Path]) -> RefreshResult:
        wanted: set[str] = set()
        to_parse: list[tuple[str, str, Path]] = []   # (source, realpath, path)
        for source, paths in (("claude", claude), ("codex", codex)):
            for p in paths:
                rp = str(p)
                wanted.add(rp)
                try:
                    st = os.stat(p)
                except OSError:
                    self._files.pop(rp, None)
                    continue
                cached = self._files.get(rp)
                if cached and cached.size == st.st_size and cached.mtime_ns == st.st_mtime_ns:
                    continue
                to_parse.append((source, rp, p))
        # bounded pool 平行 parse（design §16.1：並發模型本身，非超標補救）
        if to_parse:
            with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 1)) as pool:
                results = list(pool.map(self._parse_one, to_parse))
            for rp, fc in results:
                if fc is not None:
                    self._files[rp] = fc
        removed = [k for k in self._files if k not in wanted]   # 檔案消失/落選 canonical
        for rp in removed:
            del self._files[rp]
        changed = bool(to_parse) or bool(removed)
        if changed:   # 無變動輪詢不落盤、不前進 generation（debounce 等效，design §9）
            self._generation += 1
            self._save_l2()
        all_entries: list[UsageEntry] = []
        skipped_lines = 0
        rl: dict | None = None
        rl_ts = -1.0
        for fc in self._files.values():
            all_entries.extend(fc.entries)
            skipped_lines += fc.skipped
            if fc.rate_limits is not None and fc.rate_limits_ts > rl_ts:
                rl, rl_ts = fc.rate_limits, fc.rate_limits_ts
        return RefreshResult(entries=all_entries, skipped_lines=skipped_lines,
                             parsed_files=len(to_parse), total_files=len(self._files),
                             codex_rate_limits=rl, generation=self._generation)

    def _parse_one(self, item: tuple[str, str, Path]) -> tuple[str, FileCacheEntry | None]:
        source, rp, p = item
        # parser 契約只保證「內容層」不拋；I/O race（stat 後檔案被搬走，如 codex 歸檔）
        # 在此吸收：本輪略過該檔、下輪掃描自癒——不讓單檔 race 變成整面儀表板 error
        try:
            st = os.stat(p)
            if source == "claude":
                entries, skipped = parse_claude_file(p)
                return rp, FileCacheEntry(st.st_size, st.st_mtime_ns, source, entries, skipped)
            r: CodexFileResult = parse_codex_file(p)
            return rp, FileCacheEntry(st.st_size, st.st_mtime_ns, source, r.entries, r.skipped,
                                      r.rate_limits, r.last_ts)
        except OSError as exc:
            logger.warning("usage 檔案讀取失敗（本輪略過）：%s（%s）", p, exc)
            return rp, None

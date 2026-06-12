import json
from pathlib import Path

from fledge_sidecar.usage import pricing
from fledge_sidecar.usage.cache import UsageCache


def _write_claude(tmp_path: Path, name: str, n: int = 1) -> Path:
    line = json.dumps({"type": "assistant", "timestamp": "2026-06-10T01:00:00Z",
                       "cwd": "/p", "sessionId": "s", "requestId": "r",
                       "message": {"id": "m", "model": "claude-opus-4-8",
                                   "usage": {"input_tokens": 100, "output_tokens": 1}}})
    f = tmp_path / name
    f.write_text("\n".join([line] * n), encoding="utf-8")
    return f


def test_refresh_parses_then_hits_cache(tmp_path: Path):
    f = _write_claude(tmp_path, "a.jsonl")
    cache = UsageCache(l2_path=tmp_path / "usage-v1.json")
    r1 = cache.refresh(claude=[f], codex=[])
    assert len(r1.entries) == 1 and r1.parsed_files == 1
    r2 = cache.refresh(claude=[f], codex=[])
    assert r2.parsed_files == 0      # (size, mtime_ns) 未變 → 不重 parse
    assert len(r2.entries) == 1


def test_l2_roundtrip_and_schema_version_rebuild(tmp_path: Path):
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    UsageCache(l2_path=l2).refresh(claude=[f], codex=[])
    assert l2.exists()
    cache2 = UsageCache(l2_path=l2)   # 載入即熱
    r = cache2.refresh(claude=[f], codex=[])
    assert r.parsed_files == 0
    # schema version 不符 → 整檔重建（重 parse）
    data = json.loads(l2.read_text(encoding="utf-8"))
    data["version"] = 999
    l2.write_text(json.dumps(data), encoding="utf-8")
    cache3 = UsageCache(l2_path=l2)
    assert cache3.refresh(claude=[f], codex=[]).parsed_files == 1


def test_pricing_version_mismatch_reprices_without_reparse(tmp_path: Path, monkeypatch):
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    UsageCache(l2_path=l2).refresh(claude=[f], codex=[])
    old_cost = json.loads(l2.read_text(encoding="utf-8"))["files"][str(f.resolve())]["entries"][0]["cost"]
    # 模擬定價更新：版本變 + opus 價格翻倍
    monkeypatch.setattr(pricing, "PRICING_VERSION", "test.2")
    monkeypatch.setitem(pricing.CLAUDE_PRICING, "claude-opus-4-8", (10.0, 50.0))
    cache2 = UsageCache(l2_path=l2)
    r = cache2.refresh(claude=[f], codex=[])
    assert r.parsed_files == 0                      # 不重 parse（design §9）
    assert abs(r.entries[0].cost - old_cost * 2) < 1e-12   # cost 已按新價重算


def test_generation_monotonic_and_atomic_write(tmp_path: Path):
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    c = UsageCache(l2_path=l2)
    c.refresh(claude=[f], codex=[])
    g1 = json.loads(l2.read_text(encoding="utf-8"))["generation"]
    _write_claude(tmp_path, "a.jsonl", n=2)  # 檔案成長
    c.refresh(claude=[f], codex=[])
    g2 = json.loads(l2.read_text(encoding="utf-8"))["generation"]
    assert g2 == g1 + 1
    assert not l2.with_name(l2.name + ".tmp").exists()  # 原子寫不留 tmp


def test_no_change_no_write_and_no_generation_bump(tmp_path: Path):
    # 無變動輪詢不落盤、generation 不前進（debounce 等效；design §9）
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    c = UsageCache(l2_path=l2)
    c.refresh(claude=[f], codex=[])
    mtime1 = l2.stat().st_mtime_ns
    g1 = json.loads(l2.read_text(encoding="utf-8"))["generation"]
    r = c.refresh(claude=[f], codex=[])
    assert r.parsed_files == 0
    assert l2.stat().st_mtime_ns == mtime1     # 未重寫
    assert r.generation == g1                   # 未前進


def test_stale_generation_does_not_overwrite_newer_l2(tmp_path: Path):
    # 磁碟上有更新（generation 較大、如另一實例寫入）→ 舊掃描不得覆蓋（design §9）
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    c = UsageCache(l2_path=l2)
    c.refresh(claude=[f], codex=[])
    data = json.loads(l2.read_text(encoding="utf-8"))
    data["generation"] = 999
    l2.write_text(json.dumps(data), encoding="utf-8")
    _write_claude(tmp_path, "a.jsonl", n=2)
    c.refresh(claude=[f], codex=[])             # c 的 generation 遠小於 999
    assert json.loads(l2.read_text(encoding="utf-8"))["generation"] == 999  # 保留較新者


def test_concurrent_refresh_is_serialized(tmp_path: Path):
    # 同 process 兩執行緒同時 refresh：_lock 序列化 → 同一變更只 bump 一次 generation
    from concurrent.futures import ThreadPoolExecutor as TPE
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    c = UsageCache(l2_path=l2)
    c.refresh(claude=[f], codex=[])
    g1 = json.loads(l2.read_text(encoding="utf-8"))["generation"]
    _write_claude(tmp_path, "a.jsonl", n=2)     # 一次變更
    with TPE(max_workers=2) as pool:
        list(pool.map(lambda _: c.refresh(claude=[f], codex=[]), range(2)))
    g2 = json.loads(l2.read_text(encoding="utf-8"))["generation"]
    assert g2 == g1 + 1                          # 後到者見無變動、不重複 bump


def test_corrupt_l2_binary_garbage_rebuilds(tmp_path: Path):
    # 斷電半寫情境：write_text 後無 fsync 即 os.replace，可能留下二進位垃圾
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    l2.write_bytes(b"\x00\xff\xfe garbage")
    c = UsageCache(l2_path=l2)                        # 不得拋例外（design §9 不擋啟動）
    r = c.refresh(claude=[f], codex=[])
    assert r.parsed_files == 1
    assert json.loads(l2.read_text(encoding="utf-8"))["version"] == 1  # 已重建


def test_corrupt_l2_structural_rebuilds_and_save_guard_survives(tmp_path: Path):
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    l2.write_text("[]", encoding="utf-8")             # 合法 JSON、結構錯
    c = UsageCache(l2_path=l2)
    r = c.refresh(claude=[f], codex=[])               # _save_l2 guard 也不得炸
    assert r.parsed_files == 1
    assert json.loads(l2.read_text(encoding="utf-8"))["version"] == 1


def test_schema_mismatch_rebuild_actually_persists(tmp_path: Path):
    # 升版情境：舊 schema 帶高 generation——guard 不採信跨代 generation，否則永久落不了盤
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    l2.write_text(json.dumps({"version": 999, "generation": 50, "files": {}}), encoding="utf-8")
    c = UsageCache(l2_path=l2)
    c.refresh(claude=[f], codex=[])
    disk = json.loads(l2.read_text(encoding="utf-8"))
    assert disk["version"] == 1 and disk["generation"] >= 1


def test_removed_file_and_codex_rate_limits_passthrough(tmp_path: Path):
    # removed/ghost 路徑：檔案消失 → 條目消失且觸發落盤；codex rate_limits 經 cache 傳遞
    f = _write_claude(tmp_path, "a.jsonl")
    cx = tmp_path / "rollout-1.jsonl"
    cx.write_text("\n".join([
        json.dumps({"type": "session_meta", "payload": {"id": "s1", "cwd": "/p"}}),
        json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.5", "cwd": "/p"}}),
        json.dumps({"timestamp": "2026-06-10T02:00:00Z", "type": "event_msg", "payload": {
            "type": "token_count",
            "info": {"last_token_usage": {"input_tokens": 10, "cached_input_tokens": 0,
                                          "output_tokens": 1, "total_tokens": 11},
                     "total_token_usage": {"input_tokens": 10, "cached_input_tokens": 0,
                                           "output_tokens": 1, "total_tokens": 11}},
            "rate_limits": {"plan_type": "plus"}}}),
    ]), encoding="utf-8")
    l2 = tmp_path / "usage-v1.json"
    c = UsageCache(l2_path=l2)
    r1 = c.refresh(claude=[f], codex=[cx])
    assert r1.codex_rate_limits == {"plan_type": "plus"}
    f.unlink()
    r2 = c.refresh(claude=[f], codex=[cx])            # 已消失仍在掃描清單 → ghost pop＋落盤
    assert all(e.source == "codex" for e in r2.entries)
    assert r2.generation == r1.generation + 1         # ghost 移除觸發 bump


def test_l2_file_mode_owner_only(tmp_path: Path):
    # 階段 10 守門 BLOCKER：L2 含成本與絕對路徑，預設 umask 會落 0644 → 必須 0600
    f = _write_claude(tmp_path, "a.jsonl")
    l2 = tmp_path / "usage-v1.json"
    UsageCache(l2_path=l2).refresh(claude=[f], codex=[])
    assert (l2.stat().st_mode & 0o777) == 0o600

import json
from pathlib import Path

from fledge_sidecar.usage.parser import parse_claude_file, parse_codex_file


def _claude_line(model="claude-opus-4-8", msg_id="m1", req="r1", *, sidechain=False,
                 usage=None, cwd="/p/alpha", ts="2026-06-10T01:00:00.000Z"):
    return json.dumps({
        "type": "assistant", "timestamp": ts, "cwd": cwd, "sessionId": "s1",
        "requestId": req, "isSidechain": sidechain,
        "message": {"id": msg_id, "model": model, "usage": usage or {
            "input_tokens": 100, "output_tokens": 50,
            "cache_read_input_tokens": 30, "cache_creation_input_tokens": 20,
            "cache_creation": {"ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 0},
        }},
    })


def test_claude_parser_extracts_entry_and_skips_garbage(tmp_path: Path):
    f = tmp_path / "a.jsonl"
    f.write_text("\n".join([
        _claude_line(),
        '{"type":"user","message":{"role":"user"}}',   # 無 usage → 跳過
        "not-json-at-all",                              # 壞行 → skipped+1
        '{"type":"assistant","message":{"usage": "oops"}}',  # usage 非物件 → 跳過不計壞行
    ]), encoding="utf-8")
    entries, skipped = parse_claude_file(f)
    assert len(entries) == 1 and skipped == 1
    e = entries[0]
    assert e.source == "claude" and e.model == "claude-opus-4-8"
    assert (e.input_tokens, e.output_tokens, e.cache_read_tokens) == (100, 50, 30)
    assert (e.cache_create_5m, e.cache_create_1h) == (20, 0)
    assert e.project == "/p/alpha" and e.cost > 0
    assert e.sidechain is False


def test_claude_sidechain_flag(tmp_path: Path):
    f = tmp_path / "a.jsonl"
    f.write_text(_claude_line(sidechain=True), encoding="utf-8")
    entries, _ = parse_claude_file(f)
    assert entries[0].sidechain is True


def test_claude_cache_aggregate_fallback_when_no_nested(tmp_path: Path):
    # 只有 aggregate cache_creation_input_tokens → 全視為 5m（design §7 precedence 2）
    f = tmp_path / "a.jsonl"
    f.write_text(_claude_line(usage={
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_input_tokens": 0, "cache_creation_input_tokens": 1_000_000,
    }), encoding="utf-8")
    entries, _ = parse_claude_file(f)
    assert entries[0].cache_create_5m == 1_000_000 and entries[0].cache_create_1h == 0
    assert abs(entries[0].cost - 6.25) < 1e-9  # 1M * 1.25 * $5 / 1M


def test_claude_synthetic_unpriced(tmp_path: Path):
    f = tmp_path / "a.jsonl"
    f.write_text(_claude_line(model="<synthetic>"), encoding="utf-8")
    entries, _ = parse_claude_file(f)
    assert entries[0].cost == 0.0 and entries[0].missing_pricing is True


def _codex_lines(model="gpt-5.5", with_meta=True):
    lines = []
    if with_meta:
        lines.append(json.dumps({"type": "session_meta", "payload": {
            "id": "sess-1", "cwd": "/p/beta", "originator": "Claude Code"}}))
    lines.append(json.dumps({"type": "turn_context", "payload": {"model": model, "cwd": "/p/beta"}}))
    lines.append(json.dumps({"timestamp": "2026-06-10T02:00:00.000Z", "type": "event_msg", "payload": {
        "type": "token_count",
        "info": {"total_token_usage": {"input_tokens": 1000, "cached_input_tokens": 400,
                                       "output_tokens": 50, "total_tokens": 1050},
                 "last_token_usage": {"input_tokens": 1000, "cached_input_tokens": 400,
                                      "output_tokens": 50, "total_tokens": 1050}},
        "rate_limits": {"primary": {"used_percent": 4.0, "window_minutes": 300, "resets_at": 1780153711},
                        "secondary": {"used_percent": 6.0, "window_minutes": 10080, "resets_at": 1780185241},
                        "plan_type": "plus"}}}))
    lines.append(json.dumps({"timestamp": "2026-06-10T02:05:00.000Z", "type": "event_msg", "payload": {
        "type": "token_count",
        "info": {"total_token_usage": {"input_tokens": 1500, "cached_input_tokens": 700,
                                       "output_tokens": 80, "total_tokens": 1580}},
        "rate_limits": {"primary": {"used_percent": 5.0, "window_minutes": 300, "resets_at": 1780153711},
                        "secondary": {"used_percent": 6.0, "window_minutes": 10080, "resets_at": 1780185241},
                        "plan_type": "plus"}}}))
    return "\n".join(lines)


def test_codex_parser_delta_and_cumulative_diff(tmp_path: Path):
    f = tmp_path / "rollout-x.jsonl"
    f.write_text(_codex_lines(), encoding="utf-8")
    result = parse_codex_file(f)
    assert len(result.entries) == 2
    e1, e2 = result.entries
    assert (e1.input_tokens, e1.cache_read_tokens, e1.output_tokens) == (1000, 400, 50)
    # 第二筆只有累計 → 差分：input 1500-1000=500, cached 700-400=300, output 80-50=30
    assert (e2.input_tokens, e2.cache_read_tokens, e2.output_tokens) == (500, 300, 30)
    assert e2.model == "gpt-5.5" and e2.project == "/p/beta" and e2.session_id == "sess-1"
    assert result.rate_limits is not None and result.rate_limits["plan_type"] == "plus"
    assert result.session_id == "sess-1"


def test_codex_no_model_is_unpriced(tmp_path: Path):
    f = tmp_path / "rollout-y.jsonl"
    # 無 turn_context（早期格式）→ model unknown-codex、cost=0、missing（design §5.2）
    lines = _codex_lines().splitlines()
    del lines[1]  # 移除 turn_context
    f.write_text("\n".join(lines), encoding="utf-8")
    result = parse_codex_file(f)
    assert result.entries[0].model == "unknown-codex"
    assert result.entries[0].cost == 0.0 and result.entries[0].missing_pricing is True


def test_codex_missing_session_meta_uses_realpath_key(tmp_path: Path):
    f = tmp_path / "rollout-z.jsonl"
    lines = _codex_lines(with_meta=False)
    f.write_text(lines, encoding="utf-8")
    result = parse_codex_file(f)
    assert result.session_id == str(f.resolve())  # design §5.2 fallback


def test_codex_rate_limits_last_one_wins(tmp_path: Path):
    f = tmp_path / "rollout-x.jsonl"
    f.write_text(_codex_lines(), encoding="utf-8")
    result = parse_codex_file(f)
    assert result.rate_limits["primary"]["used_percent"] == 5.0  # 第二筆（最後）贏


def test_codex_cumulative_diff_clamps_negative(tmp_path: Path):
    # 後筆累計缺鍵 → 差分不得為負（金流入口 clamp）
    lines = _codex_lines().splitlines()
    bad = json.loads(lines[3])
    bad["payload"]["info"]["total_token_usage"] = {"input_tokens": 1500}  # 缺 cached/output
    bad["payload"]["info"].pop("last_token_usage", None)
    lines[3] = json.dumps(bad)
    f = tmp_path / "rollout-neg.jsonl"
    f.write_text("\n".join(lines), encoding="utf-8")
    result = parse_codex_file(f)
    e2 = result.entries[1]
    assert e2.cache_read_tokens == 0 and e2.output_tokens == 0  # clamp 而非 -400/-30


def test_codex_bad_timestamp_skipped_not_epoch0(tmp_path: Path):
    lines = _codex_lines().splitlines()
    bad = json.loads(lines[2])
    bad["timestamp"] = "garbage"
    lines[2] = json.dumps(bad)
    f = tmp_path / "rollout-badts.jsonl"
    f.write_text("\n".join(lines), encoding="utf-8")
    result = parse_codex_file(f)
    assert len(result.entries) == 1 and result.skipped == 1  # 壞 ts 跳過計數、不產 1970 條目


def test_claude_chinese_cwd_preserved(tmp_path: Path):
    f = tmp_path / "a.jsonl"
    f.write_text(_claude_line(cwd="/Users/demo/work/食譜整理"), encoding="utf-8")
    entries, _ = parse_claude_file(f)
    assert entries[0].project == "/Users/demo/work/食譜整理"  # 中文路徑原樣保留（spec §15）

import json
from datetime import datetime
from pathlib import Path

from fledge_sidecar.usage.parser import parse_claude_file, parse_codex_file, parse_pi_file


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



def test_bare_haiku_alias_with_aggregate_cache_creation_crosses_long_context(tmp_path: Path):
    """端到端：舊格式只給合計的 cache_creation（解析成 5m）、模型寫裸別名 haiku（正規化成
    claude-haiku-5-5）。input 只有 1，靠 cache 寫入把長度推過 100,000 → 五欄整組用分段價。"""
    f = tmp_path / "a.jsonl"
    f.write_text(_claude_line(model="haiku", usage={
        "input_tokens": 1, "output_tokens": 0,
        "cache_read_input_tokens": 0, "cache_creation_input_tokens": 100_000,
    }), encoding="utf-8")
    entries, _ = parse_claude_file(f)
    assert abs(entries[0].cost - (1 * 0.5 + 100_000 * 0.625) / 1e6) < 1e-12

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


# ── Pi session 檔（Pi spec §7；fixture 是本機真實 session 去識別化的節錄＋合成的 branch_summary／usage／帶模型的 compaction）──
PI_FIXTURE = Path(__file__).parent / "fixtures" / "pi" / "session-a.jsonl"


def _pi_line(entry_type="message", *, eid="x1", ts="2026-10-27T03:00:00.000Z", role="assistant",
             provider="localai", model="m", usage=None, **extra):
    u = usage if usage is not None else {"input": 10, "output": 2, "cacheRead": 3, "cacheWrite": 4,
                                         "cost": {"total": 0}}
    d = {"type": entry_type, "timestamp": ts, **extra}
    if eid is not None:
        d["id"] = eid
    if entry_type == "message":
        d["message"] = {"role": role, "usage": u, "provider": provider, "model": model}
    else:
        d["usage"] = u
        if provider:
            d["provider"] = provider
        if model:
            d["model"] = model
    return json.dumps(d)


def _pi_file(tmp_path: Path, lines: list[str], header=True) -> Path:
    f = tmp_path / "s.jsonl"
    head = [json.dumps({"type": "session", "version": 3, "id": "sid", "cwd": "/p/pi",
                        "timestamp": "2026-10-27T02:00:00.000Z"})] if header else []
    f.write_text("\n".join(head + lines), encoding="utf-8")
    return f


def test_pi_parser_counts_the_four_billable_kinds_exactly():
    """四類計費條目逐個加（Pi spec §5.10／§7）：fixture 有 3 則 assistant（含一則 0 token 的 error）、
    2 則 compaction（一則沒模型、一則帶模型）、1 則 branch_summary、1 則 usage(cache_warm)；
    user／toolResult／system／model_change／thinking_level_change／context_edit 不計；1 壞行計 skipped。"""
    entries, skipped = parse_pi_file(PI_FIXTURE)
    assert (len(entries), skipped) == (7, 1)
    assert {e.source for e in entries} == {"pi"}
    assert sum(e.input_tokens for e in entries) == 22866
    assert sum(e.output_tokens for e in entries) == 5900
    assert sum(e.cache_read_tokens for e in entries) == 10011
    assert sum(e.cache_create_5m for e in entries) == 100
    assert {e.cache_create_1h for e in entries} == {0}
    assert abs(sum(e.cost for e in entries) - 0.25) < 1e-9      # 信任 Pi 的 cost.total（§5.3）
    assert {e.missing_pricing for e in entries} == {False}
    assert {e.sidechain for e in entries} == {False}
    assert {e.project for e in entries} == {"/p/alpha"}
    assert {e.session_id for e in entries} == {"pi-sess-a"}


def test_pi_parser_origin_ts_is_the_header_timestamp():
    entries, _ = parse_pi_file(PI_FIXTURE)
    expected = datetime.fromisoformat("2026-10-27T02:00:30.120+00:00").timestamp()
    assert {e.origin_ts for e in entries} == {expected}


def test_pi_summary_entries_without_model_go_to_pi_summary_even_after_a_model_change():
    """沒帶 provider／model 的 compaction／branch_summary 固定歸 pi/summary（§7：不推定模型）——
    fixture 在它們前面有兩則 model_change（第二則切到 localai-omlx）也一樣；帶模型的 compaction 才歸那個模型。"""
    by_id = {e.dedup_key.split(":")[1]: e for e in parse_pi_file(PI_FIXTURE)[0]}
    assert by_id["1b587154"].model == "pi/summary"            # compaction（真檔）
    assert by_id["a2a2a2a2"].model == "pi/summary"            # branch_summary
    assert by_id["c4c4c4c4"].model == "localai-omlx/qwen3.8-27b-mlx-8bit"   # 帶模型的 compaction（日後版本）
    assert by_id["b3b3b3b3"].model == "localai-omlx/qwen3.8-27b-mlx-8bit"   # usage(cache_warm)
    assert by_id["ad0e80e7"].model == "localai/qwen3.8-27b-q8"              # assistant：provider/model
    assert by_id["ad0e80e7"].ts == datetime.fromisoformat("2026-10-27T02:01:05.074+00:00").timestamp()


def test_pi_dedup_key_is_prefix_id_and_timestamp(tmp_path: Path):
    """§5.5：`pi:{id}:{timestamp}`；缺 id 或 timestamp 的條目 dedup_key 空字串（不去重）。"""
    f = _pi_file(tmp_path, [_pi_line(eid="aa", ts="2026-10-27T03:00:00.000Z"), _pi_line(eid=None)])
    entries, skipped = parse_pi_file(f)
    assert skipped == 0
    assert [e.dedup_key for e in entries] == ["pi:aa:2026-10-27T03:00:00.000Z", ""]


def test_pi_bad_timestamp_skipped_and_non_numeric_cost_is_zero(tmp_path: Path):
    f = _pi_file(tmp_path, [
        _pi_line(ts="not-a-time"),                                         # 壞 ts → skipped
        _pi_line(usage={"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": "abc"}}),
        _pi_line(usage={"input": 1, "output": 1}),                         # 沒有 cost 物件 → 0
        _pi_line("usage", provider="", model="", kind="cache_warm"),        # usage 條目沒帶模型
        _pi_line(role="user"),                                             # 非 assistant 的 message 不計
    ])
    entries, skipped = parse_pi_file(f)
    assert skipped == 1
    assert [e.cost for e in entries] == [0.0, 0.0, 0.0]
    assert [e.cache_read_tokens for e in entries] == [0, 0, 3]
    assert entries[2].model == "pi/unknown"


def test_pi_file_without_header_still_parses_with_empty_project(tmp_path: Path):
    """header 缺（或不是第一行）時 project 空、origin_ts 0、session_id 退回 realpath——不拋、不整檔跳過。"""
    f = _pi_file(tmp_path, [_pi_line()], header=False)
    entries, skipped = parse_pi_file(f)
    assert skipped == 0 and len(entries) == 1
    assert (entries[0].project, entries[0].origin_ts, entries[0].session_id) == ("", 0.0, str(f.resolve()))


def test_pi_chinese_cwd_preserved(tmp_path: Path):
    f = tmp_path / "s.jsonl"
    f.write_text("\n".join([
        json.dumps({"type": "session", "version": 3, "id": "sid", "cwd": "/Users/u/創意發想",
                    "timestamp": "2026-10-27T02:00:00.000Z"}, ensure_ascii=False),
        _pi_line(),
    ]), encoding="utf-8")
    entries, _ = parse_pi_file(f)
    assert entries[0].project == "/Users/u/創意發想"


def test_pi_non_finite_numbers_do_not_abort_the_file(tmp_path: Path):
    """JSON 的 1e309 經 json.loads 變成 inf：int(inf) 是 OverflowError，不攔的話整輪掃描掛掉（Codex plan R1 high）。
    非有限的 token／cost 一律當 0，該條目照常計入、後面的條目照常解析。"""
    f = _pi_file(tmp_path, [
        '{"type":"message","id":"n1","timestamp":"2026-10-27T03:00:00.000Z","message":{"role":"assistant","provider":"p","model":"m",'
        '"usage":{"input":1e309,"output":2,"cacheRead":-1e309,"cacheWrite":0,"cost":{"total":1e309}}}}',
        _pi_line(eid="n2"),
    ])
    entries, skipped = parse_pi_file(f)
    assert skipped == 0 and len(entries) == 2
    assert (entries[0].input_tokens, entries[0].output_tokens, entries[0].cache_read_tokens, entries[0].cost) == (0, 2, 0, 0.0)


def test_pi_huge_integer_cost_does_not_abort_the_file(tmp_path: Path):
    """合法 JSON 的 401 位整數：json.loads 是 int、float(int) 拋 OverflowError（不是 inf、走不到 isfinite）——
    Codex plan R2 high；歸 0、後面的條目照常。"""
    huge = "1" + "0" * 400
    f = _pi_file(tmp_path, [
        '{"type":"message","id":"h1","timestamp":"2026-10-27T03:00:00.000Z","message":{"role":"assistant","provider":"p","model":"m",'
        '"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":' + huge + '}}}}',
        '{"type":"usage","id":"h2","timestamp":"2026-10-27T03:00:01.000Z","provider":"p","model":"m","kind":"cache_warm",'
        '"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":-' + huge + '}}}',
        _pi_line(eid="h3"),
    ])
    entries, skipped = parse_pi_file(f)
    assert skipped == 0 and [e.cost for e in entries] == [0.0, 0.0, 0.0]


def test_pi_header_only_honoured_on_the_first_line(tmp_path: Path):
    """header 不在第一行：整檔 project 空、origin_ts 0——後面出現的 session 行不會改寫歸屬（不是 Pi 的格式，當普通行略過）。"""
    late = json.dumps({"type": "session", "version": 3, "id": "late", "cwd": "/p/late", "timestamp": "2026-10-27T02:00:00.000Z"})
    f = _pi_file(tmp_path, [_pi_line(eid="a1"), late, _pi_line(eid="a2")], header=False)
    entries, skipped = parse_pi_file(f)
    assert skipped == 0 and [e.project for e in entries] == ["", ""]
    assert {e.origin_ts for e in entries} == {0.0}


def test_pi_version_mismatch_still_parses_and_non_dict_usage_is_skipped(tmp_path: Path):
    """version≠3 仍嘗試解析（欄位都在就照常）；usage 不是物件的條目跳過、不計 skipped（跟 claude 同語義）。"""
    f = tmp_path / "s.jsonl"
    f.write_text("\n".join([
        json.dumps({"type": "session", "version": 2, "id": "v2", "cwd": "/p/v2", "timestamp": "2026-10-27T02:00:00.000Z"}),
        _pi_line(eid="ok"),
        '{"type":"message","id":"bad","timestamp":"2026-10-27T03:00:00.000Z","message":{"role":"assistant","usage":"oops"}}',
        '{"type":"compaction","id":"bad2","timestamp":"2026-10-27T03:00:00.000Z","usage":[1,2]}',
    ]), encoding="utf-8")
    entries, skipped = parse_pi_file(f)
    assert skipped == 0 and [e.dedup_key for e in entries] == ["pi:ok:2026-10-27T03:00:00.000Z"]
    assert entries[0].project == "/p/v2"

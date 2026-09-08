"""票檔解析（design §2.2、§6.1 契約、§6.2 個案表）。

§6.2 的表是契約的**示例、不是窮舉**——表上沒列到的壞法一律依契約辦理：
回異常票、逐檔隔離、不隱藏。所以本檔除了逐個案，還有一條「餵任意二進位垃圾」的契約測試。
"""
import random

import pytest

from fledge_sidecar.tasks import parser as P

GOOD = "---\nstatus: doing\nsource: ai\ncreated: 2026-08-27\n---\n\n# 匯出的檔名要能自訂\n\n多行\n內文\n"


def test_well_formed_ticket_has_no_anomalies():
    t = P.parse_task("07-匯出檔名.md", GOOD)
    assert (t.number, t.status, t.source, t.created) == (7, "doing", "ai", "2026-08-27")
    assert t.title == "匯出的檔名要能自訂"
    assert t.body == "多行\n內文"
    assert t.anomalies == ()


def test_unknown_status_falls_back_to_todo_and_is_flagged():
    """design §6.2：status 值認不得 → 當 todo，標記異常。"""
    t = P.parse_task("01-x.md", "---\nstatus: 亂碼\nsource: ai\ncreated: 2026-08-27\n---\n\n# x\n")
    assert t.status == "todo"
    assert P.ANOMALY_STATUS_INVALID in t.anomalies


def test_bad_source_does_not_change_status():
    """design §6.1 的唯一規則：**只有 status 本身判不出來才 fallback**。

    沒有這條，`status: done` ＋ source 壞掉的票會被無聲重開——做完的事又跳回未完成。"""
    t = P.parse_task("01-x.md", "---\nstatus: done\nsource: 亂七八糟\ncreated: 2026-08-27\n---\n\n# x\n")
    assert t.status == "done"          # 沒有被打回 todo
    assert t.source == ""
    assert P.ANOMALY_SOURCE_INVALID in t.anomalies
    assert P.ANOMALY_STATUS_INVALID not in t.anomalies


def test_bad_created_is_flagged_and_blanked():
    t = P.parse_task("01-x.md", "---\nstatus: todo\nsource: me\ncreated: 昨天\n---\n\n# x\n")
    assert t.created == ""
    assert P.ANOMALY_CREATED_INVALID in t.anomalies


def test_missing_frontmatter_uses_defaults_with_one_anomaly():
    """整段缺 → 缺的用預設值、記一條。不逐欄再記一次，否則畫面上的記號變成雜訊。"""
    t = P.parse_task("01-x.md", "# 只有標題\n\n內文\n")
    assert (t.status, t.source, t.created) == ("todo", "", "")
    assert t.anomalies == (P.ANOMALY_FRONTMATTER_MISSING,)
    assert t.title == "只有標題"


def test_unterminated_fence_counts_as_missing_frontmatter():
    t = P.parse_task("01-x.md", "---\nstatus: todo\n\n# 沒有收尾圍籬\n")
    assert P.ANOMALY_FRONTMATTER_MISSING in t.anomalies


def test_missing_title_falls_back_to_short_name():
    """design §6.2：沒有 `# ` 標題行 → 用檔名的短名當標題，標記異常。"""
    t = P.parse_task("07-匯出檔名要能自訂.md", "---\nstatus: todo\nsource: me\ncreated: 2026-08-27\n---\n\n沒有標題行\n")
    assert t.title == "匯出檔名要能自訂"
    assert P.ANOMALY_TITLE_MISSING in t.anomalies


def test_missing_number_prefix_is_flagged_but_shown():
    """design §6.2：檔名沒有數字前綴 → 顯示，編號欄空白，標記異常。"""
    t = P.parse_task("隨手記的.md", GOOD)
    assert t.number is None
    assert P.ANOMALY_NUMBER_MISSING in t.anomalies
    assert t.title == "匯出的檔名要能自訂"   # 其他欄位照常解析，不因編號缺失而放棄


def test_contract_never_raises_on_arbitrary_bytes():
    """契約 1（design §6.1）：對任何檔案內容都不拋例外。

    §6.2 的表只是示例，表外的壞法（無效 UTF-8、控制字元、超長行、只有圍籬…）
    一律依契約辦理。這裡用亂數輸入掃一遍，斷言「不拋例外且拿得到一張票」。"""
    rnd = random.Random(20260829)
    payloads = [
        "", "---", "---\n", "---\n---", "---\n---\n", "\x00\x01\x02",
        "---\n" + "a" * 10000 + "\n---\n", "---\nstatus\n---\n# x",
        "---\n: 沒有 key\n---\n# x", "---\nstatus: todo\nstatus: done\n---\n# x",
        "#沒有空格的井號\n", "# \n", "---\nstatus:\n---\n",
    ]
    payloads += [
        bytes(rnd.randrange(256) for _ in range(rnd.randrange(1, 200))).decode("utf-8", errors="replace")
        for _ in range(200)
    ]
    for i, text in enumerate(payloads):
        for name in ("01-x.md", "x.md", "", "..md"):
            t = P.parse_task(name, text)       # 不得拋例外
            assert isinstance(t, P.Task)
            assert t.status in P.VALID_STATUS  # effective status 永遠是三個合法值之一


def test_duplicate_key_takes_the_last_one_without_raising():
    """重複欄位不在 §6.2 表上——依契約辦理即可，這裡釘住實際行為以免日後無聲改變。"""
    t = P.parse_task("01-x.md", "---\nstatus: todo\nstatus: done\nsource: me\ncreated: 2026-08-29\n---\n\n# x\n")
    assert t.status == "done"
    assert t.anomalies == ()


# ── 寫：短名 allowlist ＋ 檔案格式（design §7.1、§2.2）──────────────

def test_short_name_keeps_cjk_and_alnum():
    assert P.make_short_name("匯出的檔名要能自訂") == "匯出的檔名要能自訂"
    assert P.make_short_name("fix Bug_123") == "fix-Bug_123"
    assert P.make_short_name("ひらがな カタカナ 한글") == "ひらがな-カタカナ-한글"


def test_short_name_normalises_instead_of_rejecting():
    """`A/B` 是合法的使用者標題，應該正規化成 `A-B` 而不是被擋下來（design §7.1）。"""
    assert P.make_short_name("A/B") == "A-B"
    assert P.make_short_name("../../etc/passwd") == "etc-passwd"
    assert P.make_short_name("a\x00b") == "a-b"
    assert "/" not in P.make_short_name("///")


def test_short_name_falls_back_to_untitled():
    """正規化後為空時用 `untitled`，**不拒絕建票**（design §7.1）。"""
    for title in ("///", "。。。", "!!!", "   "):
        assert P.make_short_name(title) == P.SHORT_NAME_FALLBACK


def test_short_name_is_truncated():
    assert len(P.make_short_name("字" * 200)) == P.SHORT_NAME_MAX


def test_is_plain_name_rejects_traversal():
    """T1（design §7.1）：不含 `/`、不是 `.` 或 `..`。**與 allowlist 是兩道，不是二選一。**"""
    for bad in ("", ".", "..", "a/b", "/abs", "../x", "a\x00b"):
        assert not P.is_plain_name(bad)
    for ok in ("01-a.md", "沒有編號.md", "a-b_c.md"):
        assert P.is_plain_name(ok)


def test_rendered_ticket_reads_back_identically():
    """design §9：產生的檔案能被自己讀回，且沒有異常。"""
    text = P.render_task("匯出的檔名要能自訂", created="2026-08-29")
    t = P.parse_task("07-匯出的檔名要能自訂.md", text)
    assert t.title == "匯出的檔名要能自訂"
    assert (t.status, t.source, t.created, t.number) == ("todo", "me", "2026-08-29", 7)
    assert t.anomalies == ()


def test_rendered_title_is_flattened_to_one_line():
    """多行標題會讓 `# ` 之後的內容被當成內文，存回去再讀出來就不是原本那張票。"""
    text = P.render_task("第一行\n第二行", created="2026-08-29")
    assert P.parse_task("01-x.md", text).title == "第一行 第二行"


# ── replace_body（spec §5.1）──────────────────────────────────────────────

FM = b"---\nstatus: doing\nsource: ai\ncreated: 2026-09-01\n---\n"


def test_replace_body_keeps_frontmatter_bytes_and_rewrites_rest():
    """frontmatter 位元組一字不動，圍籬之後整段換掉（spec §4 的契約）。"""
    raw = FM + b"\n# old\n\nold body\n"
    out = P.replace_body(raw, "new", "new body")
    assert out == FM + b"\n# new\n\nnew body\n"
    assert out[: len(FM)] == raw[: len(FM)]


def test_replace_body_empty_body_matches_render_task_shape():
    """空內文時沒有尾隨空行——要與 render_task() 產生的形狀相同，否則 Fledge 自己建的票
    round-trip 會不過（Task 2）。"""
    raw = FM + b"\n# t\n\nbody\n"
    assert P.replace_body(raw, "t", "") == FM + b"\n# t\n"


def test_replace_body_keeps_invalid_utf8_in_frontmatter():
    """在位元組上做，frontmatter 裡的無效 UTF-8 不被換成 U+FFFD（spec §5.2）。"""
    raw = b"---\nstatus: todo\nsource: \xff\xfe\ncreated: 2026-09-01\n---\n\n# t\n"
    out = P.replace_body(raw, "t2", "")
    assert b"source: \xff\xfe" in out


def test_replace_body_collapses_title_to_one_line():
    raw = FM + b"\n# t\n"
    assert b"\n# a b\n" in P.replace_body(raw, "  a\n  b  ", "")


def test_replace_body_rejects_incomplete_fence():
    """closing fence 必須獨占一行。`---suffix`、`----`、沒有 fence、檔尾 fence 一律拒（spec §5.1）。"""
    for bad in (
        b"---\nstatus: todo\n---suffix\n# t\n",
        b"---\nstatus: todo\n----\n# t\n",
        b"no fence at all\n",
        b"---\nstatus: todo\n---",
        b"",
    ):
        with pytest.raises(ValueError):
            P.replace_body(bad, "t", "")


def test_replace_body_rejects_empty_title():
    with pytest.raises(ValueError):
        P.replace_body(FM + b"\n# t\n", "   \n  ", "")

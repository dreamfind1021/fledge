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

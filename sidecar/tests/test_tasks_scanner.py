"""tasks 的路徑邊界 resolver 與未完成計數（design §7.1、§6.3）。

resolver 是**所有端點共用的唯一入口**，所以它的拒絕條件在 T1 就要測滿——T2／T3 的
端點只是接上它，不會再重寫一份。
"""
import errno
import json
import os
import stat
import threading
import time

import pytest

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.tasks import scanner

TICKET = "---\nstatus: {status}\nsource: ai\ncreated: 2026-08-29\n---\n\n# {title}\n"


def _setup(tmp_path, *, project="proj"):
    """造一個 root ＋ 一個專案，回 (config, 專案路徑)。"""
    root = tmp_path / "root"
    proj = root / project
    proj.mkdir(parents=True)
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(
        json.dumps(
            {
                "version": 1,
                "accounts": {"work": {"config_dir": str(tmp_path / "cc"), "label": "work"}},
                "roots": [{"path": str(root), "default_account": "work"}],
                "kms_root": "",
            }
        ),
        encoding="utf-8",
    )
    return AppConfig.load(cfg_path), proj


def _tasks_dir(proj):
    d = proj / ".fledge" / "tasks"
    d.mkdir(parents=True)
    return d


def test_unknown_project_is_rejected(tmp_path):
    """P1：不在 scan_all 已知清單裡的路徑一律拒絕（design §7.1）。

    這是寫入端點唯一的目標來源——擋不住就等於任何路徑都能被改寫或刪除。"""
    config, _ = _setup(tmp_path)
    outsider = tmp_path / "outside"
    (outsider / ".fledge" / "tasks").mkdir(parents=True)
    with scanner.open_tasks_dir(str(outsider), config) as td:
        assert td.status == scanner.STATUS_UNKNOWN_PROJECT
        assert td.fd is None


def test_relative_or_empty_project_is_rejected(tmp_path):
    """canonicalize 對空字串與相對路徑會 raise，resolver 必須吞掉並拒絕、不是 500。"""
    config, _ = _setup(tmp_path)
    for bad in ("", "   ", "relative/path"):
        with scanner.open_tasks_dir(bad, config) as td:
            assert td.status == scanner.STATUS_UNKNOWN_PROJECT


def test_fledge_layer_symlink_is_rejected(tmp_path):
    """中間那層 `.fledge` 是 symlink 也要擋——初版只擋最後一層（design §7.1 步驟 2）。"""
    config, proj = _setup(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "tasks").mkdir(parents=True)
    (proj / ".fledge").symlink_to(elsewhere, target_is_directory=True)
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert td.status == scanner.STATUS_UNAVAILABLE
        assert td.fd is None


def test_tasks_layer_symlink_is_rejected(tmp_path):
    """最後一層 `tasks` 是 symlink → O_NOFOLLOW 擋下 → unavailable。"""
    config, proj = _setup(tmp_path)
    (proj / ".fledge").mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (proj / ".fledge" / "tasks").symlink_to(elsewhere, target_is_directory=True)
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert td.status == scanner.STATUS_UNAVAILABLE


def test_absent_and_unavailable_are_distinguishable(tmp_path):
    """三態的唯一分界（design §6.3）：目錄不存在 ＝ absent，存在但讀不到 ＝ unavailable。

    把 unavailable 當成 absent（0 條）會讓使用者誤判清單已清空——**把不可讀顯示成
    「沒有」，正是這個功能存在的理由的反面。**"""
    if os.geteuid() == 0:
        pytest.skip("root 無視目錄權限，這條分界測不出來")
    config, proj = _setup(tmp_path)
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert td.status == scanner.STATUS_ABSENT

    tasks = _tasks_dir(proj)
    os.chmod(tasks, 0o000)
    try:
        with scanner.open_tasks_dir(str(proj), config) as td:
            assert td.status == scanner.STATUS_UNAVAILABLE
    finally:
        os.chmod(tasks, 0o755)


def test_counts_todo_and_doing_but_not_done(tmp_path):
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "01-a.md").write_text(TICKET.format(status="todo", title="a"), encoding="utf-8")
    (tasks / "02-b.md").write_text(TICKET.format(status="doing", title="b"), encoding="utf-8")
    (tasks / "03-c.md").write_text(TICKET.format(status="done", title="c"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        counts = scanner.count_open(td.fd)
        assert (counts.unfinished, counts.doing) == (2, 1)


def test_unparsable_ticket_still_counts(tmp_path):
    """契約 3（design §6.1）：「異常」不是「隱藏」。status 判不出來 → fallback todo → 計入。

    讀不懂就不顯示那張票，會讓票靜默消失——而這個功能存在的理由就是「不要忘記」。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "01-garbage.md").write_bytes(b"\x00\xff\xfe not markdown at all")
    (tasks / "02-done.md").write_text(TICKET.format(status="done", title="d"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.count_open(td.fd).unfinished == 1


def test_non_md_and_directories_are_not_tickets(tmp_path):
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "note.txt").write_text("not a ticket", encoding="utf-8")
    (tasks / "01-dir.md").mkdir()
    (tasks / "02-real.md").write_text(TICKET.format(status="todo", title="r"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.list_task_files(td.fd) == ["02-real.md"]
        assert scanner.count_open(td.fd).unfinished == 1


# ── T2：重複編號、下一步、逐檔隔離 ──────────────────────────────

def test_duplicate_numbers_are_both_shown_and_both_flagged(tmp_path):
    """design §2.4.2：同一資料夾出現兩個 `07-*.md` → 兩張都顯示、**都標異常**。

    重複編號不只來自併發——手動改檔名、複製一份票檔都會造成。"""
    from fledge_sidecar.tasks.parser import ANOMALY_NUMBER_DUPLICATE

    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    for short in ("07-甲.md", "07-乙.md", "08-丙.md"):
        (tasks / short).write_text(TICKET.format(status="todo", title=short), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        rows = {r["name"]: r for r in scanner.scan_tasks(td.fd)}
    assert len(rows) == 3                                       # 兩張都顯示，沒有一張被吞掉
    assert ANOMALY_NUMBER_DUPLICATE in rows["07-甲.md"]["anomalies"]
    assert ANOMALY_NUMBER_DUPLICATE in rows["07-乙.md"]["anomalies"]
    assert ANOMALY_NUMBER_DUPLICATE not in rows["08-丙.md"]["anomalies"]


def test_one_bad_file_does_not_fail_the_whole_project(tmp_path):
    """契約 2（design §6.1）：逐檔隔離。一個壞檔不會讓整個專案的掃描失敗。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "01-好的.md").write_text(TICKET.format(status="todo", title="好的"), encoding="utf-8")
    (tasks / "02-壞的.md").write_bytes(b"\xff\xfe\x00 not markdown")
    (tasks / "03-也好的.md").write_text(TICKET.format(status="done", title="也好"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        rows = scanner.scan_tasks(td.fd)
    assert len(rows) == 3
    assert [r["name"] for r in rows] == ["01-好的.md", "02-壞的.md", "03-也好的.md"]
    assert rows[1]["anomalies"]                                  # 壞的那張有記號
    assert rows[0]["anomalies"] == [] and rows[2]["anomalies"] == []   # 其他兩張不受影響


def test_fingerprint_changes_with_content_and_is_stable(tmp_path):
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    f = tasks / "01-a.md"
    f.write_text(TICKET.format(status="todo", title="a"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        first = scanner.scan_tasks(td.fd)[0]["fingerprint"]
        again = scanner.scan_tasks(td.fd)[0]["fingerprint"]
    assert first == again                                        # 內容沒動 → 雜湊不變
    f.write_text(TICKET.format(status="doing", title="a"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.scan_tasks(td.fd)[0]["fingerprint"] != first


def test_next_step_is_read_from_state_md(tmp_path):
    """design §5.1：讀 `.fledge/state.md` 前 20 行，抓 `**下一步**：` 或 `**Next**: `。

    這是 `/resume-note` skill 已寫死的格式合約，該 skill 不需要修改。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text(
        "# 標題\n\n> 更新：2026-08-29\n\n**下一步**：先跑 T2 的 parser 測試。\n\n## 1. 載入什麼\n",
        encoding="utf-8",
    )
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert td.status == scanner.STATUS_ABSENT               # tasks/ 不存在
        assert scanner.read_next_step(td.fledge_fd) == "先跑 T2 的 parser 測試。"


def test_next_step_works_when_tasks_dir_absent(tmp_path):
    """實測 22 個專案中唯一有 state.md 的那個正好沒有 tasks/。

    把 fledge_fd 綁在 tasks/ 存在與否上，它的「下一步」會永遠是空的。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text("**Next**: run the T2 tests.\n", encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert td.fd is None and td.fledge_fd is not None
        assert scanner.read_next_step(td.fledge_fd) == "run the T2 tests."


def test_next_step_absent_or_beyond_head_is_empty(tmp_path):
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_next_step(td.fledge_fd) == ""       # 根本沒有 state.md
    (fledge / "state.md").write_text("x\n" * 30 + "**下一步**：太後面了\n", encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_next_step(td.fledge_fd) == ""       # 超出前 20 行就不抓


def test_handoff_command_is_read_from_state_md_tail(tmp_path):
    """票 21：`## 貼進新對話的指令` 標題之後第一個 ``` 圍籬的內容。

    這段由 handoff skill 寫在 state.md **末尾**（實測在第 56 行之後），
    所以不能沿用 read_next_step 的前 20 行上限。回傳不含圍籬那兩行。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text(
        "# 標題\n\n**下一步**：先做 A。\n\n" + "x\n" * 50
        + "## 貼進新對話的指令\n\n```\n第一句。\n\n第二句。\n\n第三句。\n```\n",
        encoding="utf-8",
    )
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == "第一句。\n\n第二句。\n\n第三句。"
        assert scanner.read_next_step(td.fledge_fd) == "先做 A。"   # 既有行為不受影響


def test_handoff_command_absent_is_empty(tmp_path):
    """一般收工（resume-note）整份覆寫、不帶指令段——「沒有」是常態，回空字串不報錯。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == ""     # 根本沒有 state.md
    (fledge / "state.md").write_text("**下一步**：只有這行。\n", encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == ""     # 有檔沒標題
    assert scanner.read_handoff_command(None) == ""                 # .fledge/ 開不起來


def test_handoff_command_unclosed_fence_is_empty(tmp_path):
    """圍籬沒關＝檔案寫到一半或被截斷，寧可不顯示也不要把半段當指令給人複製。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text(
        "## 貼進新對話的指令\n\n```\n只有開頭沒有結尾\n", encoding="utf-8",
    )
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == ""


def test_handoff_command_takes_first_fence_after_heading_only(tmp_path):
    """標題之前的圍籬（例如第 4 節的審查指令）不能被誤抓；標題之後只取第一個。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text(
        "## 4. 工作慣例\n```\npytest -q\n```\n"
        "## 貼進新對話的指令\n```\n要的這段\n```\n```\n不要這段\n```\n",
        encoding="utf-8",
    )
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == "要的這段"


def test_handoff_command_accepts_language_tagged_fence(tmp_path):
    """Codex R1：開圍籬帶語言標記（```text）也要認。handoff skill 寫的是裸圍籬，
    但人手編輯加上 `text` 是常見動作——認不出來會靜默消失。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text(
        "## 貼進新對話的指令\n\n```text\n要的指令\n```\n", encoding="utf-8",
    )
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == "要的指令"


def test_handoff_command_language_tagged_fence_does_not_capture_prose_between_blocks(tmp_path):
    """Codex R1 重現的真正危險：```text 開頭沒被當開圍籬 → 它的關圍籬被當成開圍籬 →
    回傳的是兩個區塊**之間的說明文字**。複製到錯的東西比沒顯示更糟。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text(
        "## 貼進新對話的指令\n\n```text\n要的指令\n```\n\n備註：這段是說明\n\n```\n另一段\n```\n",
        encoding="utf-8",
    )
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == "要的指令"


def test_handoff_command_prose_line_starting_with_fence_does_not_close(tmp_path):
    """Codex R2（打在 R1 修法上）：關圍籬若也認「以 ``` 開頭」，內文裡一行
    「```text 是文件中的標記」會提早關閉，後面的指令靜默被截掉、前端照樣顯示已複製。
    關圍籬必須是**只含**反引號的行。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text(
        "## 貼進新對話的指令\n```\n第一句。\n```text 是文件中的標記，請保留。\n第三句。\n```\n",
        encoding="utf-8",
    )
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == "第一句。\n```text 是文件中的標記，請保留。\n第三句。"


def test_handoff_command_nested_fence_inside_four_backtick_block(tmp_path):
    """Codex R2：四反引號外框包一個 ```python 區塊——內層的 ``` 不能關掉外框。
    關圍籬的反引號數要 ≥ 開圍籬（CommonMark 語意）。"""
    config, proj = _setup(tmp_path)
    fledge = proj / ".fledge"
    fledge.mkdir()
    (fledge / "state.md").write_text(
        "## 貼進新對話的指令\n````\n第一句。\n```python\nprint(1)\n```\n第三句。\n````\n",
        encoding="utf-8",
    )
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_handoff_command(td.fledge_fd) == "第一句。\n```python\nprint(1)\n```\n第三句。"


# ── T3：建票、逐層建立、撞號重試 ───────────────────────────────

def test_create_task_makes_missing_dirs_and_numbers_from_one(tmp_path):
    """design §7.1 步驟 3：`.fledge` 或 `tasks` 不存在時逐層 mkdir（同樣 O_NOFOLLOW）。"""
    config, proj = _setup(tmp_path)
    assert not (proj / ".fledge").exists()
    with scanner.open_tasks_dir(str(proj), config, create=True) as td:
        assert td.status == scanner.STATUS_OK
        row = scanner.create_task(td.fd, "第一件事", created="2026-08-29")
    assert row["number"] == 1 and row["name"] == "01-第一件事.md"
    assert (proj / ".fledge" / "tasks" / "01-第一件事.md").exists()
    assert len(row["fingerprint"]) == 64


def test_create_does_not_follow_symlinked_fledge_layer(tmp_path):
    """建立時也不得繞過 symlink 檢查——`_open_or_make` 先試 open、mkdir 後再 open。"""
    config, proj = _setup(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (proj / ".fledge").symlink_to(elsewhere, target_is_directory=True)
    with scanner.open_tasks_dir(str(proj), config, create=True) as td:
        assert td.status == scanner.STATUS_UNAVAILABLE
        assert td.fd is None
    assert not (elsewhere / "tasks").exists()      # 沒有在 symlink 目標裡建出東西


def test_create_numbers_continue_from_max(tmp_path):
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "07-舊的.md").write_text(TICKET.format(status="todo", title="舊"), encoding="utf-8")
    (tasks / "沒有編號.md").write_text(TICKET.format(status="todo", title="無"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.create_task(td.fd, "新的", created="2026-08-29")
    assert row["name"] == "08-新的.md"


def test_eexist_retries_with_next_number_and_never_overwrites(tmp_path, monkeypatch):
    """撞到 EEXIST 要取下一個編號重試，**不覆蓋既有檔案**（design §2.4、§9）。

    ⚠ 不可用「預置同名檔 → 建票成功」來測：依「最大號 +1」的演算法，預置的檔案本身
    就成了最大號，下一次配號會直接跳過它，`O_EXCL` **根本不會拿到 EEXIST**——那條測試
    對「實作完全沒寫重試」也會通過。這裡注入「選完號之後、open 之前」才出現同名檔的競態。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    real_create = scanner._create_file
    calls: list[str] = []

    def racy(name: str, tasks_fd: int) -> int:
        calls.append(name)
        if len(calls) == 1:                       # 第一次：在 O_EXCL 之前把檔案生出來
            fd = real_create(name, tasks_fd)
            os.write(fd, b"OTHER WRITER")
            os.close(fd)
        return real_create(name, tasks_fd)        # 於是這一次必定拿到 EEXIST

    monkeypatch.setattr(scanner, "_create_file", racy)
    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.create_task(td.fd, "新票", created="2026-08-29")

    assert len(calls) == 2 and calls[0] != calls[1]                  # ① 真的撞到並換號
    assert (tasks / calls[0]).read_bytes() == b"OTHER WRITER"        # ② 原檔位元組完全不變
    assert row["name"] == calls[1] and (tasks / calls[1]).exists()   # ③ 第二次用新號成功


def test_create_task_actually_calls_the_plain_name_check(tmp_path, monkeypatch):
    """**allowlist 與 T1 是兩道，不是二選一**（design §7.1）。

    問題在於：allowlist 成立時 T1 永遠不會被觸發，所以「惡意 title 落在 tasks 下」那批
    測試對「`create_task` 根本沒呼叫 `is_plain_name`」也會通過。這條把 allowlist 換成
    會漏的版本，證明第二道確實接在生產路徑上——日後有人放寬 allowlist 時它才擋得住。"""
    config, proj = _setup(tmp_path)
    _tasks_dir(proj)
    monkeypatch.setattr(scanner, "make_short_name", lambda title: "../../escaped")
    with scanner.open_tasks_dir(str(proj), config) as td:
        with pytest.raises(ValueError):
            scanner.create_task(td.fd, "任何標題", created="2026-08-29")
    assert not (tmp_path / "escaped.md").exists()
    assert not (proj / "escaped.md").exists()


# ── 2026-08-31 Codex 實作階段審查的回歸測試 ────────────────────

def test_patch_refuses_hard_linked_target(tmp_path):
    """**F1**：hard link 不是 symlink，`O_NOFOLLOW` 擋不住它（design §7.1）。

    在 tasks 目錄裡放一個指向專案外檔案的 hard link，T1–T3 全會通過，而寫入是寫到
    共用的那個 inode 上。修法前實測會改寫專案外的檔案並回報成功。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    outside = tmp_path / "outside.md"
    outside.write_text("---\nstatus: todo\n---\n\n# 專案外的檔案\n機密\n", encoding="utf-8")
    before = outside.read_bytes()
    os.link(outside, tasks / "01-看似正常.md")

    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.scan_tasks(td.fd)[0]           # 讀得到（不隱藏），但寫不得
        with pytest.raises(ValueError):
            scanner.update_status(td.fd, "01-看似正常.md", status="done",
                                  expected_fingerprint=row["fingerprint"])
    assert outside.read_bytes() == before            # 專案外的檔案一個位元組都沒動


def test_delete_of_hard_link_does_not_touch_the_target(tmp_path):
    """刪除刻意**不**擋 hard link：`unlink` 移除的是這個目錄項，不動連結指向的檔案。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    outside = tmp_path / "outside.md"
    outside.write_text(TICKET.format(status="todo", title="外面"), encoding="utf-8")
    before = outside.read_bytes()
    os.link(outside, tasks / "01-連結.md")
    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.scan_tasks(td.fd)[0]
        assert scanner.delete_task(td.fd, "01-連結.md", expected_fingerprint=row["fingerprint"])
    assert not (tasks / "01-連結.md").exists()
    assert outside.read_bytes() == before            # 連結目標逐位元組不變（不只是「還在」）


def test_patch_preserves_invalid_utf8_bytes(tmp_path):
    """**F2**：改狀態不得把無效 UTF-8 換成 U+FFFD。

    §6.1 的契約說那種檔案要照常顯示；「改個狀態就把它毀掉」是實作偷偷違背契約，
    而且 `replace_status` 的註解上還寫著「其餘位元組一字不動」。
    修法前 `_decode(errors="replace")` → 再 encode 會讓那些位元組永久消失。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    raw = b"---\nstatus: todo\nsource: me\ncreated: 2026-08-31\n---\n\n# \xff\xfe \xc3\x28 \xed\xa0\x80\n"
    (tasks / "01-壞編碼.md").write_bytes(raw)

    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.scan_tasks(td.fd)[0]
        scanner.update_status(td.fd, "01-壞編碼.md", status="doing",
                              expected_fingerprint=row["fingerprint"])
    after = (tasks / "01-壞編碼.md").read_bytes()
    assert after == raw.replace(b"status: todo", b"status: doing")   # 逐位元組
    assert b"\xff\xfe" in after and b"\xed\xa0\x80" in after         # 沒有被換成替代字元
    assert "�".encode() not in after


def test_short_write_is_not_reported_as_success(tmp_path, monkeypatch):
    """**F3**：`os.write` 允許短寫，回傳值不能忽略。

    初版只呼叫一次就 `ftruncate`：短寫時檔案變成「新內容前半 ＋ 舊內容尾巴」，
    而端點照樣回成功、還回一個與磁碟不符的 fingerprint。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    body = "---\nstatus: todo\nsource: me\ncreated: 2026-08-31\n---\n\n# 標題\n\n很長的內文" + "x" * 500 + "\n"
    (tasks / "01-a.md").write_text(body, encoding="utf-8")

    real_write = os.write
    # 只對票檔內容短寫（以 `---` 開頭），不干擾 pytest 自己的輸出
    def one_byte_at_a_time(fd, data):
        payload = bytes(data)
        if payload.startswith(b"---") and len(payload) > 1:
            return real_write(fd, payload[:1])
        return real_write(fd, payload)
    monkeypatch.setattr(os, "write", one_byte_at_a_time)

    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.scan_tasks(td.fd)[0]
        out = scanner.update_status(td.fd, "01-a.md", status="done",
                                    expected_fingerprint=row["fingerprint"])
    monkeypatch.undo()
    on_disk = (tasks / "01-a.md").read_bytes()
    assert on_disk == body.replace("status: todo", "status: done").encode("utf-8")
    assert out is not None and out["fingerprint"] == scanner.fingerprint(on_disk)   # 名實相符


def test_write_all_raises_when_no_progress(tmp_path, monkeypatch):
    """寫不進去（回 0）時必須拋例外，不能無限迴圈也不能假裝成功。"""
    monkeypatch.setattr(os, "write", lambda fd, data: 0)
    target = tmp_path / "x"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        with pytest.raises(OSError):
            scanner._write_all(fd, b"---\nstatus: done\n")
    finally:
        monkeypatch.undo()
        os.close(fd)


def test_reading_a_fifo_does_not_block(tmp_path):
    """**F4**：列目錄與開檔之間有窗口，外部把 `.md` 換成 FIFO 時不得阻塞。

    少了 `O_NONBLOCK`，`O_RDONLY` 開 FIFO 會等到有寫入端出現——整個 `/tasks`
    掃描掛在那一行，而契約 2 要求的是隔離那一個檔案、不是拖垮整個專案。
    這裡直接對 FIFO 呼叫讀取函式；沒修的話這條會逾時而不是失敗。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "02-正常.md").write_text(TICKET.format(status="todo", title="正常"), encoding="utf-8")
    os.mkfifo(tasks / "01-管道.md")

    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.read_task_bytes(td.fd, "01-管道.md") is None   # 立刻回，不卡住
        assert scanner.list_task_files(td.fd) == ["02-正常.md"]       # FIFO 本來就不算票
        assert scanner.count_open(td.fd).unfinished == 1              # 其他票不受影響


def _ticket_with_body(tasks, name="01-a.md"):
    body = ("---\nstatus: todo\nsource: me\ncreated: 2026-08-31\n---\n\n"
            "# 標題\n\n第一行內文\n第二行內文\n" + "尾巴" * 200 + "\n")
    (tasks / name).write_text(body, encoding="utf-8")
    return body.encode("utf-8")


def test_write_failure_surfaces_as_task_write_error(tmp_path, monkeypatch):
    """寫到一半失敗時**必須讓呼叫端知道**（路由據此回 500，不是假裝成功）。

    ⚠ **這裡刻意不斷言「原檔一個位元組都沒變」**——那不在保證範圍內（design §10.4 的 K5）。
    原地覆寫寫到一半失敗會留下「新內容前半 ＋ 舊內容尾巴」，`.fledge/` 不進 git 救不回，
    這是這個定位下接受的代價。曾經寫成暫存檔 ＋ rename 來撐住那個保證，連三輪審查都在
    打同一段自己發明的協定，2026-08-31 整段拿掉、改為縮小承諾。
    **測試斷言的必須是實際做得到的事，否則它遲早會變成一句假敘述。**"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    _ticket_with_body(tasks)

    real_write = os.write
    state: dict = {"fd": None}

    # 認 fd 而不是認內容：_write_all 第二次呼叫傳的是【剩餘位元組】，不再以 --- 開頭
    def fail_after_first_chunk(fd, data):
        payload = bytes(data)
        if state["fd"] is None and payload.startswith(b"---"):
            state["fd"] = fd
            return real_write(fd, payload[:20])
        if fd == state["fd"]:
            raise OSError(28, "No space left on device")
        return real_write(fd, payload)

    monkeypatch.setattr(os, "write", fail_after_first_chunk)
    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.scan_tasks(td.fd)[0]
        with pytest.raises(scanner.TaskWriteError):
            scanner.update_status(td.fd, "01-a.md", status="doing",
                                  expected_fingerprint=row["fingerprint"])
    monkeypatch.undo()
    # 只斷言：不會留下暫存檔之類的殘骸（本實作沒有暫存檔，這條擋住日後又長出一個）
    assert [f.name for f in tasks.iterdir()] == ["01-a.md"]


def test_status_update_does_not_change_file_mode(tmp_path):
    """改狀態不得動到檔案權限。

    原地覆寫本來就不會——這條是**回歸護欄**：日後若有人又把寫入改成「建新檔再改名」，
    新檔會吃到 process 的 umask（0664 的共享票會變成 0644），這條會紅。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    _ticket_with_body(tasks)
    os.chmod(tasks / "01-a.md", 0o600)
    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.scan_tasks(td.fd)[0]
        scanner.update_status(td.fd, "01-a.md", status="doing",
                              expected_fingerprint=row["fingerprint"])
    assert stat.S_IMODE(os.stat(tasks / "01-a.md").st_mode) == 0o600


# ── 票 02：doing / unfinished 分開計數（總覽刻度要能分狀態上色）────────────

def test_count_open_separates_doing_from_unfinished(tmp_path):
    """`doing` 是 `unfinished` 的子集合，不是另一個維度——刻度總數仍是 `unfinished`。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    for i, st in enumerate(["todo", "doing", "doing", "done", "todo"], start=1):
        (tasks / f"{i:02d}-x.md").write_text(TICKET.format(status=st, title=f"t{i}"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        counts = scanner.count_open(td.fd)
        assert counts.unfinished == 4          # todo 2 ＋ doing 2，done 不算
        assert counts.doing == 2
        assert counts.doing <= counts.unfinished


def test_unparsable_ticket_counts_as_todo_not_doing(tmp_path):
    """讀不懂的票 fallback 成 todo（design §6.1）。**不可以進 doing**——
    那會在畫面上宣稱「有人在動這張票」，而我們其實連它的 status 都沒讀出來。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "01-garbage.md").write_bytes(b"\x00\xff\xfe not markdown at all")
    with scanner.open_tasks_dir(str(proj), config) as td:
        counts = scanner.count_open(td.fd)
        assert counts.unfinished == 1
        assert counts.doing == 0


def test_overview_row_carries_doing(tmp_path):
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "01-a.md").write_text(TICKET.format(status="doing", title="a"), encoding="utf-8")
    (tasks / "02-b.md").write_text(TICKET.format(status="todo", title="b"), encoding="utf-8")
    row = next(r for r in scanner.build_overview(config)["projects"] if r["path"] == str(proj))
    assert row["unfinished"] == 2
    assert row["doing"] == 1


def test_absent_project_reports_zero_doing(tmp_path):
    """`absent` 的 `unfinished` 是 0，`doing` 也必須是 0——不是 None。
    兩個欄位的規則要一致，否則前端得為每個欄位各記一套。"""
    config, proj = _setup(tmp_path)          # 不建 .fledge/tasks/ ＝ absent
    row = next(r for r in scanner.build_overview(config)["projects"] if r["path"] == str(proj))
    assert row["tasks_status"] == scanner.STATUS_ABSENT
    assert row["unfinished"] == 0
    assert row["doing"] == 0


def test_parked_is_counted_separately_and_not_in_unfinished(tmp_path):
    """spec §3.3：`parked` 不進 `unfinished` 也不進 `doing`，自己一個數。
    三個數互不重疊；把 parked 加回 unfinished 這條要紅。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    for i, st in enumerate(["todo", "parked", "doing", "parked", "done"], start=1):
        (tasks / f"{i:02d}-x.md").write_text(TICKET.format(status=st, title=f"t{i}"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        counts = scanner.count_open(td.fd)
        assert counts.unfinished == 2
        assert counts.doing == 1
        assert counts.parked == 2


def test_overview_row_carries_parked_with_same_null_rules(tmp_path):
    """`parked` 與 `unfinished` 同一套規則：ok 實數、absent 0。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "01-a.md").write_text(TICKET.format(status="parked", title="a"), encoding="utf-8")
    (tasks / "02-b.md").write_text(TICKET.format(status="todo", title="b"), encoding="utf-8")
    row = next(r for r in scanner.build_overview(config)["projects"] if r["path"] == str(proj))
    assert row["unfinished"] == 1
    assert row["parked"] == 1
    config2, proj2 = _setup(tmp_path / "second", project="empty")   # 不建 .fledge/tasks/ ＝ absent
    row2 = next(r for r in scanner.build_overview(config2)["projects"] if r["path"] == str(proj2))
    assert row2["tasks_status"] == scanner.STATUS_ABSENT
    assert row2["parked"] == 0


# ── update_content ＋ _row 加欄位（spec §3、§5.3、§5.4）────────────────────

STD = "---\nstatus: todo\nsource: me\ncreated: 2026-09-01\n---\n\n# old title\n\nold body\n"


def _ticket(d, name="01-old.md", text=STD):
    p = d / name
    p.write_bytes(text.encode("utf-8") if isinstance(text, str) else text)
    return p


def _fd(d):
    return os.open(str(d), os.O_RDONLY | os.O_DIRECTORY)


def test_scan_tasks_returns_body_and_editable(tmp_path):
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    _ticket(d, name="01-good.md")
    _ticket(d, name="02-bad.md", text=b"---\nstatus: todo\n---suffix\n# t\n")
    fd = _fd(d)
    try:
        rows = {r["name"]: r for r in scanner.scan_tasks(fd)}
    finally:
        os.close(fd)
    assert rows["01-good.md"]["body"] == "old body"
    assert rows["01-good.md"]["editable"] is True
    assert rows["02-bad.md"]["editable"] is False
    assert len(rows) == 2                                    # 壞票不拖垮好票（spec §5.2.1）


def test_unreadable_row_is_not_editable(tmp_path):
    """讀不到的票 body 空字串、editable False，不拋例外。

    用 mode 0o000 的一般檔而不是 FIFO：FIFO 連 list_task_files 的 is_file 過濾都過不了
    （見 test_reading_a_fifo_does_not_block），根本進不到 scan_tasks 的逐檔迴圈，
    那樣測到的不是「讀不到的票」而是「不存在的票」。"""
    if os.geteuid() == 0:
        pytest.skip("root 無視檔案權限，這條測不出來")
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d, name="03-noperm.md")
    os.chmod(p, 0o000)
    fd = _fd(d)
    try:
        rows = {r["name"]: r for r in scanner.scan_tasks(fd)}
    finally:
        os.close(fd)
        os.chmod(p, 0o600)          # 還原，否則 tmp_path 清理會失敗
    assert rows["03-noperm.md"]["editable"] is False and rows["03-noperm.md"]["body"] == ""


def test_create_and_update_status_rows_carry_editable(tmp_path):
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    fd = _fd(d)
    try:
        created = scanner.create_task(fd, "新票", created="2026-09-01")
        assert created["editable"] is True and created["body"] == ""
        updated = scanner.update_status(fd, created["name"], status="done", expected_fingerprint=created["fingerprint"])
        assert updated["editable"] is True
    finally:
        os.close(fd)


def test_update_content_rewrites_after_fence_only(tmp_path):
    """frontmatter 位元組不動、其餘換掉、回新 fingerprint 與 body（spec §5.4）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    before = p.read_bytes()
    fd = _fd(d)
    try:
        row = scanner.update_content(fd, "01-old.md", title="new title", body="new body",
                                     expected_fingerprint=scanner.fingerprint(before))
    finally:
        os.close(fd)
    after = p.read_bytes()
    fence = before.find(b"\n---\n") + 5
    assert after[:fence] == before[:fence]
    assert after == before[:fence] + b"\n# new title\n\nnew body\n"
    assert row["title"] == "new title" and row["body"] == "new body" and row["editable"] is True
    assert row["fingerprint"] == scanner.fingerprint(after)


def test_update_content_keeps_file_identity(tmp_path):
    """D3、spec §10.1：目錄檔名集合、st_ino、st_nlink 全部不變。**只斷言回應的 name 不變是假綠**——
    rename 替換檔案仍能保留同一個 name（plan R1 F6）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    before_st, before_names = p.stat(), set(os.listdir(d))
    fd = _fd(d)
    try:
        scanner.update_content(fd, "01-old.md", title="完全不同的標題", body="b",
                               expected_fingerprint=scanner.fingerprint(p.read_bytes()))
    finally:
        os.close(fd)
    after_st = p.stat()
    assert set(os.listdir(d)) == before_names
    assert after_st.st_ino == before_st.st_ino
    assert after_st.st_nlink == 1 == before_st.st_nlink


def test_update_content_stale_fingerprint_does_not_write(tmp_path):
    """409 的前提是檔案沒被動——只斷言回 None 不夠，要重讀比對（spec §10.1）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    before = p.read_bytes()
    fd = _fd(d)
    try:
        assert scanner.update_content(fd, "01-old.md", title="x", body="", expected_fingerprint="wrong") is None
    finally:
        os.close(fd)
    assert p.read_bytes() == before


def test_update_content_read_failure_is_task_write_error(tmp_path, monkeypatch):
    """spec §8：I/O 失敗回 500，不是 400。fd 已經過 `_open_existing` 的 T1–T4，`_read_all`
    之後失敗只可能是 I/O（EIO、掛載掉了…），不是目標不合法——不轉成 `TaskWriteError` 的話
    會落到路由的 generic OSError 分支回 400 invalid_target（Codex 對抗式審查抓到）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    before = p.read_bytes()

    def boom(fd):
        raise OSError(errno.EIO, "io error")

    monkeypatch.setattr(scanner, "_read_all", boom)
    fd = _fd(d)
    try:
        with pytest.raises(scanner.TaskWriteError):
            scanner.update_content(fd, "01-old.md", title="x", body="",
                                    expected_fingerprint=scanner.fingerprint(before))
    finally:
        os.close(fd)
    assert p.read_bytes() == before


def test_update_content_symlink_target_is_400_class_not_500(tmp_path):
    """§8 的另一半：`_open_existing`（T3 symlink）撞到 `O_NOFOLLOW` 時，`os.open` 本身
    拋的是 `OSError`（ELOOP）——這是邊界判斷，不是 I/O 失敗，路由歸 400 invalid_target。
    FIX 1 只包住 `_read_all`，不可以連帶把這個也吞成 `TaskWriteError`（500）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    outside = tmp_path / "outside.md"
    outside.write_bytes(STD.encode("utf-8"))
    (d / "01-link.md").symlink_to(outside)
    fd = _fd(d)
    try:
        with pytest.raises(OSError) as exc_info:
            scanner.update_content(fd, "01-link.md", title="x", body="", expected_fingerprint="whatever")
        assert not isinstance(exc_info.value, scanner.TaskWriteError)
    finally:
        os.close(fd)
    assert outside.read_bytes() == STD.encode("utf-8")


@pytest.mark.parametrize("bad", [
    b"---\nstatus: todo\n---suffix\n# t\n",
    b"---\nstatus: todo\n---\n\n\n# t\n",
    b"---\nstatus: todo\n---\n\n# t\r\n",
])
def test_update_content_rejects_non_round_trippable_without_touching(tmp_path, bad):
    """§5.3：round-trip 不過 → ValueError('not_editable') 且檔案未被動。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d, text=bad)
    fd = _fd(d)
    try:
        with pytest.raises(ValueError, match="not_editable"):
            scanner.update_content(fd, "01-old.md", title="t", body="", expected_fingerprint=scanner.fingerprint(bad))
    finally:
        os.close(fd)
    assert p.read_bytes() == bad


@pytest.mark.parametrize("title,body", [
    ("", ""), ("  a  ", ""), ("a\nb", ""),
    ("t", "line\r\nline"), ("t", "\nbody"), ("t", "body\n"),
])
def test_update_content_rejects_out_of_domain_input(tmp_path, title, body):
    """§5.2.2 值域：sidecar 端再驗，不符 ValueError('invalid_content') 且檔案未被動。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    before = p.read_bytes()
    fd = _fd(d)
    try:
        with pytest.raises(ValueError, match="invalid_content"):
            scanner.update_content(fd, "01-old.md", title=title, body=body, expected_fingerprint=scanner.fingerprint(before))
    finally:
        os.close(fd)
    assert p.read_bytes() == before


@pytest.mark.parametrize("body", ["a b", "a b", "a\x0cb", "a\x0bb", "a\x85b"])
def test_update_content_rejects_bodies_the_parser_would_resplit(tmp_path, body):
    """值域檢查只認 \r\n，parser 的 splitlines 還認另外六種分隔字元。放行的話這張票
    寫完就自己拒絕再編輯（editable False），且顯示的內文與磁碟位元組不符。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    before = p.read_bytes()
    fd = _fd(d)
    try:
        with pytest.raises(ValueError, match="invalid_content"):
            scanner.update_content(fd, "01-old.md", title="t", body=body, expected_fingerprint=scanner.fingerprint(before))
    finally:
        os.close(fd)
    assert p.read_bytes() == before


def test_update_content_allows_number_missing(tmp_path):
    """§5.3：anomaly 標記不是拒絕理由——要有測試釘住「可以」，否則之後有人順手加回拒絕清單沒有防線攔。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p_no_num = _ticket(d, name="nonum.md")
    p_other = _ticket(d, name="01-other.md")
    other_before = p_other.read_bytes()
    fd = _fd(d)
    try:
        row = scanner.update_content(fd, "nonum.md", title="t", body="",
                                     expected_fingerprint=scanner.fingerprint(p_no_num.read_bytes()))
    finally:
        os.close(fd)
    assert row is not None
    assert p_other.read_bytes() == other_before


def test_update_content_allows_number_duplicate_and_touches_only_target(tmp_path):
    """§5.3：number_duplicate 也可編輯，且只動指定那張（plan R1 F6）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    _ticket(d, name="01-a.md"); p2 = _ticket(d, name="01-b.md")
    p2_before = p2.read_bytes()
    fd = _fd(d)
    try:
        rows = {r["name"]: r for r in scanner.scan_tasks(fd)}
        assert "number_duplicate" in rows["01-a.md"]["anomalies"]
        row = scanner.update_content(fd, "01-a.md", title="t", body="", expected_fingerprint=rows["01-a.md"]["fingerprint"])
    finally:
        os.close(fd)
    assert row is not None
    assert p2.read_bytes() == p2_before


class _NoLock:
    """無鎖的替身。**不是給實作用的**——只給「證明競態存在」的測試注入。"""
    def __enter__(self): return self
    def __exit__(self, *a): return False


def _gate_read_after(monkeypatch, barrier, *, strict):
    """把同步點放在 _read_all **之後**（plan R1 F4）。放在 update_content 之前測不到鎖：
    排程只要讓 A 完整跑完，B 自然讀到新 fp 回 None，拿掉鎖也照樣過。

    strict=False（有鎖的測試）：A 持鎖進 _read_all，B 在 with 外等；barrier 只有 A 到達 → timeout
      → 吞掉 → A 寫完釋放 → B 進來讀到新 fp → None。恰好一個成功。
    strict=True（無鎖的測試）：兩個都必須到達 barrier，**任何 timeout 都讓測試失敗**——否則 B 慢一點
      沒排到，A 先寫完，B 讀到新 fp 回 None，「恰好一個成功」照樣成立，無鎖也綠（plan R2 F1）。"""
    real = scanner._read_all

    def gated(fd):
        raw = real(fd)
        try:
            barrier.wait(timeout=10)      # 寬鬆：這不是競態正確性的判準，只是抓「第二個 thread 根本沒排到」（plan R3 F3）
        except threading.BrokenBarrierError:
            if strict:
                raise AssertionError("gate timeout: both threads must reach the gate; scheduling delay, not a race outcome")
        return raw

    monkeypatch.setattr(scanner, "_read_all", gated)


def _race(d, ops):
    """並行跑 ops（每個是 fd → result），回 results。join 有 timeout 抓死鎖；OSError／ValueError
    算失敗（例如 delete 贏了之後 content 開檔遇到 FileNotFoundError）。"""
    results = []

    def go(op):
        fd = _fd(d)
        try: results.append(op(fd))
        except AssertionError as e: results.append(e)
        except (OSError, ValueError): results.append(None)
        finally: os.close(fd)

    ts = [threading.Thread(target=go, args=(op,)) for op in ops]
    for t in ts: t.start()
    # join 的 timeout 只負責抓真死鎖，必須明顯大於 gate 的 barrier timeout（10 秒）——
    # 兩者相等時 assert 會在邊界上擲硬幣，變成與鎖正確性無關的假紅（plan R3 F3 只調了 barrier）。
    for t in ts: t.join(timeout=30)
    assert all(not t.is_alive() for t in ts), "deadlock"
    errs = [r for r in results if isinstance(r, AssertionError)]
    assert not errs, errs
    return results


def _content(fp, body):
    return lambda fd: scanner.update_content(fd, "01-old.md", title="t", body=body, expected_fingerprint=fp)

def _status(fp):
    return lambda fd: scanner.update_status(fd, "01-old.md", status="done", expected_fingerprint=fp)

def _delete(fp):
    return lambda fd: scanner.delete_task(fd, "01-old.md", expected_fingerprint=fp)

_PAIRS = {
    "content/content": lambda fp: [_content(fp, "A"), _content(fp, "B")],
    "content/status":  lambda fp: [_content(fp, "A"), _status(fp)],
    "content/delete":  lambda fp: [_content(fp, "A"), _delete(fp)],
}


@pytest.mark.parametrize("pair", list(_PAIRS))
def test_writes_are_serialized(tmp_path, monkeypatch, pair):
    """§5.4 全域鎖：同一 fingerprint 的兩個寫入並行，**恰好一個成功**。三種組合都要（plan R2 F2：
    漏掉 delete 的話 delete 可先驗舊 fp、content 寫新內容、delete 再 unlink 掉新版）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    fp = scanner.fingerprint(p.read_bytes())
    _gate_read_after(monkeypatch, threading.Barrier(2), strict=False)
    results = _race(d, _PAIRS[pair](fp))
    ok = [r for r in results if r not in (None, False)]
    assert len(ok) == 1, f"{pair}: expected exactly one success, got {len(ok)}"
    if True in results:                                   # delete 贏：檔案不在
        assert not p.exists()
    else:
        final = p.read_bytes()
        assert final.startswith(b"---\nstatus: ") and b"\n---\n" in final   # 不是交錯的壞檔


@pytest.mark.parametrize("pair", list(_PAIRS))
def test_without_lock_both_succeed(tmp_path, monkeypatch, pair):
    """**證明競態存在**：把鎖換成 _NoLock，strict gate 強制兩個都讀到舊 raw，兩個都會「成功」。
    這條紅了代表上面那條在測的東西不存在（plan R2 F1：沒有這條，_NoLock 也可能綠）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    fp = scanner.fingerprint(p.read_bytes())
    monkeypatch.setattr(scanner, "_WRITE_LOCK", _NoLock())
    _gate_read_after(monkeypatch, threading.Barrier(2), strict=True)
    results = _race(d, _PAIRS[pair](fp))
    ok = [r for r in results if r not in (None, False)]
    assert len(ok) == 2, f"{pair}: without the lock both should pass the stale check; got {len(ok)}"


def test_lock_released_on_open_failure(tmp_path):
    """§5.4：`with` 保證釋放。注入 _open_existing 失敗後，鎖不會卡死。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    _ticket(d)
    fd = _fd(d)
    try:
        with pytest.raises(ValueError):
            scanner.update_content(fd, "../evil.md", title="t", body="", expected_fingerprint="x")
        assert scanner._WRITE_LOCK.acquire(timeout=1)       # 鎖若沒放，這行會等到 timeout 回 False
        scanner._WRITE_LOCK.release()
    finally:
        os.close(fd)


# ── Codex 對抗式審查 Finding 2：serialized／without_lock 只驗「恰好一個成功」，
# 證明不了鎖涵蓋 fingerprint→寫入整段、也證明不了鎖是全域的（plan main...a4c3669 review）────

def test_update_content_lock_has_no_overlap_between_fingerprint_check_and_write(tmp_path, monkeypatch):
    """Property A：鎖必須涵蓋『fingerprint 比對通過之後、第一個會動到磁碟的 syscall 之前』
    整段，不能只鎖住讀取。探針釘在 `replace_body`——它是純計算，正好卡在這個窗口正中央。
    用 barrier 當偵測器：barrier 真的完成（兩邊都排到）就代表兩個 thread 同時站在臨界區
    內，鎖被縮小了；鎖夠寬的話，第二個 thread 在自己的 fingerprint 比對就會先被擋下來
    （讀到第一個已經寫完的新內容），根本到不了這個探針，barrier 永遠等不到第二個人。

    只驗『恰好一個成功』不夠：把鎖縮小到只包 `_read_all`，兩個 thread 一樣可以各自讀到
    舊內容、各自通過 fingerprint 比對、最後恰好一個成功——結果看起來一樣，但兩個臨界區
    其實重疊過。

    **liveness 也要驗**：`not rendezvoused` 在『barrier 真的 timeout』與『兩個 thread 根本
    都沒走到這個探針』兩種情況下長得一模一樣——後者是假綠，日後 `update_content` 在
    `replace_body` 之前多長出一條會拋的路徑，這道防線會無聲消失（`_race` 把 OSError／
    ValueError 都壓平成 None，光看 `not rendezvoused` 分不出來）。所以額外釘住：探針必須
    恰好被叫到一次（另一個 thread 在自己的 fingerprint 比對就該被擋下，不該死於例外），
    且 `results` 裡恰好一個非 None（呼應 Property B 對 `results` 的護欄）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    p = _ticket(d)
    fp = scanner.fingerprint(p.read_bytes())
    barrier = threading.Barrier(2)
    rendezvoused = []
    entered = []
    real_replace_body = scanner.replace_body

    def gated(raw, title, body):
        entered.append(True)               # liveness：探針真的被叫到了嗎
        try:
            barrier.wait(timeout=3)
            rendezvoused.append(True)      # 只有兩邊都排到才會走到這行
        except threading.BrokenBarrierError:
            pass                            # 正常情況：另一邊根本沒機會排隊
        return real_replace_body(raw, title, body)

    monkeypatch.setattr(scanner, "replace_body", gated)
    results = _race(d, [_content(fp, "A"), _content(fp, "B")])
    assert sum(1 for r in results if r is not None) == 1, f"預期恰好一個成功：{results}"
    assert len(entered) == 1, (
        f"探針必須恰好被叫到一次——0 次代表兩個 thread 都沒走到這裡（假綠，"
        f"see liveness 註解），得到 {len(entered)} 次"
    )
    assert not rendezvoused, "兩個 thread 同時站在 fingerprint 比對之後、寫入之前——鎖沒有蓋住這段"


def test_update_content_lock_is_global_not_per_ticket(tmp_path, monkeypatch):
    """Property B：鎖必須是全域一把，不是 per-name。現有六條並行測試全部固定同一個檔名
    （01-old.md），per-name 鎖一樣會讓它們全綠——這條改成兩張不同的票，兩邊都應該成功
    （各自檔案、各自 fingerprint，彼此不衝突），但『兩個臨界區不能同時進行』這件事必須
    成立，不管鎖用什麼當鍵。探針一樣釘在 `replace_body`，量到同時有 2 個 thread 站在裡面
    就代表鎖被縮小成 per-name（或根本沒鎖）。"""
    _, proj = _setup(tmp_path)
    d = _tasks_dir(proj)
    _ticket(d, name="01-a.md")
    _ticket(d, name="02-b.md")
    fp_a = scanner.fingerprint((d / "01-a.md").read_bytes())
    fp_b = scanner.fingerprint((d / "02-b.md").read_bytes())

    max_inside = []
    state = {"inside": 0}
    probe_lock = threading.Lock()
    real_replace_body = scanner.replace_body

    def probe(raw, title, body):
        with probe_lock:
            state["inside"] += 1
            max_inside.append(state["inside"])
        # 這 2.0 秒是「per-name 鎖的第二個 thread 必須被抓到重疊」的容錯窗口，要撐得住
        # 機器負載高的情況（只影響『證明會紅』的方向——正常路徑下鎖是全域的，第二個
        # thread 根本進不來，這段 sleep 不花任何額外時間在正確實作上）。
        time.sleep(2.0)
        try:
            return real_replace_body(raw, title, body)
        finally:
            with probe_lock:
                state["inside"] -= 1

    monkeypatch.setattr(scanner, "replace_body", probe)

    def op_a(fd):
        return scanner.update_content(fd, "01-a.md", title="t", body="A", expected_fingerprint=fp_a)

    def op_b(fd):
        return scanner.update_content(fd, "02-b.md", title="t", body="B", expected_fingerprint=fp_b)

    results = _race(d, [op_a, op_b])
    assert all(r is not None for r in results), f"不同票應該兩邊都成功：{results}"
    assert max(max_inside) == 1, f"兩張不同票的臨界區同時進行過（尖峰 {max(max_inside)} 個）——鎖不是全域的"

"""tasks 的路徑邊界 resolver 與未完成計數（design §7.1、§6.3）。

resolver 是**所有端點共用的唯一入口**，所以它的拒絕條件在 T1 就要測滿——T2／T3 的
端點只是接上它，不會再重寫一份。
"""
import json
import os

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
        assert scanner.count_unfinished(td.fd) == 2


def test_unparsable_ticket_still_counts(tmp_path):
    """契約 3（design §6.1）：「異常」不是「隱藏」。status 判不出來 → fallback todo → 計入。

    讀不懂就不顯示那張票，會讓票靜默消失——而這個功能存在的理由就是「不要忘記」。"""
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "01-garbage.md").write_bytes(b"\x00\xff\xfe not markdown at all")
    (tasks / "02-done.md").write_text(TICKET.format(status="done", title="d"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.count_unfinished(td.fd) == 1


def test_non_md_and_directories_are_not_tickets(tmp_path):
    config, proj = _setup(tmp_path)
    tasks = _tasks_dir(proj)
    (tasks / "note.txt").write_text("not a ticket", encoding="utf-8")
    (tasks / "01-dir.md").mkdir()
    (tasks / "02-real.md").write_text(TICKET.format(status="todo", title="r"), encoding="utf-8")
    with scanner.open_tasks_dir(str(proj), config) as td:
        assert scanner.list_task_files(td.fd) == ["02-real.md"]
        assert scanner.count_unfinished(td.fd) == 1


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
    """實測 22 個專案中唯一有 state.md 的那個（Meeting Agent）正好沒有 tasks/。

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
    os.link(outside, tasks / "01-連結.md")
    with scanner.open_tasks_dir(str(proj), config) as td:
        row = scanner.scan_tasks(td.fd)[0]
        assert scanner.delete_task(td.fd, "01-連結.md", expected_fingerprint=row["fingerprint"])
    assert not (tasks / "01-連結.md").exists()
    assert outside.exists()                          # 連結目標還在


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
        assert scanner.count_unfinished(td.fd) == 1                   # 其他票不受影響

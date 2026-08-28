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

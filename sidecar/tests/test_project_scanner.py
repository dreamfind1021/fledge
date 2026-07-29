from pathlib import Path

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.project_scanner import scan_root, encode_cc_project_dir, scan_all


def test_scan_root_lists_depth1_dirs(tmp_path: Path):
    (tmp_path / "proj-a").mkdir()
    (tmp_path / "proj-b").mkdir()
    (tmp_path / "proj-a" / "nested").mkdir()  # depth 2，不應列出
    (tmp_path / "file.txt").write_text("x")  # 檔案，不應列出

    projects = scan_root(tmp_path, account="work")
    names = sorted(p["name"] for p in projects)
    assert names == ["proj-a", "proj-b"]
    assert all(p["account"] == "work" for p in projects)
    assert all(p["root"] == str(tmp_path.resolve()) for p in projects)


def test_scan_root_excludes_hidden(tmp_path: Path):
    (tmp_path / "visible").mkdir()
    (tmp_path / ".hidden").mkdir()
    (tmp_path / ".git").mkdir()

    projects = scan_root(tmp_path, account="work")
    names = [p["name"] for p in projects]
    assert names == ["visible"]


def test_encode_cc_project_dir():
    # Claude Code 把專案路徑編碼成目錄名：所有非英數字元一律 → -（已對 19 個真實專案 round-trip 驗證）
    assert encode_cc_project_dir("/Users/tc/NAS/work/foo") == "-Users-tc-NAS-work-foo"
    assert encode_cc_project_dir("/a/b_c") == "-a-b-c"          # 底線
    assert encode_cc_project_dir("/a/foo.bar") == "-a-foo-bar"  # 點
    assert encode_cc_project_dir("/a/with space") == "-a-with-space"  # 空白
    assert encode_cc_project_dir("/a/網拍") == "-a---"          # CJK 各 1 dash、不收合
    assert encode_cc_project_dir("/a/.x/y") == "-a--x-y"        # 連續分隔不收合
    # 有損碰撞：底線/dash/空白編出同一目錄（接受、不報錯，spec §2.2 Known Limitations）
    assert encode_cc_project_dir("/a/foo_b") == encode_cc_project_dir("/a/foo-b")


def _accounts_cfg(tmp_path: Path) -> AppConfig:
    cfg = AppConfig(path=tmp_path / "config.json")
    cfg.accounts = {
        "work": {"config_dir": "/tmp/none", "label": "工作"},
        "personal": {"config_dir": "/tmp/none2", "label": "私人"},
    }
    return cfg


def test_scan_all_applies_override_to_root_project(tmp_path: Path):
    (tmp_path / "proj-a").mkdir()
    cfg = _accounts_cfg(tmp_path)
    cfg.roots = [{"path": str(tmp_path), "default_account": "work"}]
    proj_a = str((tmp_path / "proj-a").resolve())
    cfg.project_overrides = {proj_a: {"account": "personal"}}

    projects, _ = scan_all(cfg)
    p = next(x for x in projects if x["path"] == proj_a)
    assert p["account"] == "personal"


def test_scan_all_applies_override_to_manual_project(tmp_path: Path):
    cfg = _accounts_cfg(tmp_path)
    manual_path = str((tmp_path / "manual-x").resolve())
    cfg.manual_projects = [{"path": manual_path, "account": "work"}]
    cfg.project_overrides = {manual_path: {"account": "personal"}}

    projects, _ = scan_all(cfg)
    p = next(x for x in projects if x["path"] == manual_path)
    assert p["account"] == "personal"  # manual 也吃 override（不靜默失效）


def test_scan_all_permission_error_is_best_effort(tmp_path, monkeypatch):
    """某 root 噴 PermissionError → 跳過該 root、permission_error=True、不整個拋。"""
    from fledge_sidecar.app_config import AppConfig
    from fledge_sidecar import project_scanner

    ok_root = tmp_path / "ok"
    (ok_root / "proj").mkdir(parents=True)
    cfg = AppConfig(
        path=tmp_path / "config.json",  # AppConfig 第一個欄位為必填 path
        roots=[{"path": str(ok_root), "default_account": "work"}, {"path": str(tmp_path / "denied"), "default_account": "work"}],
        accounts={"work": {"config_dir": "/tmp/fake", "label": "工作"}},
    )
    orig = project_scanner.scan_root

    def fake_scan_root(root, account):
        if "denied" in str(root):
            raise PermissionError("denied")
        return orig(root, account)

    monkeypatch.setattr(project_scanner, "scan_root", fake_scan_root)

    projects, permission_error = project_scanner.scan_all(cfg)
    assert permission_error is True
    assert any(p["name"] == "proj" for p in projects)  # ok root 仍掃到


def test_scan_all_recent_permission_error_keeps_proj(tmp_path, monkeypatch):
    """讀 recent（config_dir）撞 PermissionError → 該 proj 仍在、recent 留 None、permission_error=True。"""
    from fledge_sidecar.app_config import AppConfig
    from fledge_sidecar import project_scanner

    root = tmp_path / "r"
    (root / "proj").mkdir(parents=True)
    cfg = AppConfig(
        path=tmp_path / "config.json",
        roots=[{"path": str(root), "default_account": "work"}],
        accounts={"work": {"config_dir": "/tmp/fake", "label": "工作"}},
    )

    def raise_perm(*_a, **_k):
        raise PermissionError("denied")

    monkeypatch.setattr(project_scanner, "_recent_mtime", raise_perm)

    projects, permission_error = project_scanner.scan_all(cfg)
    assert permission_error is True
    proj = next(p for p in projects if p["name"] == "proj")
    assert proj["recent"] is None  # recent 讀失敗但 proj 仍保留


def test_scan_all_recent_union_across_accounts(tmp_path, monkeypatch):
    """recent 取所有帳號 config_dir 的最新 mtime（跨帳號 union，spec §2.3）。"""
    from fledge_sidecar import project_scanner

    root = tmp_path / "r"
    (root / "proj").mkdir(parents=True)
    proj_path = str((root / "proj").resolve())
    cfg = AppConfig(
        path=tmp_path / "config.json",
        roots=[{"path": str(root), "default_account": "work"}],
        accounts={
            "work": {"config_dir": "/cd/work", "label": "工作"},
            "personal": {"config_dir": "/cd/personal", "label": "私人"},
        },
    )

    def fake_recent(config_dir, project_path):
        # work 較舊、personal 較新 → union 應取 personal
        return {"/cd/work": 100.0, "/cd/personal": 200.0}[str(config_dir)]

    monkeypatch.setattr(project_scanner, "_recent_mtime", fake_recent)
    projects, _ = project_scanner.scan_all(cfg)
    proj = next(p for p in projects if p["path"] == proj_path)
    assert proj["recent"] == 200.0


# ── 畸形 config 的容錯（前端 appConfigGuard 的對應面）──
# 手動編輯或損壞的 config 可能讓元素缺欄位。以往這裡是直接索引（root["default_account"]、
# m["account"]、override["account"]），一筆壞資料就讓整個 /api/projects 回 500——使用者
# 得到空工作區與持續的載入失敗，且未必能從設定頁刪掉那筆。改為逐項 best-effort：
# 跳過畸形項目、其餘照常掃出，與本函式對 PermissionError 的既有處理一致。


def test_scan_all_skips_root_missing_default_account(tmp_path: Path):
    (tmp_path / "good").mkdir()
    config = AppConfig(
        path=tmp_path / "config.json",
        roots=[{"path": str(tmp_path)}],  # 缺 default_account
        accounts={"default": {"config_dir": str(tmp_path / ".c"), "label": ""}},
    )
    projects, _ = scan_all(config)
    assert projects == []  # 跳過該 root，不 raise


def test_scan_all_keeps_valid_roots_when_one_is_malformed(tmp_path: Path):
    ok_root = tmp_path / "ok"
    (ok_root / "proj").mkdir(parents=True)
    config = AppConfig(
        path=tmp_path / "config.json",
        roots=[{"path": str(tmp_path / "broken")}, {"path": str(ok_root), "default_account": "work"}],
        accounts={"work": {"config_dir": str(tmp_path / ".c"), "label": ""}},
    )
    projects, _ = scan_all(config)
    assert [p["name"] for p in projects] == ["proj"]  # 壞的那筆不拖垮好的


def test_scan_all_ignores_override_missing_account(tmp_path: Path):
    (tmp_path / "proj").mkdir()
    config = AppConfig(
        path=tmp_path / "config.json",
        roots=[{"path": str(tmp_path), "default_account": "work"}],
        accounts={"work": {"config_dir": str(tmp_path / ".c"), "label": ""}},
        # 刻意用 truthy 但缺 account 的 dict：空 dict 會被 `if override:` 擋掉，測不到硬化
        project_overrides={str((tmp_path / "proj").resolve()): {"note": "x"}},
    )
    projects, _ = scan_all(config)
    assert [p["account"] for p in projects] == ["work"]  # 當作沒有 override


def test_scan_all_skips_manual_missing_fields(tmp_path: Path):
    (tmp_path / "m1").mkdir()
    (tmp_path / "m2").mkdir()
    config = AppConfig(
        path=tmp_path / "config.json",
        roots=[],
        accounts={"work": {"config_dir": str(tmp_path / ".c"), "label": ""}},
        manual_projects=[{"path": str(tmp_path / "m1")}, {"path": str(tmp_path / "m2"), "account": "work"}],
    )
    projects, _ = scan_all(config)
    assert [p["name"] for p in projects] == ["m2"]  # 缺 account 的那筆跳過

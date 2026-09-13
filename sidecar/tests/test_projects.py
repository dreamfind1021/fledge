import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app


def test_projects_endpoint_returns_scanned(tmp_path: Path, monkeypatch):
    # 準備一個假根目錄
    root = tmp_path / "work"
    root.mkdir()
    (root / "alpha").mkdir()
    (root / "beta").mkdir()

    # 準備一個假 config 指向該根
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(
        json.dumps(
            {
                "version": 1,
                "roots": [{"path": str(root), "default_account": "work"}],
                "accounts": {"work": {"config_dir": str(tmp_path / "noclaude"), "label": "工作"}},
                "manual_projects": [],
                "project_overrides": {},
                "ui": {"theme": "dark"},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg_path))

    client = TestClient(create_app())
    resp = client.get("/api/projects")
    assert resp.status_code == 200
    names = sorted(p["name"] for p in resp.json()["projects"])
    assert names == ["alpha", "beta"]


def test_scan_preview_counts_children(tmp_path: Path, monkeypatch):
    root = tmp_path / "work"
    root.mkdir()
    (root / "alpha").mkdir()
    (root / "beta").mkdir()
    (root / ".hidden").mkdir()  # 隱藏資料夾不算
    (root / "file.txt").write_text("x")  # 非資料夾不算
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    resp = client.post("/api/projects/scan-preview", json={"path": str(root)})
    assert resp.status_code == 200
    assert resp.json()["count"] == 2


def test_scan_preview_missing_path_returns_zero(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    resp = client.post("/api/projects/scan-preview", json={"path": str(tmp_path / "nope")})
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


def test_scan_preview_file_path_returns_zero(tmp_path: Path, monkeypatch):
    # 選到檔案（非資料夾）→ scan_root 的 iterdir 噴 NotADirectoryError → 捕捉回 0（Codex F-2）
    f = tmp_path / "file.txt"
    f.write_text("x")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    resp = client.post("/api/projects/scan-preview", json={"path": str(f)})
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


def test_scan_preview_permission_error_returns_zero(tmp_path: Path, monkeypatch):
    # 無權限資料夾 → scan_root 噴 PermissionError（OSError 子類）→ 捕捉回 0（Codex V4）。
    # 用 monkeypatch 模擬，不依賴實際 chmod（跨平台不穩）。
    from fledge_sidecar.routes import projects as projects_route

    def _raise(*_args, **_kwargs):
        raise PermissionError("no access")

    monkeypatch.setattr(projects_route, "scan_root", _raise)
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    resp = client.post("/api/projects/scan-preview", json={"path": str(tmp_path)})
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


def _accounts_block(tmp_path: Path):
    # config_dir 指不存在的目錄（recent 查詢會 exists() 短路）；用 tmp_path 下而非 hardcode
    # /tmp（macOS /tmp 是 →/private/tmp 的 symlink，避免未來比對誤差）
    return {"work": {"config_dir": str(tmp_path / "none"), "label": "工作"},
            "personal": {"config_dir": str(tmp_path / "none2"), "label": "私人"}}


def test_override_applies_through_symlink_root(tmp_path: Path, monkeypatch):
    # 核心 bug 回歸：root 用 symlink 路徑、override 也用 symlink 下的 proj 路徑。
    # 修前：override key（未 resolve）對不上掃出的 resolved proj path → account 仍 work。
    # 修後：load 遷移把 override key resolve → 配對成功 → personal。
    real_root = tmp_path / "realroot"
    real_root.mkdir()
    (real_root / "proj").mkdir()
    link_root = tmp_path / "linkroot"
    link_root.symlink_to(real_root)
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({
        "version": 1,
        "roots": [{"path": str(link_root), "default_account": "work"}],
        "accounts": _accounts_block(tmp_path),
        "manual_projects": [],
        "project_overrides": {str(link_root / "proj"): {"account": "personal"}},
        "ui": {"theme": "dark"},
    }), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    client = TestClient(create_app())
    projects = client.get("/api/projects").json()["projects"]
    proj = next(p for p in projects if p["name"] == "proj")
    assert proj["account"] == "personal"


def test_manual_symlink_alias_dedups_with_root(tmp_path: Path, monkeypatch):
    # 核心 bug 回歸：manual 是 root 掃出 proj 的 symlink 別名。
    # 修前：manual path（未 resolve）對不上 by_path 的 resolved key → 重複列；且 name 取
    # symlink basename "linkproj"（非 "proj"）→ 兩筆。修後遷移成 resolved → 命中 by_path → 去重。
    real_root = tmp_path / "realroot"
    real_root.mkdir()
    proj = real_root / "proj"
    proj.mkdir()
    link_proj = tmp_path / "linkproj"
    link_proj.symlink_to(proj)
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({
        "version": 1,
        "roots": [{"path": str(real_root), "default_account": "work"}],
        "accounts": _accounts_block(tmp_path),
        "manual_projects": [{"path": str(link_proj), "account": "work"}],
        "project_overrides": {},
        "ui": {"theme": "dark"},
    }), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    client = TestClient(create_app())
    projects = client.get("/api/projects").json()["projects"]
    # 斷言「總專案數」才 red-first：修前 manual 別名未 resolve、name 取 symlink basename
    # "linkproj"（非 "proj"）→ 兩筆（proj + linkproj）；修後遷移成 resolved → 命中 by_path
    # 去重 → 只剩一筆 proj。
    assert len(projects) == 1
    assert projects[0]["name"] == "proj"


def test_scan_preview_status_ok(tmp_path: Path, monkeypatch):
    root = tmp_path / "work"
    root.mkdir()
    (root / "alpha").mkdir()
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    body = client.post("/api/projects/scan-preview", json={"path": str(root)}).json()
    assert body["status"] == "ok"
    assert body["count"] == 1
    assert body["path"] == str(root.resolve())


def test_scan_preview_status_missing(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    body = client.post("/api/projects/scan-preview", json={"path": str(tmp_path / "nope")}).json()
    assert body["status"] == "missing"


def test_scan_preview_status_not_dir(tmp_path: Path, monkeypatch):
    f = tmp_path / "file.txt"
    f.write_text("x")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    body = client.post("/api/projects/scan-preview", json={"path": str(f)}).json()
    assert body["status"] == "not_dir"


def test_scan_preview_status_invalid(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    # 相對與空字串都要回 invalid（expand_and_validate 兩者都 raise ValueError）
    for bad in ("relative/x", ""):
        body = client.post("/api/projects/scan-preview", json={"path": bad}).json()
        assert body["status"] == "invalid"
        assert body["count"] == 0


def test_scan_preview_status_denied(tmp_path: Path, monkeypatch):
    from fledge_sidecar.routes import projects as projects_route
    monkeypatch.setattr(projects_route, "probe_dir", lambda _p: "denied")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(tmp_path / "config.json"))
    client = TestClient(create_app())
    body = client.post("/api/projects/scan-preview", json={"path": str(tmp_path)}).json()
    assert body["status"] == "denied"
    assert body["count"] == 0


# ── Task C3：POST /api/projects/tree ─────────────────────────────────────────


@pytest.fixture
def tree_setup(tmp_path, monkeypatch):
    root = tmp_path / "root"
    (root / "proj" / "sub").mkdir(parents=True)
    (root / "proj" / "a.txt").write_text("x")
    (root / "proj" / ".hidden").write_text("x")
    cfg = {
        "version": 1,
        "roots": [{"path": str(root), "default_account": "work"}],
        "accounts": {"work": {"config_dir": str(tmp_path / "cfg"), "label": "工作"}},
        "manual_projects": [],
        "project_overrides": {},
        "ui": {},
        "subscriptions": [],
        "kms_root": "",
    }
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg_path))
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    return TestClient(create_app()), root, cfg_path


def test_tree_lists_one_level(tree_setup):
    client, root, _ = tree_setup
    r = client.post("/api/projects/tree", json={"path": str(root / "proj")})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    names = [(e["name"], e["is_dir"]) for e in body["entries"]]
    assert names == [("sub", True), ("a.txt", False)]  # 資料夾在前、dotfile 排除


def test_tree_forbidden_outside_roots(tree_setup):
    client, _, _ = tree_setup
    r = client.post("/api/projects/tree", json={"path": "/etc"})
    assert r.status_code == 403
    assert r.json()["detail"]["status"] == "forbidden"


def test_tree_invalid_relative(tree_setup):
    client, _, _ = tree_setup
    r = client.post("/api/projects/tree", json={"path": "relative/x"})
    assert r.status_code == 400
    assert r.json()["detail"]["status"] == "invalid"


def test_tree_missing_within_root(tree_setup):
    client, root, _ = tree_setup
    # allowed root 下不存在的子路徑 → 200 帶 status=missing（design §7.1 L2 刻意決定：
    # 內容層錯誤回 200 讓前端就地提示，非 4xx）
    r = client.post("/api/projects/tree", json={"path": str(root / "proj" / "nope")})
    assert r.status_code == 200
    assert r.json()["status"] == "missing"


def test_tree_missing_parameter(tree_setup):
    client, _, _ = tree_setup
    r = client.post("/api/projects/tree", json={})  # 缺 path → FastAPI 422
    assert r.status_code == 422


def test_tree_kms_root_as_project_is_browsable(tree_setup):
    client, root, cfg_path = tree_setup
    # kms_root 同時是 allowed root 下的專案（第二大腦的 vault 本身也可以是一個工作專案）：
    # 應可正常瀏覽其檔案樹——containment（allowed roots）是唯一邊界（撤銷 PR review F1，見 spec §15）
    kms = root / "proj"
    cfg = json.loads(cfg_path.read_text())
    cfg["kms_root"] = str(kms)
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    r = client.post("/api/projects/tree", json={"path": str(kms)})
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ── 票 01：POST /api/open ─────────────────────────────────────────
# 用編輯器打開的邊界從 Tauri capability 的 glob 移到這裡。
# capability 的 `$HOME/**` 兩個方向都不對：放行整個家目錄（太寬），
# 家目錄以外的 root 完全用不了（太窄）。這裡沿用檔案樹那套 is_within_any_root，
# 兩個功能同一個邊界、單一來源。

def _open_cfg(tmp_path: Path, monkeypatch, root: Path):
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({
            "version": 1,
            "roots": [{"path": str(root), "default_account": "work"}],
            "accounts": {"work": {"config_dir": str(tmp_path / "cc"), "label": "工作"}},
            "manual_projects": [], "project_overrides": {}, "ui": {"theme": "dark"},
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))


def _spy(calls):
    def run(argv, **kw):
        calls.append(argv)
        class R:
            returncode = 0
        return R()
    return run


def test_open_launches_file_inside_a_root(tmp_path: Path, monkeypatch):
    from fledge_sidecar.routes import projects as route
    root = tmp_path / "work"; (root / "proj").mkdir(parents=True)
    target = root / "proj" / "note.md"; target.write_text("x", encoding="utf-8")
    _open_cfg(tmp_path, monkeypatch, root)
    calls: list = []
    monkeypatch.setattr(route, "_run_open", _spy(calls))

    resp = TestClient(create_app()).post("/api/open", json={"path": str(target)})
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    # `--` 一定要在路徑前面：以 `-` 開頭的檔名否則會被 open 當成旗標
    assert calls == [["open", "--", str(target.resolve())]]


def test_open_refuses_a_path_outside_every_root(tmp_path: Path, monkeypatch):
    """capability 的 `$HOME/**` 放行整個家目錄。這條就是它擋不住的東西。"""
    from fledge_sidecar.routes import projects as route
    root = tmp_path / "work"; root.mkdir()
    outside = tmp_path / "elsewhere"; outside.mkdir()
    target = outside / "secret.md"; target.write_text("x", encoding="utf-8")
    _open_cfg(tmp_path, monkeypatch, root)
    calls: list = []
    monkeypatch.setattr(route, "_run_open", _spy(calls))

    resp = TestClient(create_app()).post("/api/open", json={"path": str(target)})
    assert resp.status_code == 403
    assert calls == []                      # 擋下來就不可以 exec


def test_open_resolves_symlink_before_checking_containment(tmp_path: Path, monkeypatch):
    """先 resolve 再判 containment。順序反過來的話，root 裡的一條 symlink
    就能指到外面，而檢查會過——這正是 capability 的 glob 擋不住的形狀。"""
    from fledge_sidecar.routes import projects as route
    root = tmp_path / "work"; root.mkdir()
    outside = tmp_path / "elsewhere"; outside.mkdir()
    real = outside / "secret.md"; real.write_text("x", encoding="utf-8")
    link = root / "looks-innocent.md"; link.symlink_to(real)
    _open_cfg(tmp_path, monkeypatch, root)
    calls: list = []
    monkeypatch.setattr(route, "_run_open", _spy(calls))

    resp = TestClient(create_app()).post("/api/open", json={"path": str(link)})
    assert resp.status_code == 403
    assert calls == []


def test_open_refuses_a_directory(tmp_path: Path, monkeypatch):
    from fledge_sidecar.routes import projects as route
    root = tmp_path / "work"; (root / "proj").mkdir(parents=True)
    _open_cfg(tmp_path, monkeypatch, root)
    calls: list = []
    monkeypatch.setattr(route, "_run_open", _spy(calls))

    resp = TestClient(create_app()).post("/api/open", json={"path": str(root / "proj")})
    assert resp.status_code == 200
    assert resp.json()["status"] == "not_file"
    assert calls == []


def test_open_reports_missing_without_execing(tmp_path: Path, monkeypatch):
    from fledge_sidecar.routes import projects as route
    root = tmp_path / "work"; root.mkdir()
    _open_cfg(tmp_path, monkeypatch, root)
    calls: list = []
    monkeypatch.setattr(route, "_run_open", _spy(calls))

    resp = TestClient(create_app()).post("/api/open", json={"path": str(root / "nope.md")})
    assert resp.status_code == 200
    assert resp.json()["status"] == "missing"
    assert calls == []


def test_open_rejects_a_relative_path(tmp_path: Path, monkeypatch):
    from fledge_sidecar.routes import projects as route
    root = tmp_path / "work"; root.mkdir()
    _open_cfg(tmp_path, monkeypatch, root)
    calls: list = []
    monkeypatch.setattr(route, "_run_open", _spy(calls))

    resp = TestClient(create_app()).post("/api/open", json={"path": "../../etc/passwd"})
    assert resp.status_code == 400
    assert calls == []


def test_open_works_for_a_root_outside_home(tmp_path: Path, monkeypatch):
    """capability 的 `$HOME/**` 讓家目錄以外的 root 完全用不了這個功能（票上的「太窄」）。
    tmp_path 不在 $HOME 底下，這條就是那個缺口的回歸測試。"""
    from fledge_sidecar.routes import projects as route
    root = tmp_path / "external-disk"; (root / "p").mkdir(parents=True)
    target = root / "p" / "a.md"; target.write_text("x", encoding="utf-8")
    assert not str(root).startswith(str(Path.home()))
    _open_cfg(tmp_path, monkeypatch, root)
    calls: list = []
    monkeypatch.setattr(route, "_run_open", _spy(calls))

    resp = TestClient(create_app()).post("/api/open", json={"path": str(target)})
    assert resp.status_code == 200
    assert calls == [["open", "--", str(target.resolve())]]

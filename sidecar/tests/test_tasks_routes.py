"""待辦面板路由（design §7）。

本檔第一條是**接線測試**（design §9.1）：`routes/tasks.py` 的單測會直接 import router
來測，不會經過 `app.py` 的註冊點——漏掉 `include_router` 時那些單測仍會全綠、而
`/tasks` 全部 404。這條對「組好的 app」打，補上那個缺口。
"""
import json

from fastapi.testclient import TestClient

from fledge_sidecar.app import create_app


def _client(tmp_path, monkeypatch, *, roots=None):
    """指向臨時 config，讓 scan_all 只看得到測試造的專案（不讀使用者真實設定）。"""
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({"version": 1, "accounts": {}, "roots": roots or [], "kms_root": ""}),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    return TestClient(create_app())


def test_router_registered_on_composed_app(tmp_path, monkeypatch):
    """對【組好的 app】打 /tasks/overview，斷言 200 ＋ 最小回應 shape。

    ⚠ 不可改寫成「斷言不是 404」：`app.py` 的 TokenAuthMiddleware 在路由分派【之前】
    就對未帶有效 token 的請求回 401，所以漏掉 `include_router` 時「非 404」也會通過
    ——那正是這條測試要防的漏接線風險本身（design §9.1 的假綠警告）。
    """
    c = _client(tmp_path, monkeypatch)
    r = c.get("/tasks/overview")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body.get("projects"), list)


def test_overview_requires_token_when_auth_enforced(tmp_path, monkeypatch):
    """認證拒絕【另立一條】，不與上面那條混在一起（design §9.1）。"""
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({"version": 1, "accounts": {}, "roots": [], "kms_root": ""}),
        encoding="utf-8",
    )
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    c = TestClient(create_app())
    assert c.get("/tasks/overview").status_code == 401


def _project_root(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    return root


def test_overview_lists_every_known_project_with_counts(tmp_path, monkeypatch):
    """所有已知專案各一列，沒有待辦的顯示 0——不隱藏（design §5.1）。"""
    root = _project_root(tmp_path)
    has = root / "has-tasks"
    (has / ".fledge" / "tasks").mkdir(parents=True)
    (has / ".fledge" / "tasks" / "01-a.md").write_text(
        "---\nstatus: todo\n---\n\n# a\n", encoding="utf-8"
    )
    (root / "no-fledge").mkdir()

    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    rows = {r["name"]: r for r in c.get("/tasks/overview").json()["projects"]}
    assert rows["has-tasks"]["unfinished"] == 1
    assert rows["has-tasks"]["tasks_status"] == "ok"
    assert rows["no-fledge"]["unfinished"] == 0
    assert rows["no-fledge"]["tasks_status"] == "absent"
    # 票 02：payload 帶 doing 給總覽的刻度上色用
    assert rows["has-tasks"]["doing"] == 0                  # 那張票是 todo
    assert rows["no-fledge"]["doing"] == 0
    assert rows["has-tasks"]["parked"] == 0
    assert rows["no-fledge"]["parked"] == 0


def test_overview_reports_unavailable_not_zero(tmp_path, monkeypatch):
    """讀不到的專案回 `unavailable` ＋ `unfinished: null`，**不是 0**（design §6.3）。

    回 0 的話使用者無法分辨「真的沒有待辦」與「整份待辦讀不到」，會誤判清單已清空。
    `unfinished` 用 null 而非 0，讓前端在結構上不可能把它畫成 0。"""
    import os

    import pytest

    if os.geteuid() == 0:
        pytest.skip("root 無視目錄權限")
    root = _project_root(tmp_path)
    blocked = root / "blocked"
    tasks = blocked / ".fledge" / "tasks"
    tasks.mkdir(parents=True)
    os.chmod(tasks, 0o000)
    try:
        c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
        row = next(r for r in c.get("/tasks/overview").json()["projects"] if r["name"] == "blocked")
        assert row["tasks_status"] == "unavailable"
        assert row["unfinished"] is None
        assert row["unfinished"] != 0
        # doing 走同一套規則。只讓其中一個回 null，前端就得為每個欄位各記一套判斷
        assert row["doing"] is None
        assert row["parked"] is None                              # 第三個數同一套規則
        assert row["doing_tasks"] is None and row["recent_tasks"] is None   # 讀不到不是空清單
    finally:
        os.chmod(tasks, 0o755)


# ── GET /tasks（T2）────────────────────────────────────────────────

def _proj_with_tasks(tmp_path):
    root = _project_root(tmp_path)
    proj = root / "p1"
    (proj / ".fledge" / "tasks").mkdir(parents=True)
    return root, proj


def test_list_tasks_shape_and_fingerprint(tmp_path, monkeypatch):
    """正常路徑：200 ＋ 清單 shape ＋ **每票帶 name 與 fingerprint**（design §7.1 末）。"""
    root, proj = _proj_with_tasks(tmp_path)
    (proj / ".fledge" / "tasks" / "01-a.md").write_text(
        "---\nstatus: todo\nsource: me\ncreated: 2026-08-29\n---\n\n# 第一件\n", encoding="utf-8"
    )
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.get("/tasks", params={"project": str(proj)})
    assert r.status_code == 200
    body = r.json()
    assert body["tasks_status"] == "ok"
    (t,) = body["tasks"]
    assert t["name"] == "01-a.md" and t["number"] == 1 and t["title"] == "第一件"
    assert t["status"] == "todo" and t["source"] == "me" and t["anomalies"] == []
    assert len(t["fingerprint"]) == 64  # sha256 hex


def test_list_tasks_rejects_unknown_project(tmp_path, monkeypatch):
    """P1 不過 → error code，唯讀寫入皆同（design §7.1 的失敗分類表）。"""
    root, _ = _proj_with_tasks(tmp_path)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.get("/tasks", params={"project": str(tmp_path / "outside")})
    assert r.status_code == 400
    assert r.json()["error"] == "unknown_project"


def test_list_tasks_unavailable_is_null_not_empty_list(tmp_path, monkeypatch):
    """讀不到 → `tasks: null`，**不是空清單**（design §6.3）。

    空清單與「這個專案沒待辦」在畫面上長得一模一樣——那正是這個功能存在的理由的反面。"""
    import os

    import pytest

    if os.geteuid() == 0:
        pytest.skip("root 無視目錄權限")
    root, proj = _proj_with_tasks(tmp_path)
    tasks = proj / ".fledge" / "tasks"
    os.chmod(tasks, 0o000)
    try:
        c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
        body = c.get("/tasks", params={"project": str(proj)}).json()
        assert body["tasks_status"] == "unavailable"
        assert body["tasks"] is None
        assert body["tasks"] != []
    finally:
        os.chmod(tasks, 0o755)


def test_list_tasks_absent_is_empty_list(tmp_path, monkeypatch):
    root = _project_root(tmp_path)
    proj = root / "bare"
    proj.mkdir()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    body = c.get("/tasks", params={"project": str(proj)}).json()
    assert body["tasks_status"] == "absent"
    assert body["tasks"] == []


def test_list_tasks_carries_handoff_command_but_overview_does_not(tmp_path, monkeypatch):
    """票 21：專案頁回 state.md 末尾的「貼進新對話的指令」；沒有就是空字串。

    **總覽刻意不帶**——那一層每個專案都要掃，而指令只在點進專案後才用到。"""
    root, proj = _proj_with_tasks(tmp_path)
    (proj / ".fledge" / "state.md").write_text(
        "**下一步**：做 A。\n\n## 貼進新對話的指令\n\n```\n第一句。\n\n第二句。\n```\n",
        encoding="utf-8",
    )
    bare = root / "bare"
    bare.mkdir()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    body = c.get("/tasks", params={"project": str(proj)}).json()
    assert body["next_step"] == "做 A。"
    assert body["handoff_command"] == "第一句。\n\n第二句。"
    assert c.get("/tasks", params={"project": str(bare)}).json()["handoff_command"] == ""
    for row in c.get("/tasks/overview").json()["projects"]:
        assert "handoff_command" not in row


def test_list_tasks_requires_token_when_auth_enforced(tmp_path, monkeypatch):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "accounts": {}, "roots": [], "kms_root": ""}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    c = TestClient(create_app())
    assert c.get("/tasks", params={"project": "/x"}).status_code == 401


# ── POST /tasks（T3）──────────────────────────────────────────

def test_post_creates_ticket_and_returns_name_and_fingerprint(tmp_path, monkeypatch):
    root = _project_root(tmp_path)
    proj = root / "p1"
    proj.mkdir()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.post("/tasks", json={"project": str(proj), "title": "匯出的檔名要能自訂"})
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "01-匯出的檔名要能自訂.md"
    assert body["number"] == 1 and body["status"] == "todo" and body["source"] == "me"
    assert len(body["fingerprint"]) == 64
    assert (proj / ".fledge" / "tasks" / body["name"]).exists()   # 逐層建出來了


def test_post_rejects_blank_title(tmp_path, monkeypatch):
    root = _project_root(tmp_path)
    proj = root / "p1"
    proj.mkdir()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    for title in ("", "   ", "\n\t"):
        r = c.post("/tasks", json={"project": str(proj), "title": title})
        assert r.status_code == 400 and r.json()["error"] == "title_required"


def test_post_rejects_unknown_project(tmp_path, monkeypatch):
    root = _project_root(tmp_path)
    (root / "p1").mkdir()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.post("/tasks", json={"project": str(tmp_path / "outside"), "title": "x"})
    assert r.status_code == 400 and r.json()["error"] == "unknown_project"
    assert not (tmp_path / "outside" / ".fledge").exists()   # 沒有在未知路徑底下建東西


def test_post_requires_token_when_auth_enforced(tmp_path, monkeypatch):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "accounts": {}, "roots": [], "kms_root": ""}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    assert TestClient(create_app()).post("/tasks", json={"project": "/x", "title": "y"}).status_code == 401


def _post_title_lands_inside_tasks(tmp_path, monkeypatch, title, *, preseed_dir=None):
    """送一個惡意 title，斷言 ① 建票成功 ② 檔案落在 tasks 目錄下 ③ 專案根沒多出東西。

    **不要寫成「拒絕」**——`A/B` 是合法的使用者標題，設計 §7.1 要求正規化成 `A-B`。"""
    root = _project_root(tmp_path)
    proj = root / "p1"
    tasks = proj / ".fledge" / "tasks"
    tasks.mkdir(parents=True)
    if preseed_dir:
        (tasks / preseed_dir).mkdir()
    before_root = set(p.name for p in proj.iterdir())
    before_parent = set(p.name for p in root.iterdir())

    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.post("/tasks", json={"project": str(proj), "title": title})
    assert r.status_code == 201, r.text                       # ① 正規化後建票成功
    name = r.json()["name"]
    assert "/" not in name and name not in (".", "..")
    assert (tasks / name).is_file()                           # ② 落在 tasks 目錄下
    assert set(p.name for p in proj.iterdir()) == before_root       # ③ 專案根沒多出東西
    assert set(p.name for p in root.iterdir()) == before_parent     #    上一層也沒有


def test_post_title_with_slash_is_normalised(tmp_path, monkeypatch):
    _post_title_lands_inside_tasks(tmp_path, monkeypatch, "A/B/C")


def test_post_title_with_dotdot_is_normalised(tmp_path, monkeypatch):
    _post_title_lands_inside_tasks(tmp_path, monkeypatch, "../../etc/passwd")


def test_post_title_with_nul_is_normalised(tmp_path, monkeypatch):
    _post_title_lands_inside_tasks(tmp_path, monkeypatch, "a\x00b")


def test_post_traversal_title_with_preseeded_plain_dir(tmp_path, monkeypatch):
    """design §7.1 第四輪審查抓到的洞：tasks 底下有一般目錄 `01-` 時，`O_NOFOLLOW`
    **不會**禁止一般目錄之後的 `..`——所以 POST 產生的檔名也必須過 T1，不能只靠 allowlist。"""
    _post_title_lands_inside_tasks(tmp_path, monkeypatch, "/../../../x", preseed_dir="01-")


def test_post_punctuation_only_title_falls_back_to_untitled(tmp_path, monkeypatch):
    root = _project_root(tmp_path)
    proj = root / "p1"
    proj.mkdir()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.post("/tasks", json={"project": str(proj), "title": "。。。！！！"})
    assert r.status_code == 201
    assert r.json()["name"] == "01-untitled.md"
    assert r.json()["title"] == "。。。！！！"    # 標題本身保留原文，只有檔名被正規化


# ── PATCH / DELETE（T4）───────────────────────────────────────

BODY = "---\nstatus: todo\nsource: me\ncreated: 2026-08-29\n---\n\n# 標題不該被動到\n\n第一行內文\n第二行內文\n\n- 條列\n"


def _with_ticket(tmp_path, monkeypatch, *, text=BODY, name="01-a.md"):
    """造一個含票的專案，回 (client, proj, tasks 目錄, 該票的 fingerprint)。"""
    root = _project_root(tmp_path)
    proj = root / "p1"
    tasks = proj / ".fledge" / "tasks"
    tasks.mkdir(parents=True)
    (tasks / name).write_text(text, encoding="utf-8")
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    row = next(t for t in c.get("/tasks", params={"project": str(proj)}).json()["tasks"] if t["name"] == name)
    return c, proj, tasks, row["fingerprint"]


def test_patch_changes_only_status_and_leaves_body_byte_identical(tmp_path, monkeypatch):
    """**plan 標為「最危險的缺口」的那條。**

    實作若為了改 status 而重建檔案、漏寫內文，狀態會顯示正確、409 測試也全綠，
    而使用者不進 git 的內容已經不可回復地消失。"""
    c, proj, tasks, fp = _with_ticket(tmp_path, monkeypatch)
    before = (tasks / "01-a.md").read_text(encoding="utf-8")
    r = c.patch("/tasks", json={"project": str(proj), "name": "01-a.md",
                                "status": "doing", "fingerprint": fp})
    assert r.status_code == 200
    after = (tasks / "01-a.md").read_text(encoding="utf-8")
    assert after == before.replace("status: todo", "status: doing")   # 逐字，只有那一行變
    assert r.json()["status"] == "doing"
    assert r.json()["fingerprint"] != fp                             # 回新的 fingerprint
    assert r.json()["title"] == "標題不該被動到"


def test_patch_with_stale_fingerprint_is_409_and_file_untouched(tmp_path, monkeypatch):
    c, proj, tasks, _ = _with_ticket(tmp_path, monkeypatch)
    before = (tasks / "01-a.md").read_bytes()
    r = c.patch("/tasks", json={"project": str(proj), "name": "01-a.md",
                                "status": "done", "fingerprint": "0" * 64})
    assert r.status_code == 409 and r.json()["error"] == "stale"
    assert (tasks / "01-a.md").read_bytes() == before                # 完全沒被動過


def test_delete_with_stale_fingerprint_is_409_and_file_untouched(tmp_path, monkeypatch):
    c, proj, tasks, _ = _with_ticket(tmp_path, monkeypatch)
    before = (tasks / "01-a.md").read_bytes()
    r = c.request("DELETE", "/tasks", params={"project": str(proj), "name": "01-a.md",
                                              "fingerprint": "0" * 64})
    assert r.status_code == 409 and r.json()["error"] == "stale"
    assert (tasks / "01-a.md").read_bytes() == before


def test_delete_removes_only_the_named_file(tmp_path, monkeypatch):
    c, proj, tasks, fp = _with_ticket(tmp_path, monkeypatch)
    (tasks / "02-b.md").write_text(BODY, encoding="utf-8")
    r = c.request("DELETE", "/tasks", params={"project": str(proj), "name": "01-a.md", "fingerprint": fp})
    assert r.status_code == 200
    assert not (tasks / "01-a.md").exists()
    assert (tasks / "02-b.md").exists()                              # 同資料夾其他檔案不受影響


def test_two_patches_in_a_row_both_succeed(tmp_path, monkeypatch):
    """單次 PATCH 的測試抓不到這個：成功回應若沒帶回新 fingerprint、或前端沒拿它取代
    本地狀態，第二次會被錯誤地判成 409（design §7.2）。"""
    c, proj, _, fp = _with_ticket(tmp_path, monkeypatch)
    r1 = c.patch("/tasks", json={"project": str(proj), "name": "01-a.md", "status": "doing", "fingerprint": fp})
    assert r1.status_code == 200
    r2 = c.patch("/tasks", json={"project": str(proj), "name": "01-a.md",
                                 "status": "done", "fingerprint": r1.json()["fingerprint"]})
    assert r2.status_code == 200 and r2.json()["status"] == "done"


def test_patch_then_delete_succeeds(tmp_path, monkeypatch):
    c, proj, tasks, fp = _with_ticket(tmp_path, monkeypatch)
    r1 = c.patch("/tasks", json={"project": str(proj), "name": "01-a.md", "status": "doing", "fingerprint": fp})
    r2 = c.request("DELETE", "/tasks", params={"project": str(proj), "name": "01-a.md",
                                               "fingerprint": r1.json()["fingerprint"]})
    assert r2.status_code == 200 and not (tasks / "01-a.md").exists()


def test_patch_rejects_bad_input(tmp_path, monkeypatch):
    c, proj, _, fp = _with_ticket(tmp_path, monkeypatch)
    base = {"project": str(proj), "name": "01-a.md", "status": "doing", "fingerprint": fp}
    assert c.patch("/tasks", json={**base, "name": ""}).status_code == 400
    assert c.patch("/tasks", json={**base, "fingerprint": ""}).status_code == 400
    assert c.patch("/tasks", json={**base, "status": "亂寫"}).status_code == 400
    assert c.patch("/tasks", json={**base, "name": "沒這張.md"}).status_code == 404
    assert c.patch("/tasks", json={**base, "project": str(tmp_path / "outside")}).status_code == 400


def test_delete_rejects_bad_input(tmp_path, monkeypatch):
    c, proj, _, fp = _with_ticket(tmp_path, monkeypatch)
    base = {"project": str(proj), "name": "01-a.md", "fingerprint": fp}
    for over, code in (({"name": ""}, 400), ({"fingerprint": ""}, 400),
                       ({"name": "沒這張.md"}, 404), ({"project": str(tmp_path / "outside")}, 400)):
        assert c.request("DELETE", "/tasks", params={**base, **over}).status_code == code


def test_write_endpoints_require_token_when_auth_enforced(tmp_path, monkeypatch):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "accounts": {}, "roots": [], "kms_root": ""}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    c = TestClient(create_app())
    assert c.patch("/tasks", json={"project": "/x", "name": "a.md", "status": "todo", "fingerprint": "f"}).status_code == 401
    assert c.request("DELETE", "/tasks", params={"project": "/x", "name": "a.md", "fingerprint": "f"}).status_code == 401


# 路徑邊界 T2／T3（design §7.1）——這三條要有收 `name` 的端點才驗得到，故排在 T4
def test_target_must_not_be_a_directory(tmp_path, monkeypatch):
    c, proj, tasks, fp = _with_ticket(tmp_path, monkeypatch)
    (tasks / "02-dir.md").mkdir()
    for method, kwargs in (("patch", {"json": {"project": str(proj), "name": "02-dir.md", "status": "done", "fingerprint": fp}}),
                           ("delete", {"params": {"project": str(proj), "name": "02-dir.md", "fingerprint": fp}})):
        r = c.request(method.upper(), "/tasks", **kwargs)
        assert r.status_code == 400, method
    assert (tasks / "02-dir.md").is_dir()          # 沒被刪掉


def test_target_must_end_with_md(tmp_path, monkeypatch):
    c, proj, tasks, fp = _with_ticket(tmp_path, monkeypatch)
    (tasks / "note.txt").write_text("x", encoding="utf-8")
    r = c.request("DELETE", "/tasks", params={"project": str(proj), "name": "note.txt", "fingerprint": fp})
    assert r.status_code == 400 and (tasks / "note.txt").exists()


def test_target_must_not_be_a_symlink(tmp_path, monkeypatch):
    c, proj, tasks, fp = _with_ticket(tmp_path, monkeypatch)
    outside = tmp_path / "secret.md"
    outside.write_text("機密", encoding="utf-8")
    (tasks / "09-link.md").symlink_to(outside)
    r = c.request("DELETE", "/tasks", params={"project": str(proj), "name": "09-link.md", "fingerprint": fp})
    assert r.status_code == 400
    assert outside.exists()                        # symlink 指向的檔案沒被碰到


def test_target_name_must_be_plain(tmp_path, monkeypatch):
    c, proj, _, fp = _with_ticket(tmp_path, monkeypatch)
    for bad in ("../01-a.md", "..", ".", "sub/01-a.md"):
        r = c.request("DELETE", "/tasks", params={"project": str(proj), "name": bad, "fingerprint": fp})
        assert r.status_code == 400, bad


def test_patch_reports_io_failure_as_500_not_400(tmp_path, monkeypatch):
    """I/O 失敗要與「目標不合法」分開回報——磁碟滿被報成參數錯誤會讓人查錯方向。"""
    import fledge_sidecar.tasks.scanner as sc

    c, proj, tasks, fp = _with_ticket(tmp_path, monkeypatch)
    # 注入真實的 I/O 失敗來源（不是直接丟 TaskWriteError）——要驗的是
    # scanner 有把 OSError 包成 TaskWriteError，而不只是 except 的排序
    monkeypatch.setattr(sc, "_write_all",
                        lambda fd, data: (_ for _ in ()).throw(OSError(28, "No space left on device")))
    before = (tasks / "01-a.md").read_bytes()
    r = c.patch("/tasks", json={"project": str(proj), "name": "01-a.md",
                                "status": "doing", "fingerprint": fp})
    assert r.status_code == 500 and r.json()["error"] == "write_failed"
    assert (tasks / "01-a.md").read_bytes() == before


def test_patch_reports_permission_error_as_500_not_400(tmp_path, monkeypatch):
    """唯讀檔／唯讀檔案系統是 I/O 問題，不是「目標不合法」。

    檔案存在、名字合法、型別正確，只是開不起來——回 400 invalid_target 會讓人
    往「參數寫錯」的方向查（2026-08-31 第三輪 Codex 複審抓到）。"""
    import os

    import pytest

    if os.geteuid() == 0:
        pytest.skip("root 無視檔案權限")
    c, proj, tasks, fp = _with_ticket(tmp_path, monkeypatch)
    os.chmod(tasks / "01-a.md", 0o444)          # 唯讀 → O_RDWR 會拿到 EACCES
    try:
        r = c.patch("/tasks", json={"project": str(proj), "name": "01-a.md",
                                    "status": "doing", "fingerprint": fp})
        assert r.status_code == 500 and r.json()["error"] == "write_failed"
    finally:
        os.chmod(tasks / "01-a.md", 0o644)


# ── PUT /tasks/content（spec §8）─────────────────────────────────────────

def _std_ticket(d, name="01-t.md"):
    p = d / name
    p.write_text("---\nstatus: todo\nsource: me\ncreated: 2026-09-01\n---\n\n# t\n\nb\n", encoding="utf-8")
    return p


def test_put_content_registered_on_composed_app(tmp_path, monkeypatch):
    """接線測試：對【組好的 app】打，斷言 200 ＋ shape。**不可寫成「非 404」**（spec §10.1）。"""
    root = tmp_path / "root"; proj = root / "p"; d = proj / ".fledge" / "tasks"
    d.mkdir(parents=True)
    p = _std_ticket(d)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    fp = c.get(f"/tasks?project={proj}").json()["tasks"][0]["fingerprint"]
    r = c.put("/tasks/content", json={"project": str(proj), "name": "01-t.md", "title": "new", "body": "nb", "fingerprint": fp})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "new" and body["body"] == "nb" and body["name"] == "01-t.md"
    assert body["editable"] is True and "fingerprint" in body
    assert p.read_text(encoding="utf-8").endswith("# new\n\nnb\n")


def test_put_content_stale_returns_409_and_leaves_file(tmp_path, monkeypatch):
    root = tmp_path / "root"; proj = root / "p"; d = proj / ".fledge" / "tasks"
    d.mkdir(parents=True)
    p = _std_ticket(d)
    before = p.read_bytes()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.put("/tasks/content", json={"project": str(proj), "name": "01-t.md", "title": "x", "body": "", "fingerprint": "wrong"})
    assert r.status_code == 409 and r.json()["error"] == "stale"
    assert p.read_bytes() == before


def test_put_content_not_editable_returns_400(tmp_path, monkeypatch):
    root = tmp_path / "root"; proj = root / "p"; d = proj / ".fledge" / "tasks"
    d.mkdir(parents=True)
    p = d / "01-bad.md"
    p.write_bytes(b"---\nstatus: todo\n---suffix\n# t\n")
    before = p.read_bytes()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    fp = c.get(f"/tasks?project={proj}").json()["tasks"][0]["fingerprint"]
    r = c.put("/tasks/content", json={"project": str(proj), "name": "01-bad.md", "title": "x", "body": "", "fingerprint": fp})
    assert r.status_code == 400 and r.json()["error"] == "not_editable"
    assert p.read_bytes() == before


def test_put_content_invalid_domain_returns_400(tmp_path, monkeypatch):
    root = tmp_path / "root"; proj = root / "p"; d = proj / ".fledge" / "tasks"
    d.mkdir(parents=True)
    _std_ticket(d)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    fp = c.get(f"/tasks?project={proj}").json()["tasks"][0]["fingerprint"]
    r = c.put("/tasks/content", json={"project": str(proj), "name": "01-t.md", "title": "", "body": "", "fingerprint": fp})
    assert r.status_code == 400 and r.json()["error"] == "invalid_content"


def test_put_content_requires_name_and_fingerprint(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.put("/tasks/content", json={"project": "/x", "name": "", "title": "t", "body": "", "fingerprint": "f"}).status_code == 400
    assert c.put("/tasks/content", json={"project": "/x", "name": "a.md", "title": "t", "body": "", "fingerprint": ""}).status_code == 400


def test_put_content_path_boundary(tmp_path, monkeypatch):
    """T1：非純檔名一律 400（spec §5.3 沿用既有邊界）。"""
    root = tmp_path / "root"; proj = root / "p"; d = proj / ".fledge" / "tasks"
    d.mkdir(parents=True)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    for bad in ("../x.md", "sub/x.md", ".", "x.txt"):
        r = c.put("/tasks/content", json={"project": str(proj), "name": bad, "title": "t", "body": "", "fingerprint": "f"})
        assert r.status_code == 400, bad


def test_put_content_read_failure_returns_500(tmp_path, monkeypatch):
    """spec §8：I/O 失敗回 500，不是 400。fd 已經過 `_open_existing` 的 T1–T4 邊界檢查，
    `_read_all` 之後失敗只可能是 I/O（EIO、掛載掉了…），不是「目標不合法」（Codex 對抗式
    審查抓到：改前這裡會落到路由的 generic OSError 分支，誤報成 400 invalid_target）。"""
    import errno

    from fledge_sidecar.tasks import scanner

    root = tmp_path / "root"; proj = root / "p"; d = proj / ".fledge" / "tasks"
    d.mkdir(parents=True)
    _std_ticket(d)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    fp = c.get(f"/tasks?project={proj}").json()["tasks"][0]["fingerprint"]

    def boom(fd):
        raise OSError(errno.EIO, "io error")

    monkeypatch.setattr(scanner, "_read_all", boom)
    r = c.put("/tasks/content", json={"project": str(proj), "name": "01-t.md", "title": "x", "body": "", "fingerprint": fp})
    assert r.status_code == 500 and r.json()["error"] == "write_failed"


# ── GET /tasks/note（票 19）────────────────────────────────────────────

def test_note_registered_on_composed_app_and_shape(tmp_path, monkeypatch):
    """接線：對組好的 app 打 /tasks/note 斷言 200＋shape（不可寫成「非 404」，見檔頭）。"""
    root = _project_root(tmp_path)
    p = root / "p"
    (p / ".fledge").mkdir(parents=True)
    (p / ".fledge" / "state.md").write_text("# p\n\n**下一步**：x\n", encoding="utf-8")
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.get("/tasks/note", params={"project": str(p)})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["content"].startswith("# p")
    assert body["path"] == str(p / ".fledge" / "state.md")
    assert len(body["mtime"]) == 10


def test_note_unknown_project_is_400(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch, roots=[])
    r = c.get("/tasks/note", params={"project": str(tmp_path / "nope")})
    assert r.status_code == 400 and r.json()["error"] == "unknown_project"


def test_note_absent_and_unavailable_have_null_content_and_path(tmp_path, monkeypatch):
    root = _project_root(tmp_path)
    (root / "bare").mkdir()
    linked = root / "linked"
    linked.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (linked / ".fledge").symlink_to(elsewhere, target_is_directory=True)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    a = c.get("/tasks/note", params={"project": str(root / "bare")}).json()
    assert a == {"status": "absent", "content": None, "mtime": None, "path": None, "fingerprint": None, "editable": False}
    u = c.get("/tasks/note", params={"project": str(linked)}).json()
    assert u == {"status": "unavailable", "content": None, "mtime": None, "path": None, "fingerprint": None, "editable": False}


def test_note_requires_token_when_auth_enforced(tmp_path, monkeypatch):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "accounts": {}, "roots": [], "kms_root": ""}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    assert TestClient(create_app()).get("/tasks/note", params={"project": "/x"}).status_code == 401


# ── GET /tasks/note 多回 fingerprint／editable、PUT /tasks/note（票 19 增補，spec §10.2）──

NOTE = "# p\n\n**下一步**：old，後面拖一段長尾巴讓新內容比它短\n"


def _with_note(tmp_path, monkeypatch, *, text=NOTE):
    """造一個有 state.md 的專案，回 (client, proj, state 路徑, GET 回的 fingerprint)。"""
    root = _project_root(tmp_path)
    proj = root / "p1"
    (proj / ".fledge").mkdir(parents=True)
    state = proj / ".fledge" / "state.md"
    state.write_bytes(text.encode("utf-8") if isinstance(text, str) else text)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    fp = c.get("/tasks/note", params={"project": str(proj)}).json()["fingerprint"]
    return c, proj, state, fp


def test_get_note_returns_fingerprint_and_editable(tmp_path, monkeypatch):
    """spec §10.2：ok 時 `fingerprint` 是 sha256(讀到的位元組)、`editable` 看大小 ≤ 64KB（D15）。"""
    import hashlib

    c, proj, state, fp = _with_note(tmp_path, monkeypatch)
    body = c.get("/tasks/note", params={"project": str(proj)}).json()
    assert body["fingerprint"] == hashlib.sha256(NOTE.encode("utf-8")).hexdigest()
    assert body["editable"] is True
    state.write_bytes(b"a" * (65 * 1024))
    body = c.get("/tasks/note", params={"project": str(proj)}).json()
    assert body["status"] == "ok" and body["editable"] is False
    assert body["fingerprint"] == hashlib.sha256(b"a" * (64 * 1024)).hexdigest()


def test_get_note_editable_false_for_crlf_file(tmp_path, monkeypatch):
    """`editable` ＝「PUT 會收」：CRLF 檔 PUT 回 not_editable，GET 的 editable 就是 False；內容與 fingerprint 照給。"""
    crlf = b"# p\r\n\r\nx\r\n"
    c, proj, state, fp = _with_note(tmp_path, monkeypatch, text=crlf)
    r = c.get("/tasks/note", params={"project": str(proj)})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["editable"] is False
    assert body["fingerprint"] is not None and body["content"] is not None


def test_get_note_editable_false_for_hard_link_and_put_is_400(tmp_path, monkeypatch):
    """硬連結的 state.md：GET `editable` False（與 PUT 的 T4 同一個判斷）、PUT 400 invalid_target、內容不動。"""
    import os

    c, proj, state, fp = _with_note(tmp_path, monkeypatch)
    os.link(state, tmp_path / "elsewhere.md")
    g = c.get("/tasks/note", params={"project": str(proj)})
    assert g.status_code == 200
    assert g.json()["editable"] is False and g.json()["fingerprint"] == fp
    r = c.put("/tasks/note", json={"project": str(proj), "content": "x\n", "fingerprint": fp})
    assert r.status_code == 400 and r.json()["error"] == "invalid_target"
    assert c.get("/tasks/note", params={"project": str(proj)}).json()["content"] == NOTE


def test_put_note_ok_shape(tmp_path, monkeypatch):
    """接線：對組好的 app 打 PUT /tasks/note 斷言 200＋與 GET 同形（不可寫成「非 404」，見檔頭）。"""
    c, proj, state, fp = _with_note(tmp_path, monkeypatch)
    new = "# p\n\n**下一步**：new\n"
    r = c.put("/tasks/note", json={"project": str(proj), "content": new, "fingerprint": fp})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"status", "content", "mtime", "path", "fingerprint", "editable"}
    assert body["status"] == "ok" and body["content"] == new and body["editable"] is True
    assert body["path"] == str(state) and len(body["mtime"]) == 10
    assert body["fingerprint"] != fp
    assert state.read_text(encoding="utf-8") == new
    again = c.get("/tasks/note", params={"project": str(proj)}).json()
    assert again["content"] == new and again["fingerprint"] == body["fingerprint"]
    # 用新 fingerprint 再存一次要成功——回傳的 fingerprint 必須是磁碟上的那份
    r2 = c.put("/tasks/note", json={"project": str(proj), "content": "# p\n", "fingerprint": body["fingerprint"]})
    assert r2.status_code == 200 and state.read_text(encoding="utf-8") == "# p\n"


def test_put_note_stale_is_409(tmp_path, monkeypatch):
    c, proj, state, fp = _with_note(tmp_path, monkeypatch)
    before = state.read_bytes()
    r = c.put("/tasks/note", json={"project": str(proj), "content": "x\n", "fingerprint": "wrong"})
    assert r.status_code == 409 and r.json()["error"] == "stale"
    assert state.read_bytes() == before


def test_put_note_absent_is_404(tmp_path, monkeypatch):
    """spec §10.2「不建檔」：沒有 state.md（不論 .fledge/ 在不在）→ 404 not_found，且不會建出檔案。"""
    root = _project_root(tmp_path)
    (root / "has_fledge" / ".fledge").mkdir(parents=True)
    (root / "bare").mkdir()
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    for name in ("has_fledge", "bare"):
        r = c.put("/tasks/note", json={"project": str(root / name), "content": "# new\n", "fingerprint": "f"})
        assert r.status_code == 404 and r.json()["error"] == "not_found", name
    assert not (root / "has_fledge" / ".fledge" / "state.md").exists()
    assert not (root / "bare" / ".fledge").exists()


def test_put_note_unavailable_fledge_is_400(tmp_path, monkeypatch):
    """`.fledge/` 是 symlink → resolver 回 unavailable、fledge_fd None → 400 fledge_dir_unavailable，目標不動。"""
    root = _project_root(tmp_path)
    linked = root / "linked"
    linked.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "state.md").write_bytes(b"secret\n")
    (linked / ".fledge").symlink_to(elsewhere, target_is_directory=True)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    r = c.put("/tasks/note", json={"project": str(linked), "content": "pwned\n", "fingerprint": "f"})
    assert r.status_code == 400 and r.json()["error"] == "fledge_dir_unavailable"
    assert (elsewhere / "state.md").read_bytes() == b"secret\n"


def test_put_note_unknown_project_is_400(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch, roots=[])
    r = c.put("/tasks/note", json={"project": str(tmp_path / "nope"), "content": "x\n", "fingerprint": "f"})
    assert r.status_code == 400 and r.json()["error"] == "unknown_project"


def test_put_note_requires_fingerprint(tmp_path, monkeypatch):
    c, proj, state, fp = _with_note(tmp_path, monkeypatch)
    before = state.read_bytes()
    r = c.put("/tasks/note", json={"project": str(proj), "content": "x\n"})
    assert r.status_code == 400 and r.json()["error"] == "fingerprint_required"
    r = c.put("/tasks/note", json={"project": str(proj), "content": "x\n", "fingerprint": ""})
    assert r.status_code == 400 and r.json()["error"] == "fingerprint_required"
    assert state.read_bytes() == before


def test_put_note_symlinked_state_is_400(tmp_path, monkeypatch):
    """T3：state.md 是 symlink → 400 invalid_target（不是 500），目標檔不動。給目標的正確 fingerprint，
    證明擋下它的是 O_NOFOLLOW 不是 fingerprint。"""
    import hashlib

    root = _project_root(tmp_path)
    proj = root / "p1"
    (proj / ".fledge").mkdir(parents=True)
    target = tmp_path / "target.md"
    target.write_bytes(b"secret\n")
    (proj / ".fledge" / "state.md").symlink_to(target)
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    fp = hashlib.sha256(b"secret\n").hexdigest()
    r = c.put("/tasks/note", json={"project": str(proj), "content": "pwned\n", "fingerprint": fp})
    assert r.status_code == 400 and r.json()["error"] == "invalid_target"
    assert target.read_bytes() == b"secret\n"


def test_put_note_not_editable_and_invalid_content_codes(tmp_path, monkeypatch):
    """spec §10.2 的 400 碼表是封閉列舉：超過 64KB → not_editable；新內容含 \\r → invalid_content。"""
    import hashlib

    big = b"a" * (65 * 1024)
    c, proj, state, fp = _with_note(tmp_path, monkeypatch, text=big)
    r = c.put("/tasks/note", json={"project": str(proj), "content": "x\n", "fingerprint": hashlib.sha256(big).hexdigest()})
    assert r.status_code == 400 and r.json()["error"] == "not_editable"
    assert state.read_bytes() == big
    state.write_bytes(NOTE.encode("utf-8"))
    fp = c.get("/tasks/note", params={"project": str(proj)}).json()["fingerprint"]
    r = c.put("/tasks/note", json={"project": str(proj), "content": "a\r\nb\n", "fingerprint": fp})
    assert r.status_code == 400 and r.json()["error"] == "invalid_content"
    assert state.read_bytes() == NOTE.encode("utf-8")


def test_put_note_content_over_limit_is_400(tmp_path, monkeypatch):
    """新內容超過 NOTE_MAX_BYTES → 400 invalid_content，磁碟不動、GET 仍回舊內容（fix round 2）。"""
    c, proj, state, fp = _with_note(tmp_path, monkeypatch)
    r = c.put("/tasks/note", json={"project": str(proj), "content": "a" * (64 * 1024 + 1), "fingerprint": fp})
    assert r.status_code == 400 and r.json()["error"] == "invalid_content"
    again = c.get("/tasks/note", params={"project": str(proj)}).json()
    assert again["content"] == NOTE and again["fingerprint"] == fp and again["editable"] is True


def test_put_note_writes_when_tasks_dir_is_broken_but_fledge_opens(tmp_path, monkeypatch):
    """寫入路徑的「有 fledge_fd 就往下、不看 tasks/ 狀態」（spec §10.2；讀取路徑的雙胞胎在 scanner 測試）：
    `.fledge/tasks` 是一般檔案 → resolver 回 unavailable，但 state.md 住在 `.fledge/`，GET／PUT 都要能動。"""
    root = _project_root(tmp_path)
    proj = root / "p1"
    (proj / ".fledge").mkdir(parents=True)
    (proj / ".fledge" / "tasks").write_text("not a dir", encoding="utf-8")
    state = proj / ".fledge" / "state.md"
    state.write_text(NOTE, encoding="utf-8")
    c = _client(tmp_path, monkeypatch, roots=[{"path": str(root), "default_account": "work"}])
    assert c.get("/tasks", params={"project": str(proj)}).json()["tasks_status"] == "unavailable"   # 前提：情境真的長這樣
    g = c.get("/tasks/note", params={"project": str(proj)}).json()
    assert g["status"] == "ok" and g["editable"] is True
    r = c.put("/tasks/note", json={"project": str(proj), "content": "# p\n\n**下一步**：new\n", "fingerprint": g["fingerprint"]})
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert state.read_text(encoding="utf-8") == "# p\n\n**下一步**：new\n"


def test_put_note_read_failure_returns_500(tmp_path, monkeypatch):
    """spec §10.2：寫入 I/O 失敗 → 500 write_failed，不是 400（與 PUT /tasks/content 同一條）。"""
    import errno

    from fledge_sidecar.tasks import scanner

    c, proj, state, fp = _with_note(tmp_path, monkeypatch)

    def boom(fd):
        raise OSError(errno.EIO, "io error")

    monkeypatch.setattr(scanner, "_read_all", boom)
    r = c.put("/tasks/note", json={"project": str(proj), "content": "x\n", "fingerprint": fp})
    assert r.status_code == 500 and r.json()["error"] == "write_failed"


def test_put_note_requires_token_when_auth_enforced(tmp_path, monkeypatch):
    """認證拒絕另立一條（design §9.1）。**TokenAuthMiddleware 在路由分派之前就回 401**，
    所以這條在 PUT 路由存在之前就會綠——它守的是 middleware 沒被繞過，不是路由接線。"""
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"version": 1, "accounts": {}, "roots": [], "kms_root": ""}), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg))
    monkeypatch.delenv("FLEDGE_TEST_UNAUTH", raising=False)
    monkeypatch.setenv("FLEDGE_TOKEN", "secret")
    r = TestClient(create_app()).put("/tasks/note", json={"project": "/x", "content": "x", "fingerprint": "f"})
    assert r.status_code == 401

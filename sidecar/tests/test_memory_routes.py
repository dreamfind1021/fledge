import json
import os
from pathlib import Path
from fastapi.testclient import TestClient
from fledge_sidecar.app import create_app
import fledge_sidecar.routes.memory as mem


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")
    monkeypatch.setenv("FLEDGE_MEMORY_LINKS", str(tmp_path / "memory-links.json"))
    mem.reset_state_for_tests()
    return TestClient(create_app())


def _client_with_config(tmp_path, monkeypatch, *, config_dir=None, kms_root=None):
    """寫一份真 config.json（含自訂 account/kms_root）讓路由的 AppConfig.load() 撿到。"""
    cfg_path = tmp_path / "config.json"
    data = {"version": 1, "accounts": {}, "kms_root": ""}
    if config_dir is not None:
        data["accounts"] = {"work": {"config_dir": str(config_dir), "label": "work"}}
    if kms_root is not None:
        data["kms_root"] = str(kms_root)
    cfg_path.write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setenv("FLEDGE_CONFIG_PATH", str(cfg_path))
    return _client(tmp_path, monkeypatch)


def test_overview_shape(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/memory/overview")
    assert r.status_code == 200
    j = r.json()
    assert set(j) >= {"global", "projects", "kb", "scan_meta"}


def test_links_crud_and_dismiss(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.post("/memory/links", json={"from": "/a", "to": "/b", "note": "x"}).status_code == 200
    assert c.post("/memory/links/dismiss", json={"project": "/p", "topic": "/t"}).status_code == 200
    assert c.request("DELETE", "/memory/links", json={"from": "/a", "to": "/b"}).status_code == 200


def test_item_rejects_traversal(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/memory/item", params={"path": "/etc/passwd"})
    assert r.status_code in (400, 403)        # containment 擋 root 外


def test_item_native_exact_shape_only(tmp_path, monkeypatch):
    """FIX 1：native /item 只放行 projects/<enc>/memory/*.md 這個精確形狀。"""
    cd = tmp_path / ".claude"
    enc = cd / "projects" / "-work-fledge"
    # 合法形狀
    legit = enc / "memory" / "foo.md"
    legit.parent.mkdir(parents=True)
    legit.write_text("# legit\nbody", encoding="utf-8")
    # 多一段：projects/<enc>/sub/memory/x.md
    extra = enc / "sub" / "memory" / "x.md"
    extra.parent.mkdir(parents=True)
    extra.write_text("# extra\nbody", encoding="utf-8")
    # memory 下再巢狀：projects/<enc>/memory/deep/x.md
    deep = enc / "memory" / "deep" / "x.md"
    deep.parent.mkdir(parents=True)
    deep.write_text("# deep\nbody", encoding="utf-8")

    c = _client_with_config(tmp_path, monkeypatch, config_dir=cd)
    assert c.get("/memory/item", params={"path": str(legit)}).status_code == 200
    assert c.get("/memory/item", params={"path": str(extra)}).status_code == 403
    assert c.get("/memory/item", params={"path": str(deep)}).status_code == 403


def test_item_kms_reads_via_realpath(tmp_path, monkeypatch):
    """FIX 3：請求的 path 是 KMS root 內指向 root 內檔案的 symlink → 200 讀到 target 內容。"""
    root = tmp_path / "kms"
    target = root / "library" / "real.md"
    target.parent.mkdir(parents=True)
    target.write_text("# real\nTARGET-BODY", encoding="utf-8")
    link = root / "library" / "alias.md"
    link.symlink_to(target)

    c = _client_with_config(tmp_path, monkeypatch, kms_root=root)
    r = c.get("/memory/item", params={"path": str(link)})
    assert r.status_code == 200
    assert "TARGET-BODY" in r.json()["body"]    # 讀的是 resolved 後的 target

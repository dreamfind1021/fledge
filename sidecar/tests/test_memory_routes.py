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

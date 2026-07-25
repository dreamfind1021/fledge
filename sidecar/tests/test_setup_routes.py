from fastapi.testclient import TestClient

import fledge_sidecar.routes.setup as setup_mod
from fledge_sidecar.app import create_app
from fledge_sidecar.setup.env_detect import ToolStatus


def test_status_returns_tools(monkeypatch):
    fake = [
        ToolStatus("node", "Node.js", "core", True, "/opt/homebrew/bin/node", "v25.8.2"),
        ToolStatus("git", "Git", "core", False, None, None),
    ]
    monkeypatch.setattr(setup_mod, "detect_all", lambda: fake)
    body = TestClient(create_app()).get("/api/setup/status").json()
    assert [t["id"] for t in body["tools"]] == ["node", "git"]
    node = body["tools"][0]
    assert node["installed"] is True and node["version"] == "v25.8.2"
    assert body["tools"][1]["installed"] is False and body["tools"][1]["path"] is None

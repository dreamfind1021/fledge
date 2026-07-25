from fledge_sidecar.setup import install_specs as isp


def test_tool_specs_cover_core_tools():
    ids = {s.id for s in isp.TOOL_SPECS}
    assert {"homebrew", "node", "git", "claude", "codex"} <= ids


def test_every_spec_has_required_fields():
    for s in isp.TOOL_SPECS:
        assert s.id and s.label and s.binary and s.docs_url
        assert s.tier in {"core", "recommended"}
        assert isinstance(s.version_argv, list) and s.version_argv
        assert s.install_command is None or isinstance(s.install_command, str)


def test_get_spec_known_and_unknown():
    assert isp.get_spec("node").binary == "node"
    assert isp.get_spec("nope") is None
    assert isp.get_spec(None) is None


def test_get_install_command_allowlist():
    # node 有固定安裝命令
    assert isp.get_install_command("node") == "brew install node"
    # homebrew 僅手動（install_command is None）→ 回 None
    assert isp.get_install_command("homebrew") is None
    # 未知 id → None（route 據此回 400）
    assert isp.get_install_command("rm-rf-slash") is None
    assert isp.get_install_command(None) is None

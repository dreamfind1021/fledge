import subprocess

from fledge_sidecar.setup import env_detect as ed
from fledge_sidecar.setup.install_specs import ToolSpec

SPEC = ToolSpec("node", "Node.js", "core", "node", ["node", "--version"],
                "brew install node", "https://nodejs.org")


def _fake_run_ok(argv, **kw):
    return subprocess.CompletedProcess(argv, 0, stdout="v25.8.2\n", stderr="")


def test_detect_installed_with_version():
    st = ed.detect_tool(SPEC, which=lambda b: "/opt/homebrew/bin/node", run=_fake_run_ok)
    assert st.installed is True
    assert st.path == "/opt/homebrew/bin/node"
    assert st.version == "v25.8.2"
    assert st.id == "node" and st.tier == "core"


def test_detect_missing_skips_version_probe():
    called = False
    def _run(argv, **kw):
        nonlocal called
        called = True
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
    st = ed.detect_tool(SPEC, which=lambda b: None, run=_run)
    assert st.installed is False
    assert st.path is None and st.version is None
    assert called is False  # 未安裝不探版本（省時）


def test_detect_version_probe_failure_is_tolerated():
    def _run(argv, **kw):
        raise OSError("boom")
    st = ed.detect_tool(SPEC, which=lambda b: "/usr/bin/node", run=_run)
    assert st.installed is True
    assert st.version is None  # 探測失敗不拋、version=None


def test_detect_version_probe_timeout_is_tolerated():
    # 已安裝但 --version 卡住：TimeoutExpired（SubprocessError 子類）應被吞、version=None（plan review #2）
    def _run(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 2)
    st = ed.detect_tool(SPEC, which=lambda b: "/usr/bin/node", run=_run)
    assert st.installed is True and st.version is None


def test_detect_all_returns_one_status_per_spec():
    out = ed.detect_all(which=lambda b: None,
                        run=lambda *a, **k: subprocess.CompletedProcess(a, 0, "", ""))
    from fledge_sidecar.setup.install_specs import TOOL_SPECS
    assert len(out) == len(TOOL_SPECS)
    assert {s.id for s in out} == {s.id for s in TOOL_SPECS}

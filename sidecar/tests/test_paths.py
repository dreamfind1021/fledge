import os
from pathlib import Path

import pytest

from fledge_sidecar import paths


def test_expand_and_validate_expands_user(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert paths.expand_and_validate("~/x") == str(tmp_path / "x")


def test_expand_and_validate_rejects_empty():
    with pytest.raises(ValueError):
        paths.expand_and_validate("")
    with pytest.raises(ValueError):
        paths.expand_and_validate("   ")


def test_expand_and_validate_rejects_relative():
    with pytest.raises(ValueError):
        paths.expand_and_validate("relative/path")


def test_expand_and_validate_absolute_passes(tmp_path):
    assert paths.expand_and_validate(str(tmp_path)) == str(tmp_path)


def test_resolve_best_effort_follows_symlink(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    assert paths.resolve_best_effort(str(link)) == str(real.resolve())


def test_resolve_best_effort_fallback_on_oserror(monkeypatch, tmp_path):
    def boom(self, *a, **k):
        raise OSError("nope")
    monkeypatch.setattr(Path, "resolve", boom)
    assert paths.resolve_best_effort(str(tmp_path)) == str(tmp_path)


def test_canonicalize_rejects_relative():
    with pytest.raises(ValueError):
        paths.canonicalize("relative")


def test_probe_dir_dir(tmp_path):
    assert paths.probe_dir(str(tmp_path)) == "dir"


def test_probe_dir_missing(tmp_path):
    assert paths.probe_dir(str(tmp_path / "nope")) == "missing"


def test_probe_dir_not_dir(tmp_path):
    f = tmp_path / "f.txt"
    f.write_text("x")
    assert paths.probe_dir(str(f)) == "not_dir"


def test_probe_dir_symlink_to_dir(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    assert paths.probe_dir(str(link)) == "dir"


def test_probe_dir_denied(monkeypatch, tmp_path):
    # 用 monkeypatch 模擬 PermissionError，不靠 chmod 000（root/CI/跨平台不穩）
    def boom(*a, **k):
        raise PermissionError("denied")
    monkeypatch.setattr(os, "stat", boom)
    assert paths.probe_dir(str(tmp_path)) == "denied"


# --- is_within_root / is_within_any_root ---

from fledge_sidecar.paths import is_within_root, is_within_any_root


def test_within_equal_root():
    assert is_within_root("/a/b", "/a/b")


def test_within_child():
    assert is_within_root("/a/b/c", "/a/b")


def test_within_prefix_false_positive():
    assert not is_within_root("/a/bc", "/a/b")  # /a/bc 不在 /a/b 下


def test_within_outside():
    assert not is_within_root("/x/y", "/a/b")


def test_within_trailing_sep_root():
    assert is_within_root("/a/b/c", "/a/b/")


def test_within_any():
    assert is_within_any_root("/a/b/c", ["/x", "/a/b"])
    assert not is_within_any_root("/z", ["/x", "/a/b"])

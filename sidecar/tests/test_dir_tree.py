from pathlib import Path

from fledge_sidecar.dir_tree import list_dir_entries


def test_excludes_dotfiles(tmp_path: Path):
    (tmp_path / ".hidden").write_text("x")
    (tmp_path / "visible.txt").write_text("x")
    assert [e["name"] for e in list_dir_entries(tmp_path)] == ["visible.txt"]


def test_dirs_before_files_then_name(tmp_path: Path):
    (tmp_path / "b_dir").mkdir()
    (tmp_path / "a_file.txt").write_text("x")
    (tmp_path / "a_dir").mkdir()
    (tmp_path / "z_file.txt").write_text("x")
    got = [(e["name"], e["is_dir"]) for e in list_dir_entries(tmp_path)]
    assert got == [("a_dir", True), ("b_dir", True), ("a_file.txt", False), ("z_file.txt", False)]


def test_empty_dir(tmp_path: Path):
    assert list_dir_entries(tmp_path) == []


def test_path_field_is_child_path(tmp_path: Path):
    (tmp_path / "f.txt").write_text("x")
    assert list_dir_entries(tmp_path)[0]["path"] == str(tmp_path / "f.txt")

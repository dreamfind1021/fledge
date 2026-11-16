"""`scripts/expansion_guard.py`：備份端與還原端共用的展開量判準（xz 改版 spec §6.5）。

直接呼叫判準本身、不經兩支腳本——門檻兩側要精確到位元組，用整份備份包造不出來。
"""
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / "scripts" / "expansion_guard.py"
MIB = 1 << 20


def _guard(tree: Path, bundle: Path, env: dict | None = None):
    # 兩支腳本都是 `python3 <判準>`，這裡用同一個 python3
    return subprocess.run(
        ["python3", str(GUARD), str(tree), str(bundle)],
        capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})},
    )


def _sparse(path: Path, size: int) -> Path:
    """稀疏檔：`st_size` 是邏輯大小，判準量的就是它——不必真的寫十幾 MiB。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.truncate(size)
    return path


def test_exactly_100_times_is_accepted(tmp_path: Path):
    tree = tmp_path / "tree"
    _sparse(tree / "accounts" / "big.bin", 100 * 100 * 1024)       # 10,240,000 bytes，超過 8 MiB
    proc = _guard(tree, _sparse(tmp_path / "b.tar.xz", 100 * 1024))
    assert proc.returncode == 0, proc.stderr


def test_one_byte_over_100_times_is_refused(tmp_path: Path):
    """不用整數截斷比較：100 倍又多 1 byte 就要擋。"""
    tree = tmp_path / "tree"
    _sparse(tree / "accounts" / "big.bin", 100 * 100 * 1024 + 1)
    proc = _guard(tree, _sparse(tmp_path / "b.tar.xz", 100 * 1024))
    assert proc.returncode == 1
    assert "超過 100 倍的上限" in proc.stderr


def test_trees_up_to_8_mib_skip_the_ratio_check(tmp_path: Path):
    """8 MiB 以下不看比例：小包的壓縮固定開銷會讓比例失真。"""
    tree = tmp_path / "tree"
    _sparse(tree / "accounts" / "big.bin", 8 * MIB)
    proc = _guard(tree, _sparse(tmp_path / "b.tar.xz", 1))
    assert proc.returncode == 0, proc.stderr


def test_entry_count_limit_is_strictly_greater_than(tmp_path: Path):
    """項目數的上限與大小無關（零大小成員擋不住比例判準）；剛好等於上限放行、多一個就擋。"""
    tree = tmp_path / "tree"
    tree.mkdir()
    for i in range(51):
        (tree / f"e{i}").touch()
    bundle = _sparse(tmp_path / "b.tar.xz", 1)
    refused = _guard(tree, bundle, {"FLEDGE_MAX_ENTRIES": "50"})
    assert refused.returncode == 1
    assert "超過 50 個的上限" in refused.stderr
    (tree / "e50").unlink()
    assert _guard(tree, bundle, {"FLEDGE_MAX_ENTRIES": "50"}).returncode == 0

"""備份包當成攻擊面時的行為契約（票 08 驗收關卡，plan Task 10）。

前提：使用者可能拿到別人給的備份包，所以 manifest 的宣告、symlink 目標、目錄結構
**全部是不可信輸入**。

**本檔只放 Task 10 清單裡 `test_install.py` 尚未覆蓋的兩條**——symlink 六態（指外部
絕對路徑／`..` 逃逸／指 root 本身／循環／目標存在但非本次裝／staging 內 symlink 子樹）
與 `.claude.json` 兩條，都已在票 03–09 的 Codex 輪次中落地於 `test_install.py`，
不重寫。

**全程假 HOME + tmp_path，絕不碰真實的 ~/.claude。**
"""
import errno
import json
import os
from pathlib import Path

import pytest
from conftest import make_staging as _staging

from fledge_sidecar.backup import install as inst


@pytest.fixture(autouse=True)
def _fake_home(tmp_path: Path, monkeypatch):
    """install() 會寫 provenance journal 到 ~/.fledge——沒有這層，本檔任何一條都會寫
    進真實家目錄。刻意不抽進 conftest 當 autouse：那會擴及整個 tests/ 目錄、改變既有
    41 個測試檔的環境，風險遠大於省下這三行。"""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))


def _accounts(target: Path) -> dict[str, dict[str, str]]:
    return {"work": {"config_dir": str(target), "label": ""}}


def test_link_unsupported_is_failed_not_skipped(tmp_path: Path, monkeypatch):
    """`os.link` 回 EOPNOTSUPP（exFAT／部分 SMB）→ 判 failed 並回判別碼。

    兩條都不許：**不得退回 rename**（那是 check-then-act，並行 install 會互相覆蓋現役
    檔案），**也不得當成 skipped**（`target_exists` 是 EEXIST 才有的語意，混進來就是
    靜默漏裝——使用者會看到「已存在」然後永遠不知道檔案沒搬過去）。"""
    def _no_link(*args, **kwargs):
        raise OSError(errno.EOPNOTSUPP, "not supported")

    monkeypatch.setattr(inst.safe_fs.os, "link", _no_link)
    src = _staging(tmp_path)
    tgt = tmp_path / "live"
    tgt.mkdir()

    results = inst.install(inst.plan(str(src), _accounts(tgt)))

    md = [r for r in results if r.rel_path == "CLAUDE.md"]
    assert md and md[0].outcome == "failed"
    assert md[0].error == "operation_not_supported"
    assert not (tgt / "CLAUDE.md").exists()
    # 本進程活著走到例外路徑 → 暫存檔要清掉，不在使用者目錄留垃圾
    assert [p.name for p in tgt.iterdir() if p.name.startswith(".fledge-install-")] == []


def test_manifest_cannot_authorize_arbitrary_landing_spot(tmp_path: Path):
    """manifest 宣稱落點在別處 → plan 不採用它，只用 caller 給的（＝使用者確認過的）。

    manifest 的 `accounts` 只用來列出「包裡有哪些帳號」，值是來源機器的舊路徑、純屬
    描述；目的地一律由呼叫端指定（spec §4.2.2：備份包只能描述來源，不能授權目的地）。

    宣稱的落點刻意放在 tmp_path 內而非真實 /tmp——萬一實作哪天真的採用了 manifest，
    測試本身也不會在真實檔案系統留下東西。"""
    src = _staging(tmp_path)
    claimed = tmp_path / "attacker-controlled"
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["accounts"]["work"] = str(claimed)
    (src / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    tgt = tmp_path / "live"
    tgt.mkdir()

    p = inst.plan(str(src), _accounts(tgt))
    assert p.targets == {"work": str(tgt.resolve())}

    inst.install(p)
    assert not claimed.exists()
    assert (tgt / "CLAUDE.md").read_text(encoding="utf-8") == "RULES"

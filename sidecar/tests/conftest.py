import json
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _default_test_unauth(monkeypatch):
    """預設讓所有測試以 opt-out（無認證）跑——既有測試不必逐一帶 token。
    要測 enforced 的測試自行 monkeypatch.delenv('FLEDGE_TEST_UNAUTH') + setenv('FLEDGE_TOKEN')。"""
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")


def make_staging(base: Path, *, home: str = "/Users/olduser") -> Path:
    """造一份最小的展開目錄（含 manifest），比照 backup-claude.sh 的產出佈局。

    test_install 與 test_restore_routes 共用（出現第二個使用點才抽進來）。"""
    root = base / "staging"
    (root / "accounts" / "work" / "skills").mkdir(parents=True)
    (root / "accounts" / "work" / "skills" / "a.md").write_text("SKILL", encoding="utf-8")
    (root / "accounts" / "work" / "CLAUDE.md").write_text("RULES", encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps({
        "format": 1,
        "created": "20260731-1200",
        "host": "old-mac",
        "home": home,
        "accounts": {"work": f"{home}/.claude"},
        "extra": {},
        "excludes_credentials": True,
    }), encoding="utf-8")
    return root

import pytest


@pytest.fixture(autouse=True)
def _default_test_unauth(monkeypatch):
    """預設讓所有測試以 opt-out（無認證）跑——既有測試不必逐一帶 token。
    要測 enforced 的測試自行 monkeypatch.delenv('FLEDGE_TEST_UNAUTH') + setenv('FLEDGE_TOKEN')。"""
    monkeypatch.setenv("FLEDGE_TEST_UNAUTH", "1")

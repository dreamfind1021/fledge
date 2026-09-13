from fledge_sidecar.app_config import AppConfig


def test_kms_root_roundtrip(tmp_path):
    p = tmp_path / "config.json"
    c = AppConfig.load(p)
    assert c.kms_root == ""                  # 預設空
    c.set_kms_root("~/work/第二大腦")
    c.save()
    assert AppConfig.load(p).kms_root == "~/work/第二大腦"   # raw 保留 ~（與 config_dir 一致）


def test_kms_root_clear(tmp_path):
    p = tmp_path / "config.json"
    c = AppConfig.load(p)
    c.set_kms_root("/x"); c.save()
    c2 = AppConfig.load(p); c2.set_kms_root(""); c2.save()
    assert AppConfig.load(p).kms_root == ""

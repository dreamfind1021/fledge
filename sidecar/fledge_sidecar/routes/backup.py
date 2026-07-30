"""備份狀態路由（唯讀）。

**目錄問題不是錯誤**：一律 200，用旗標表達（目前是 `dir_status`，後續票會再加
containment 與環境前提）。錯誤只留給「請求本身壞掉」——卡片要能說明是哪一種異常，
把它們塞進 HTTP 錯誤碼就只剩「壞了」這一個資訊。
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.backup import bundles as bundles_mod
from fledge_sidecar.backup.containment import check_backup_dir, source_roots
from fledge_sidecar.backup.script import scripts_root
from fledge_sidecar.paths import expand_and_validate, probe_dir

router = APIRouter()


@router.get("/api/backup/status")
def backup_status() -> dict:
    config = AppConfig.load()
    raw = (config.backup_dir or "").strip()
    payload: dict = {
        "configured": bool(raw),
        "backup_dir": raw,
        "dir_status": "missing",
        "containment": "ok",
        "bundles": [],
        "last_backup_ts": None,
        "days_since": None,
    }
    if not raw:
        return payload

    # 正規化與探測共用同一個入口：拿相對路徑去 probe 會以 sidecar 的 cwd 解讀，得到一個
    # 與實際備份寫入位置無關的答案（設定檔被手動編輯時才會走到）。`invalid` 歸在
    # containment 而非 dir_status——後者回答「這個目錄現在怎麼樣」，而相對路徑連目錄都
    # 稱不上，探測它沒有意義。
    try:
        abs_path = expand_and_validate(raw)
    except ValueError:
        payload["containment"] = "invalid"
        return payload

    payload["containment"] = check_backup_dir(abs_path, source_roots(config, scripts_root()))
    payload["dir_status"] = probe_dir(abs_path)
    if payload["dir_status"] != "dir":
        return payload  # 目錄不可用就不端清單——掃目錄的整個重點是狀態要誠實

    found = bundles_mod.list_bundles(abs_path)
    payload["bundles"] = [
        {"name": b.name, "created_ts": b.created_ts, "size_bytes": b.size_bytes} for b in found
    ]
    payload["last_backup_ts"] = found[0].created_ts if found else None
    payload["days_since"] = bundles_mod.days_since(payload["last_backup_ts"], datetime.now())
    return payload

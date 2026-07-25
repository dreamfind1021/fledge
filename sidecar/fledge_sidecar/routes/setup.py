"""Setup 路由：開發環境偵測狀態（spec §5）。

安裝／登入不在此處——走 POST /api/sessions 的 kind=install/login（spec §2 #13）。
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter

from fledge_sidecar.setup.env_detect import detect_all

router = APIRouter()


@router.get("/api/setup/status")
def setup_status():
    # detect_all 以模組層名稱呼叫，測試可 monkeypatch 注入假資料
    return {"tools": [asdict(s) for s in detect_all()]}

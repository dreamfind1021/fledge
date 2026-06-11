"""Session 路由：建立/關閉 + WebSocket 雙向 PTY 串流。spec §8.2-8.4。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.auth import require_ws_token
from fledge_sidecar.pty_bridge import PtyBridge

logger = logging.getLogger(__name__)

router = APIRouter()

# 單一共用 bridge（spec：共用一個 sidecar 管理多 session）
_bridge = PtyBridge()


def close_all_sessions() -> None:
    """關閉共用 _bridge 的所有 session（app lifespan shutdown 呼叫，避免 PTY orphan）。"""
    _bridge.close_all()


class CreateSessionRequest(BaseModel):
    path: str
    account: str


class ResizeRequest(BaseModel):
    rows: int
    cols: int


def _resolve_command() -> list[str]:
    """正常跑 claude；測試模式（FLEDGE_TEST_COMMAND）用替代命令。"""
    test_cmd = os.environ.get("FLEDGE_TEST_COMMAND")
    if test_cmd:
        return test_cmd.split()
    return ["claude"]


def _apply_flow_control(text: str, flow_gate: asyncio.Event) -> None:
    """WS text frame 控制訊息 → 調整 flow_gate（PTY→WS 方向的閘）。

    安全不變式：text frame 永不寫入 PTY（杜絕「終端機輸入/輸出內容偽裝控制指令」注入面）。
    未知 type／非法 JSON／非物件一律 log + 忽略——向前相容，不斷線（design §4）。
    """
    try:
        msg = json.loads(text)
    except json.JSONDecodeError:
        logger.debug("flow control 忽略非法 JSON: %r", text)
        return
    if not isinstance(msg, dict):
        logger.debug("flow control 忽略非物件訊息: %r", text)
        return
    msg_type = msg.get("type")
    if msg_type == "pause":
        flow_gate.clear()  # 停讀 PTY
    elif msg_type == "resume":
        flow_gate.set()  # 恢復讀
    else:
        logger.debug("flow control 忽略未知 type: %r", msg_type)


@router.post("/api/sessions")
def create_session(req: CreateSessionRequest):
    config = AppConfig.load()
    account = config.accounts.get(req.account, {})
    config_dir = account.get("config_dir", "~/.claude")
    env_overrides = {"CLAUDE_CONFIG_DIR": str(Path(config_dir).expanduser())}

    session = _bridge.create_session(
        command=_resolve_command(),
        cwd=req.path,
        env_overrides=env_overrides,
        project_path=req.path,
        account=req.account,
    )
    return {"session_id": session.session_id, "ws_url": f"/ws/{session.session_id}"}


@router.delete("/api/sessions/{session_id}")
def delete_session(session_id: str):
    _bridge.close_session(session_id)
    return {"closed": session_id}


@router.post("/api/sessions/{session_id}/resize")
def resize_session(session_id: str, req: ResizeRequest):
    _bridge.setwinsize(session_id, req.rows, req.cols)
    return {"resized": session_id, "rows": req.rows, "cols": req.cols}


@router.websocket("/ws/{session_id}")
async def session_ws(websocket: WebSocket, session_id: str):
    # accept 前先驗 token（query ?token=）：不過就 close 1008、不進 bridge
    if not require_ws_token(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    if not _bridge.has_session(session_id):
        await websocket.close(code=1008)
        return

    loop = asyncio.get_running_loop()

    # flow control gate：connection-scoped，初始 set()=可讀。clear()=暫停讀 PTY、set()=恢復。
    # 生命週期＝WS 連線：斷線即消滅、重連全新 gate(set)，與模式 A「斷線＝本來就不讀」一致，
    # 天然避免 paused 狀態殘留（design §5）。
    flow_gate = asyncio.Event()
    flow_gate.set()

    async def pump_pty_to_ws():
        # PTY → WS：is_alive False（claude 退出）時自然結束。
        # 迴圈頂部先過 flow_gate：paused 時 wait_for 每 1s timeout → continue → 回到
        # while is_alive 條件，確保 claude 在 paused 中退出也能被察覺收尾、不留 zombie task。
        while _bridge.is_alive(session_id):
            try:
                await asyncio.wait_for(flow_gate.wait(), timeout=1.0)
            except TimeoutError:
                continue
            data = await loop.run_in_executor(None, _bridge.read_nonblocking, session_id)
            if data:
                await websocket.send_bytes(data)

    async def pump_ws_to_pty():
        # WS → PTY：receive() 通用分支。receive() 不像 receive_bytes() 會自動拋
        # WebSocketDisconnect → 手動拋，保留「recv task 結束 → FIRST_COMPLETED → 收尾」競賽語義。
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))
            text = message.get("text")
            if text is not None:
                _apply_flow_control(text, flow_gate)  # text frame＝控制訊息，永不入 PTY
                continue
            data = message.get("bytes")
            if data is not None:
                _bridge.write(session_id, data)

    pump_task = asyncio.create_task(pump_pty_to_ws())
    recv_task = asyncio.create_task(pump_ws_to_pty())

    # 兩 task 競賽：先結束的決定走哪條（pump 完＝PTY EOF；recv 拋＝client 斷）
    await asyncio.wait({pump_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)

    # 收尾兩 task（cancel + 等結束；CancelledError/WebSocketDisconnect 預期、其餘 log）
    for t in (pump_task, recv_task):
        t.cancel()
    for t in (pump_task, recv_task):
        try:
            await t
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except Exception:
            logger.exception("session %s task 結束於非預期例外", session_id)

    # tie-break 以 is_alive 為準（不靠「哪個 task 先回」）：
    # 死了 → 清 session 並送 4001（client 還連著才送得出，已斷則 except 吞、前端下次 reconnect 收 1008）。
    # 仍 alive（client 自己斷）→ 保留 session（模式 A：可重連）。
    if not _bridge.is_alive(session_id):
        _bridge.close_session(session_id)
        try:
            await websocket.close(code=4001)
        except Exception:
            pass

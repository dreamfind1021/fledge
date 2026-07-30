"""Session 路由：建立/關閉 + WebSocket 雙向 PTY 串流。spec §8.2-8.4。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.auth import require_ws_token
from fledge_sidecar.backup import restore
from fledge_sidecar.backup.containment import check_backup_dir, source_roots
from fledge_sidecar.backup.script import (
    build_argv,
    python3_available,
    restore_script_available,
    script_available,
    scripts_root,
)
from fledge_sidecar.paths import expand_and_validate, probe_dir
from fledge_sidecar.pty_bridge import PtyBridge
from fledge_sidecar.setup.install_specs import get_install_command
from fledge_sidecar.usage import account_activity

logger = logging.getLogger(__name__)

router = APIRouter()

# 已 record_open 的 session id（僅 claude session）。terminal session 不歸屬、不在此集合，
# 故 session 關閉時不會誤補 orphan close 事件（活動 log 只記被歸屬的 claude session）。
_opened_session_ids: set[str] = set()


def _on_close(sess) -> None:
    """session 關閉 → 補 close 事件（live span 收尾），但僅限有 record_open 的 claude session。"""
    if sess.session_id in _opened_session_ids:
        _opened_session_ids.discard(sess.session_id)
        account_activity.record_close(sess.session_id, time.time())


# 單一共用 bridge（spec：共用一個 sidecar 管理多 session）；on_close wiring 收尾 live span。
_bridge = PtyBridge(on_close=_on_close)


def live_session_ids() -> set[str]:
    """存活 session id 集合（給 usage route 取活躍歸屬的 live 集合）。"""
    return _bridge.live_ids()


def close_all_sessions() -> None:
    """關閉共用 _bridge 的所有 session（app lifespan shutdown 呼叫，避免 PTY orphan）。"""
    _bridge.close_all()


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")  # 未知欄位（如注入 "command"）→ 422
    path: str
    account: str = ""  # install kind 不需帳號；其餘 kind 會驗證
    kind: Literal["claude", "terminal", "install", "login", "backup", "restore"] = "claude"
    install_id: str | None = None   # kind=install 必填
    login_target: Literal["claude", "codex"] = "claude"  # kind=login 用
    backup_mode: Literal["list", "run"] | None = None    # kind=backup 必填
    restore_bundle: str | None = None   # kind=restore 必填（**備份包名，不是路徑**）
    restore_dest: str | None = None     # kind=restore 選填，未給＝後端算的預設展開位置


class ResizeRequest(BaseModel):
    rows: int
    cols: int


def _login_shell() -> str:
    return os.environ.get("SHELL") or "/bin/zsh"


def _resolve_command(kind: str = "claude", login_target: str = "claude") -> list[str]:
    """claude session 跑 claude（測試模式用 FLEDGE_TEST_COMMAND 替代）；
    terminal session 跑使用者登入 shell（不進 claude），spec §1.2；
    login session 跑 claude（觸發 OAuth）或 codex login。"""
    if kind == "terminal":
        return [_login_shell(), "-l"]
    if kind == "login":
        return ["codex", "login"] if login_target == "codex" else ["claude"]
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


def _backup_blocked(config: AppConfig) -> str | None:
    """spawn 前的閘：回判別碼代表擋下、`None` 代表放行。

    前端本來就 disable 按鈕，這層是防繞過——**route 才是安全邊界，不是 UI**。
    順序即優先序，且與備份卡顯示阻斷原因的順序一致：使用者看到的修復指引，
    就是後端下一個會擋的東西。"""
    raw = (config.backup_dir or "").strip()
    if not raw:
        return "backup_dir_not_set"
    try:
        abs_dir = expand_and_validate(raw)
    except ValueError:
        return "backup_dir_invalid"
    verdict = check_backup_dir(abs_dir, source_roots(config, scripts_root()))
    if verdict != "ok":
        return f"backup_dir_{verdict}"
    if probe_dir(abs_dir) != "dir":
        return "backup_dir_unusable"
    if not script_available():
        return "backup_script_missing"
    if not python3_available():
        return "python3_missing"
    return None


def _restore_blocked(config: AppConfig, bundle: str, dest: str | None) -> str | None:
    """kind=restore 的 spawn 前閘。同 `_backup_blocked`：**route 才是安全邊界，不是 UI**。

    順序即優先序，與還原卡顯示阻斷原因的順序一致：備份目錄（沒有它就沒有備份包可選）→
    環境前提 → 備份包 → 展開位置。`dest_*` 的判別碼與 `check_dest` 的 verdict 同名，
    前端以顯式表映射（動態組 i18n key 會讓沒見過的狀態變成畫面上的 key 原文）。"""
    try:
        backup_dir = restore.resolve_backup_dir(config)
    except ValueError as exc:
        return str(exc)
    if not restore_script_available():
        return "restore_script_missing"
    if not python3_available():
        return "python3_missing"
    try:
        restore.bundle_path(backup_dir, bundle)      # allowlist：名字不在清單內就擋
        dest_abs = restore.resolve_dest(dest, bundle)
    except ValueError as exc:
        return str(exc)
    verdict = restore.check_dest(dest_abs, source_roots(config, scripts_root()))
    return None if verdict == "ok" else f"dest_{verdict}"


def _unattributed_session(command: list[str], project_path: str) -> dict:
    """開一個不綁帳號的 session（安裝、codex 登入）：跑在 home、不注入帳號 env 且主動剔除
    `CLAUDE_CONFIG_DIR`（即便 sidecar 自身環境有），不進活動歸屬。

    這兩種工作都不屬於任何專案也不屬於任何帳號——安裝是系統層、codex 登入是全域的。
    """
    session = _bridge.create_session(
        command=command,
        cwd=str(Path.home()),
        env_overrides={},
        env_remove=["CLAUDE_CONFIG_DIR"],
        project_path=project_path,
    )
    return {"session_id": session.session_id, "ws_url": f"/ws/{session.session_id}"}


@router.post("/api/sessions")
def create_session(req: CreateSessionRequest):
    config = AppConfig.load()

    # --- kind=install：allowlist 命令、最小 env（不帶 CLAUDE_CONFIG_DIR），不歸屬 ---
    if req.kind == "install":
        cmd = get_install_command(req.install_id)
        if cmd is None:
            return JSONResponse(status_code=400, content={"error": "unknown_install_id"})
        return _unattributed_session([_login_shell(), "-lc", cmd], req.path)

    # --- kind=backup：與 install 同一類（系統層工作，不屬於任何帳號也不屬於任何專案）---
    if req.kind == "backup":
        if req.backup_mode is None:
            return JSONResponse(status_code=400, content={"error": "backup_mode_required"})
        blocked = _backup_blocked(config)
        if blocked is not None:
            return JSONResponse(status_code=400, content={"error": blocked})
        # argv 全部由後端從 config 與 backup_script_path() 組出來——前端只送 kind 與
        # backup_mode，永不送命令字串也不送路徑（沿用 kind=install 的 allowlist 不變式）。
        abs_dir = expand_and_validate(config.backup_dir.strip())
        return _unattributed_session(build_argv(abs_dir, req.backup_mode), req.path)

    # --- kind=restore：同 backup 的系統層工作。**展開的是備份包、寫的是獨立的新位置，
    #     這條路沒有任何寫入現役目錄的能力**（票 09 驗收 #6）。修復共通設置斷鏈是另一條
    #     路（POST /api/setup/common-config/repair），要使用者明確按下去。---
    if req.kind == "restore":
        if not (req.restore_bundle or "").strip():
            return JSONResponse(status_code=400, content={"error": "restore_bundle_required"})
        blocked = _restore_blocked(config, req.restore_bundle, req.restore_dest)
        if blocked is not None:
            return JSONResponse(status_code=400, content={"error": blocked})
        # argv 由後端組：前端只送**備份包名**與展開位置，備份包名還要過 list_bundles 的
        # allowlist 才變成路徑（沿用 kind=install 只送 install_id 的不變式）。
        backup_dir = restore.resolve_backup_dir(config)
        argv = restore.build_restore_argv(
            restore.bundle_path(backup_dir, req.restore_bundle),
            restore.resolve_dest(req.restore_dest, req.restore_bundle),
        )
        return _unattributed_session(argv, req.path)

    # --- codex 登入是全域的（不分帳號，B-1 收尾票已確認）→ 與 install 同樣不綁帳號 ---
    if req.kind == "login" and req.login_target == "codex":
        return _unattributed_session(_resolve_command(req.kind, req.login_target), req.path)

    # --- 其餘 kind 需要合法帳號 ---
    if req.account not in config.accounts:        # 驗證帳號合法（不 spawn 偽造/拼錯 key）
        return JSONResponse(status_code=400, content={"error": "unknown_account"})
    account = config.accounts[req.account]
    config_dir = account.get("config_dir", "~/.claude")
    env_overrides = {"CLAUDE_CONFIG_DIR": str(Path(config_dir).expanduser())}

    session_id = uuid.uuid4().hex
    if req.kind == "claude":                       # spawn 前記 open（消除 claude 先吐 usage 的競態）
        account_activity.record_open(req.path, req.account, session_id, time.time())
        _opened_session_ids.add(session_id)        # 標記為被歸屬，on_close 才會補 close
    try:
        session = _bridge.create_session(
            command=_resolve_command(req.kind, req.login_target),
            # 登入不屬於任何專案（它也不進活動歸屬），跑在 home——與 kind=install 一致。
            # 精靈的登入頁沒有專案路徑可傳，沿用 req.path 只會逼前端編一個假路徑。
            cwd=str(Path.home()) if req.kind == "login" else req.path,
            env_overrides=env_overrides,
            project_path=req.path,
            account=req.account,
            session_id=session_id,
        )
    except Exception:                              # spawn 失敗 → 補 close（不留 phantom live span）
        if req.kind == "claude":
            _opened_session_ids.discard(session_id)
            account_activity.record_close(session_id, time.time())
        raise
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

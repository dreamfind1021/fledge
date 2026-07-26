"""PTY 橋接：起子進程、雙向轉發 raw bytes。spec §4.2 §6.2。

不解析 ANSI、不解析 Claude TUI 結構，原樣轉送（spec §2.3）。
"""
from __future__ import annotations

import logging
import os
import select
import threading
import uuid
from dataclasses import dataclass, field
from typing import Callable

from ptyprocess import PtyProcess

logger = logging.getLogger(__name__)


@dataclass
class Session:
    session_id: str
    pty: PtyProcess
    project_path: str = ""
    account: str = ""


@dataclass
class PtyBridge:
    sessions: dict[str, Session] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    on_close: "Callable[[Session], None] | None" = None

    def create_session(
        self,
        command: list[str],
        cwd: str,
        env_overrides: dict[str, str],
        project_path: str = "",
        account: str = "",
        session_id: str | None = None,
        env_remove: list[str] | None = None,
    ) -> Session:
        # claude 等 TUI 用 supports-color 偵測顏色：pty 的 isatty 為真，但 TERM/COLORTERM
        # 皆未設時仍判定為無色（GUI 啟動的 sidecar 不繼承 terminal 的 TERM，整個終端機會變全黑白）。
        # LANG 同理：GUI 啟動的 sidecar 無 locale，claude（直接 exec、非 login shell）在缺 UTF-8
        # locale 下多行/bracketed paste 會壞（一閃就消）；terminal session 走 $SHELL -l 會自設 locale
        # 故不受影響。先鋪 UTF-8 預設；放在 os.environ 之前，dev 從 terminal 起時的真實值仍能覆蓋。
        env = {
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "LANG": "en_US.UTF-8",
            **os.environ,
            **env_overrides,
        }
        # 從最終合併 env 剔除 sidecar 自己的 auth secret 與內部協定變數，不灌進子進程
        # （claude 與使用者 terminal shell 都不該看到）。
        for _k in ("FLEDGE_TOKEN", "FLEDGE_TEST_UNAUTH", "FLEDGE_PORT"):
            env.pop(_k, None)
        # 呼叫端要求額外移除的 key（安裝 session 移除 CLAUDE_CONFIG_DIR，spec §6.2）
        for _k in (env_remove or ()):
            env.pop(_k, None)
        pty = PtyProcess.spawn(command, cwd=cwd, env=env)
        session_id = session_id or uuid.uuid4().hex
        session = Session(
            session_id=session_id,
            pty=pty,
            project_path=project_path,
            account=account,
        )
        with self._lock:
            self.sessions[session_id] = session
        return session

    def _get(self, session_id: str) -> Session | None:
        with self._lock:
            return self.sessions.get(session_id)

    def has_session(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self.sessions

    def live_ids(self) -> set[str]:
        with self._lock:
            return set(self.sessions)

    def write(self, session_id: str, data: bytes) -> None:
        session = self._get(session_id)
        if session is None:
            return
        try:
            session.pty.write(data)
        except (OSError, EOFError):
            pass

    def read_nonblocking(
        self, session_id: str, size: int = 65536, poll_timeout: float = 0.2
    ) -> bytes:
        """讀取現有輸出：先用 select 等最多 poll_timeout 秒。

        回 b"" 可能是「暫無資料」或「已結束」——呼叫端須另以 is_alive() 區分。
        select 的時間上限讓跑在 executor thread 的此呼叫能定期返回被回收，
        避免 blocking read 卡死 thread（Py3.14 asyncio executor 關閉時 join 等待）。
        """
        session = self._get(session_id)
        if session is None:
            return b""
        try:
            rlist, _, _ = select.select([session.pty.fd], [], [], poll_timeout)
            if not rlist:
                return b""
            return session.pty.read(size)
        except (EOFError, OSError):
            return b""

    def setwinsize(self, session_id: str, rows: int, cols: int) -> None:
        session = self._get(session_id)
        if session is None:
            return
        try:
            session.pty.setwinsize(rows, cols)
        except (OSError, ValueError):
            pass

    def is_alive(self, session_id: str) -> bool:
        session = self._get(session_id)
        if session is None:
            return False
        try:
            return session.pty.isalive()
        except (OSError, ValueError):
            return False

    def close_session(self, session_id: str) -> None:
        with self._lock:
            session = self.sessions.pop(session_id, None)
        if session is not None:
            if self.on_close is not None:
                try:
                    self.on_close(session)
                except Exception as e:  # callback 不得阻斷關閉
                    logger.debug("on_close callback failed for %s: %s", session_id, e)
            try:
                # close() 關閉 PTY master fd 並終止子進程；只用 terminate() 不關 fd，
                # 會每 session 洩漏一個 fd 直到 EMFILE（Codex 對抗式審查 HIGH）。
                session.pty.close(force=True)
            except Exception as e:
                # 清理階段 best-effort：進程可能已自行結束，記錄但不中斷關閉流程
                logger.debug("close session %s failed: %s", session_id, e)
                self._restore_if_alive(session_id, session)

    def _restore_if_alive(self, session_id: str, session: Session) -> None:
        """close 失敗後決定 handle 去留（Codex 票 24 R2 Medium）。

        close_session 是先 pop 再 close，失敗就丟掉 handle 的話，仍在跑的子進程會就此失聯——
        重複 DELETE、close_all() 都再也找不到它。但 close 失敗最常見的原因正是「進程已自行
        結束」，那種情況把 handle 放回去只會讓 live_ids() 多報一個活 session，所以要分開判斷。
        問不出存活狀態時一律當已死：留一個狀態不明的 handle 只會讓 registry 失真。
        """
        try:
            alive = session.pty.isalive()
        except Exception as e:
            logger.debug("liveness probe failed for %s: %s", session_id, e)
            return
        if not alive:
            return
        with self._lock:
            self.sessions.setdefault(session_id, session)

    def close_all(self) -> None:
        """關閉所有 session：lock 內 snapshot + 清空，再逐一 best-effort close。
        app shutdown 時呼叫，避免 PTY 子進程（claude）orphan。
        單一 session close 失敗不阻斷其餘。"""
        with self._lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for session in sessions:
            if self.on_close is not None:
                try:
                    self.on_close(session)
                except Exception as e:
                    logger.debug("on_close callback failed for %s: %s", session.session_id, e)
            try:
                session.pty.close(force=True)
            except Exception as e:
                logger.debug("close_all: session %s failed: %s", session.session_id, e)

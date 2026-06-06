"""Sidecar entrypoint.

綁定 127.0.0.1:0 拿一個 OS 分配的空 port，關閉後交給 uvicorn 重新綁定，
並在 stdout 印出 `FLEDGE_PORT=<port>` 供 Tauri 端解析。
localhost 個人機環境下，close→rebind 的 race 窗口可忽略。
"""
import socket
import sys

import uvicorn

from fledge_sidecar.app import create_app


def _pick_free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main() -> None:
    port = _pick_free_port()
    # 立刻 flush，讓 Tauri 端能即時讀到
    print(f"FLEDGE_PORT={port}", flush=True)
    uvicorn.run(
        create_app(),
        host="127.0.0.1",
        port=port,
        log_level="warning",
        timeout_graceful_shutdown=2,
    )


if __name__ == "__main__":
    sys.exit(main())

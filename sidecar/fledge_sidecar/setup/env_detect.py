"""開發工具偵測（純函式）：shutil.which + 版本探測。

which/run 以參數注入，便於測試（不真的呼叫系統）。內容層不拋例外：
版本探測失敗（OSError/SubprocessError/timeout）→ version=None，不中斷。
"""
from __future__ import annotations

import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from fledge_sidecar.setup.install_specs import TOOL_SPECS, ToolSpec

# 版本探測上限（秒）。status route 會對所有已安裝工具探版本；用短 timeout + 平行化，
# 把最壞延遲壓在 ~_VERSION_TIMEOUT（而非 N×timeout），避免 onboarding「重新檢查」卡頓（plan review #2）。
_VERSION_TIMEOUT = 2
_MAX_PROBE_WORKERS = 8


@dataclass(frozen=True)
class ToolStatus:
    id: str
    label: str
    tier: str
    installed: bool
    path: str | None
    version: str | None


def _probe_version(argv: list[str], run) -> str | None:
    try:
        proc = run(argv, capture_output=True, text=True, timeout=_VERSION_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None
    out = (proc.stdout or proc.stderr or "").strip()
    return out.splitlines()[0] if out else None


def detect_tool(spec: ToolSpec, which=shutil.which, run=subprocess.run) -> ToolStatus:
    """偵測單一工具：which 命中才探版本；未裝跳過探測（省時）。"""
    path = which(spec.binary)
    if path is None:
        return ToolStatus(spec.id, spec.label, spec.tier, False, None, None)
    version = _probe_version(spec.version_argv, run)
    return ToolStatus(spec.id, spec.label, spec.tier, True, path, version)


def detect_all(specs=TOOL_SPECS, which=shutil.which, run=subprocess.run) -> list[ToolStatus]:
    """平行偵測全表工具，保序回傳（UI 分組依賴順序穩定）。"""
    # 平行探測：version probe 是 I/O bound，逐一跑最壞達 N×timeout（UI 會卡）。
    # ThreadPoolExecutor.map 保留輸入順序（UI 分組依賴順序穩定）。
    with ThreadPoolExecutor(max_workers=_MAX_PROBE_WORKERS) as ex:
        return list(ex.map(lambda s: detect_tool(s, which=which, run=run), specs))

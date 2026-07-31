"""移機：把展開目錄（staging）的資產寫進新機的現役目錄。

**本模組是唯一有能力寫現役目錄的還原路徑。** `backup/restore.py` 維持零寫入能力
（那是票 09 的結構性不變式），本模組是它的下一步而非同義詞——術語見 CONTEXT.md 的
migration／restore 分界。

安全權威留在模組內：不接受 caller 宣稱已驗證的落點，所有 config_dir 一律自己
expand→absolute→resolve 後才使用（比照 common_config）。備份包的內容**一律是不可信
輸入**——manifest 只能描述來源，不能授權目的地（spec §4.2.2）。
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fledge_sidecar.paths import (
    dir_identity,
    expand_and_validate,
    is_same_or_within,
    resolve_best_effort,
)

logger = logging.getLogger(__name__)

Outcome = Literal["installed", "skipped", "excluded", "failed"]

# 明確不處理的頂層項目。`.claude.json` 同一個檔案裡混著真資產（projects 的權限清單、
# mcpServers）、機器身分（oauthAccount、machineID）與純快取（cachedGrowthBookFeatures
# 442 項）——整份搬會蓋掉新機剛登入好的狀態，整份不搬只是要重新累積，後者代價小得多。
EXCLUDED_NAMES: frozenset[str] = frozenset({".claude.json"})

MANIFEST_NAME = "manifest.json"


@dataclass(frozen=True)
class ItemResult:
    account: str        # target account key，extra 項用 "" 表示不屬於任何帳號
    rel_path: str       # 相對該落點的路徑
    outcome: Outcome
    error: str | None = None      # 穩定判別碼；完整例外只進 log


@dataclass(frozen=True)
class InstallPlan:
    source_root: str                        # 展開目錄（resolved）
    source_identity: tuple[int, int] | None  # 建 plan 當下的身分，install 前重驗
    targets: dict[str, str]                 # account key -> resolved config_dir
    extra_targets: dict[str, str]           # extra 項名 -> resolved 落點
    will_install: int
    will_skip: list[str]
    excluded: list[str]


def _resolved_config_dir(raw: str) -> str:
    """落點正規化 + 底線防呆。失敗一律 ValueError(<判別碼>)，由 route 轉 400。"""
    try:
        resolved = resolve_best_effort(expand_and_validate((raw or "").strip()))
    except ValueError as exc:
        raise ValueError("invalid_config_dir") from exc
    # ADR-0001：resolved 是 home 本身或其祖先（含 /）時 containment root 大到形同不設防
    if is_same_or_within(str(Path.home().resolve()), resolved):
        raise ValueError("unsafe_config_dir")
    return resolved


def read_manifest(source_root: str) -> dict:
    """讀展開目錄的 manifest。讀不到或不是物件 → source_not_a_bundle。

    **來源的解讀權留在模組內**：不讓 caller 傳進 manifest 內容，否則「不可信輸入」的
    邊界就跑到模組外面了。"""
    try:
        data = json.loads(Path(source_root, MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("source_not_a_bundle") from exc
    if not isinstance(data, dict):
        raise ValueError("source_not_a_bundle")
    return data


def _walk_account(account_dir: Path) -> tuple[list[str], list[str]]:
    """回 (可安裝的相對路徑, 被排除的名字)。純掃描，不寫任何東西。

    **不跟隨 symlink**：`os.walk` 的 followlinks 預設就是 False，但這裡顯式寫出來——
    備份包裡一個指向 `/` 的目錄連結就能讓遞迴走出展開目錄。"""
    installable: list[str] = []
    excluded: list[str] = []
    for dirpath, dirnames, filenames in os.walk(account_dir, followlinks=False):
        rel_dir = os.path.relpath(dirpath, account_dir)
        for name in list(dirnames) + filenames:
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            top = rel.split(os.sep, 1)[0]
            if top in EXCLUDED_NAMES:
                if rel == top:
                    excluded.append(rel)
                continue
            if name in filenames:
                installable.append(rel)
    return installable, excluded


def plan(source_root: str, accounts: dict[str, dict[str, str]]) -> InstallPlan:
    """掃描展開目錄與各落點，回「會裝什麼、會跳過什麼、不處理什麼」。純唯讀。"""
    root = resolve_best_effort(source_root)
    manifest = read_manifest(root)          # 順便驗它確實是我們展開的目錄

    targets: dict[str, str] = {}
    for key in manifest.get("accounts", {}):
        entry = accounts.get(key)
        if entry is None:
            continue                        # 使用者沒為這個帳號指定落點 → 不裝
        targets[key] = _resolved_config_dir(entry.get("config_dir", ""))

    will_install = 0
    will_skip: list[str] = []
    excluded: list[str] = []
    for key, target in targets.items():
        account_dir = Path(root, "accounts", key)
        if not account_dir.is_dir():
            continue
        installable, ex = _walk_account(account_dir)
        excluded.extend(ex)
        for rel in installable:
            if os.path.lexists(os.path.join(target, rel)):
                will_skip.append(rel)
            else:
                will_install += 1

    return InstallPlan(
        source_root=root,
        source_identity=dir_identity(root),
        targets=targets,
        extra_targets={},                   # 票 05（extra 資產）填
        will_install=will_install,
        will_skip=will_skip,
        excluded=excluded,
    )

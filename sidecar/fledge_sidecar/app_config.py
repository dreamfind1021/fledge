"""讀寫 ~/.fledge/config.json。設定即真相源（spec §設計原則 3）。"""
from __future__ import annotations

import copy
import json
import logging
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from fledge_sidecar.paths import resolve_best_effort

logger = logging.getLogger(__name__)

# 預設**單一帳號**（票 31）：多帳號是進階用法，不預設塞給每個人——預先塞第二個帳號會讓
# 精靈白跑一頁共通設置、共通設置卡顯示「不適用」、觀測面板多一個永遠沒資料的帳號，使用者
# 還得自己去設定頁刪掉。第二個帳號由使用者在設定頁的 AccountsEditor 自行新增。
# `config_dir` 用 Claude Code 的官方預設位置；`label` 留空是刻意的——UI 缺 label 時退回
# 顯示 key（`sidebarGroups`），後端因此不必輸出任何 user-facing 文案（CLAUDE.md §4.6.13）。
# 影響範圍：`load()` 在設定檔不存在時整份取用本表，**有 `accounts` 欄位的既有 config.json
# 完全不受影響**。唯一的例外是設定檔存在卻缺 `accounts` 欄位——下面的 `data.get(...)` 會讓它
# 也拿到這裡的預設（改預設前拿到的是舊的 work/personal）。那種檔案 Fledge 自己寫不出來
# （`to_dict()` 固定輸出 accounts），只可能來自手動編輯，本就是損壞狀態；給它舊的 work/personal
# 同樣只是另一種猜測，故不為它保留 legacy fallback（票 31，Codex R1 Medium 覆核後的裁示）。
DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "roots": [],
    "accounts": {
        "default": {"config_dir": "~/.claude", "label": ""},
    },
    "manual_projects": [],
    "project_overrides": {},
    "ui": {"theme": "dark"},
    "subscriptions": [],
}


def normalize_subscription(item: Any) -> dict[str, Any]:
    """一筆訂閱的合法形狀：`{"name": 非空字串, "monthly_cost": 有限非負數}`。額外欄位丟掉。

    不合格一律 `ValueError(<判別碼>)`，**三種分開**——`bad_shape`（不是物件）／`bad_cost`
    （`monthly_cost` 轉不出數字）／`bad_values`（name 空、cost 負或非有限）。分開的理由是
    呼叫端的處置不同：`PUT /api/config/subscriptions` 要據此回它原本那兩句 400 文案，
    移機的 `adopt-config` 則一律丟棄該項繼續。

    **兩端共用一份判準**（票 09）：PUT 端原本靠 `SubscriptionsBody.subscriptions: list[dict]`
    的 Pydantic 註記擋掉非物件，函式本體的 `item.get(...)` 對 `null`／字串／數字／陣列會
    `AttributeError` → 裸 500。備份包是不可信輸入、沒有那層保護，所以「必須是物件」這一條
    也要在這裡，不能留在型別註記裡。

    **寬鬆處刻意保留**：可轉的數字字串（`"12.5"`）、bool、數字型 name 都照收——`float()`
    與 `str()` 本來就吃得下，收緊就是改了 PUT 端的對外行為。判準搬家不是改判準。"""
    if not isinstance(item, dict):
        raise ValueError("bad_shape")
    name = str(item.get("name") or "").strip()
    try:
        cost = float(item.get("monthly_cost"))
    except (TypeError, ValueError, OverflowError) as exc:
        # `OverflowError`：309 位以上的整數（JSON 產得出來）讓 `float()` 爆，而它**不是**
        # ValueError 的子類——原本會裸穿成 500（Codex 票 09 R1 F1，實測）。
        raise ValueError("bad_cost") from exc
    if not name or cost < 0 or not math.isfinite(cost):
        raise ValueError("bad_values")
    return {"name": name, "monthly_cost": cost}


def default_config_path() -> Path:
    override = os.environ.get("FLEDGE_CONFIG_PATH")
    if override:
        return Path(override)
    return Path.home() / ".fledge" / "config.json"


class ConfigAlreadyExists(FileExistsError):
    """設定檔已存在，而且**不是同一次請求**建的（票 15）。

    帶著既有 config 的 `created_by`，呼叫端才說得出「這份設定檔是誰建的」——409 原本
    只證明「有一份 config」，前端因此分不出三種處境（這次 POST 其實成功了只是回應遺失／
    使用者在重跑引導／另一個來源放了一份無關的 config）。

    **刻意繼承 `FileExistsError`**：`onboard` 那一側的 `except FileExistsError` 一個字
    都不必改（共用原語，spec §4.3.1）。"""

    def __init__(self, path: str, created_by: dict[str, Any]):
        super().__init__(path)
        self.created_by = created_by


def create_if_absent(build: Callable[[AppConfig], None],
                     path: Path | None = None,
                     *,
                     matches: Callable[[AppConfig], bool] | None = None) -> AppConfig:
    """建立設定檔，**只在它還不存在時**。已存在 → FileExistsError（票 07，spec §4.3.1）。

    `onboard` 與 `adopt-config` 都會建立同一個 config.json，兩份 first-run 檢查必然
    漂移，而漂移的樣態是「一支擋住、另一支放行」，結果是後寫者整份覆蓋前者——所以
    共用這一個原語，各端點只提供「填什麼」。呼叫端自行持 `_config_lock`。

    跨 process 的 race 不在此防護內（沿用 routes/config.py 的既有限制，歸 Plan 04）：
    兩個 app 實例並存時 sidecar 會先互殺，單實例假設早於此失效。

    `matches`（票 15）：檔案已存在時拿既有 config 問「這是不是同一次請求建的」。是就
    **回既有結果**（冪等——回應遺失後重送要拿回第一次的結果，不是用新 body 重跑一次），
    否則 `ConfigAlreadyExists` 並附上它的 `created_by`。**不傳＝行為與票 15 之前完全
    相同**，`onboard` 那一側因此一個字都不必改。"""
    target = path or default_config_path()
    if target.exists():
        existing = _load_for_conflict(target)
        if matches is not None and existing is not None and matches(existing):
            return existing
        raise ConfigAlreadyExists(
            str(target), existing.created_by if existing is not None else {})
    config = AppConfig.load(target)
    build(config)
    config.save()
    return config


def _load_for_conflict(target: Path) -> AppConfig | None:
    """衝突判定用的既有 config。**讀不出來回 None 而不是拋**：那份檔案可能被手編壞了，
    而「它壞掉」不該讓建立流程改回報一個 JSON 解析錯誤——呼叫端要的答案仍然是「已經有
    一份 config 了」，只是說不出它是誰建的。"""
    try:
        return AppConfig.load(target)
    except (OSError, ValueError):
        logger.warning("既有設定檔讀不出來，衝突回報不含來源：%s", target, exc_info=True)
        return None


def usable_entry(item: Any, *fields: str) -> bool:
    """config 內的 root／manual 元素是否可安全消費：本身是 dict，且指定欄位皆為非空字串。

    型別也要驗、不只有無：truthy 的非字串（如 `{"path": {"a": 1}}`）會讓 `Path()` 拋 TypeError。
    這裡是 `load()` 與 `project_scanner` 共用的單一判準——兩邊各寫一份必然長歪（Codex PR-gate
    抓到過 load 只驗 path、scanner 驗 path+account 的不對稱，導致畸形項目佔用去重鍵）。"""
    return isinstance(item, dict) and all(
        isinstance(item.get(f), str) and item[f] for f in fields
    )


def _migrate_path(raw: str) -> str:
    """load 時把既有 entry path 正規化成 canonical（與 scanner resolved 對齊）。
    非絕對路徑保留原值（不丟 resolve、避免 cwd-relative 誤解析）；任何例外 fallback 原值。"""
    try:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            return raw
        return resolve_best_effort(str(p))
    except Exception:
        return raw


@dataclass
class AppConfig:
    path: Path
    version: int = 1
    roots: list[dict[str, str]] = field(default_factory=list)
    accounts: dict[str, dict[str, str]] = field(default_factory=dict)
    manual_projects: list[dict[str, str]] = field(default_factory=list)
    project_overrides: dict[str, dict[str, str]] = field(default_factory=dict)
    ui: dict[str, Any] = field(default_factory=dict)
    subscriptions: list[dict[str, Any]] = field(default_factory=list)
    kms_root: str = ""  # KMS 根目錄，raw 含 ~，runtime 才 expanduser
    backup_dir: str = ""  # 備份輸出目錄，raw 含 ~，runtime 才 expanduser
    # 移機 extra（帳號外資產）的使用者確認落點 {name: raw path}（票 07，spec §4.2.2）：
    # adopt-config 逐項確認後寫入，install 端點從這裡讀——manifest 只能建議不能授權。
    extra: dict[str, str] = field(default_factory=dict)
    # 這份設定檔是誰建的（票 15）：`{"source": "onboard"|"adopt-config", ...}`。
    # **純記帳、不參與任何授權決策**——它只讓「已經有一份 config」這件事說得出來源，
    # 落點的授權仍然只認使用者在 targets 頁確認的那一份（spec §4.2.2）。
    created_by: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | None = None) -> AppConfig:
        path = path or default_config_path()
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        else:
            data = copy.deepcopy(DEFAULT_CONFIG)  # 防止 add_root 等方法污染模組級 DEFAULT_CONFIG
        return cls._from_data(path, data)

    @classmethod
    def load_existing(cls, path: Path | None = None) -> AppConfig:
        """嚴格版 load：單次讀取、**永不退回 DEFAULT_CONFIG**（檔案級與 accounts 欄位級都是）。

        破壞性端點（移機 install）專用——「落點來自使用者確認過的 config.json」的前提在
        任何 fallback 下都不成立：檔案不存在退整份 DEFAULT、檔案在但缺 accounts 欄位退
        DEFAULT 帳號，兩層拿到的都是 default=~/.claude。另外 exists→load 兩段式檢查有
        TOCTOU（等鎖期間檔案被刪即落入 fallback），這裡改成單次 read_text——不存在就在
        read 這一步拋 FileNotFoundError，由呼叫端轉 config_not_initialized。"""
        path = path or default_config_path()
        data = json.loads(path.read_text(encoding="utf-8"))   # 壞 JSON → ValueError
        if not isinstance(data, dict) or not isinstance(data.get("accounts"), dict):
            raise ValueError("config has no usable accounts mapping")
        return cls._from_data(path, data)

    @classmethod
    def _from_data(cls, path: Path, data: dict[str, Any]) -> AppConfig:
        # 自我遷移：把既有 roots/manual/override key canonicalize 成與 scanner 一致的
        # resolved path，並依 canonical 去重（symlink 別名會撞同一路徑）。下次 save 持久化。
        # 逐項容錯：設定檔可能被手動編輯或損壞，元素若不是 dict 或欄位型別不對，
        # 直接 .get()／{**r} 會 AttributeError／TypeError——**一筆**壞資料就讓整個
        # GET /api/config 回 500，連同一份檔案裡合法的項目一起失效。
        #
        # 但畸形元素**原樣保留、不丟棄**：所有寫入端點都是 load() → 改一個欄位 → save()，
        # 而 save() 以 to_dict() 整份覆蓋。丟掉的話，使用者只是改個 label 就會讓那些資料
        # 永久消失且無備份——不可逆的資料遺失比讀取失敗更嚴重。它們只是不參與
        # canonicalize 與去重（否則會佔用去重鍵、把同路徑的**合法**項目擠掉），
        # 消費端（project_scanner）自己會跳過。
        migrated_roots: list[dict[str, Any]] = []
        seen_roots: set[str] = set()
        for r in data.get("roots", []):
            if not usable_entry(r, "path", "default_account"):
                logger.warning("保留但不使用畸形的 root：%r", r)
                migrated_roots.append(r)
                continue
            cp = _migrate_path(r["path"])
            if cp in seen_roots:
                continue
            seen_roots.add(cp)
            migrated_roots.append({**r, "path": cp})

        migrated_manual: list[dict[str, Any]] = []
        seen_manual: set[str] = set()
        for m in data.get("manual_projects", []):
            if not usable_entry(m, "path", "account"):
                logger.warning("保留但不使用畸形的 manual project：%r", m)
                migrated_manual.append(m)
                continue
            cp = _migrate_path(m["path"])
            if cp in seen_manual:
                continue
            seen_manual.add(cp)
            migrated_manual.append({**m, "path": cp})

        migrated_overrides: dict[str, Any] = {}
        for k, v in data.get("project_overrides", {}).items():
            if not isinstance(k, str) or not isinstance(v, dict):
                logger.warning("保留但不使用畸形的 project_override：%r → %r", k, v)
                if isinstance(k, str):
                    migrated_overrides[k] = v  # 原樣保留（key 非字串則無法當 dict key 用）
                continue
            migrated_overrides[_migrate_path(k)] = v  # 兩舊 key 撞同一新 key → 後者覆蓋

        return cls(
            path=path,
            version=data.get("version", 1),
            roots=migrated_roots,
            accounts=data.get("accounts", DEFAULT_CONFIG["accounts"]),
            manual_projects=migrated_manual,
            project_overrides=migrated_overrides,
            ui=data.get("ui", DEFAULT_CONFIG["ui"]),
            subscriptions=data.get("subscriptions", []),
            kms_root=data.get("kms_root", "") or "",
            created_by=(data.get("created_by")
                        if isinstance(data.get("created_by"), dict) else {}),
            backup_dir=data.get("backup_dir", "") or "",
            # 非 dict（手編壞形狀）退空：畸形的 extra 進到 install 端點會變 500
            extra=data["extra"] if isinstance(data.get("extra"), dict) else {},
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "roots": self.roots,
            "accounts": self.accounts,
            "manual_projects": self.manual_projects,
            "project_overrides": self.project_overrides,
            "ui": self.ui,
            "subscriptions": self.subscriptions,
            "kms_root": self.kms_root,
            "backup_dir": self.backup_dir,
            "extra": self.extra,
            "created_by": self.created_by,
        }

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, self.path)  # 原子替換，避免 crash 中途留下半寫壞檔

    def set_created_by(self, info: dict[str, Any]) -> None:
        """記下這份設定檔是誰建的（票 15）。只在建立當下寫一次——後續的細粒度
        寫入端點不碰它，那些改的是內容不是「誰建的」。"""
        self.created_by = dict(info)

    def add_root(self, path: str, default_account: str) -> None:
        self.roots.append({"path": path, "default_account": default_account})

    def remove_root(self, path: str) -> None:
        self.roots = [r for r in self.roots if r["path"] != path]

    def set_root_account(self, path: str, default_account: str) -> None:
        for r in self.roots:
            if r["path"] == path:
                r["default_account"] = default_account

    def add_manual(self, path: str, account: str) -> None:
        self.manual_projects.append({"path": path, "account": account})

    def remove_manual(self, path: str) -> None:
        self.manual_projects = [m for m in self.manual_projects if m["path"] != path]

    def set_override(self, path: str, account: str) -> None:
        self.project_overrides[path] = {"account": account}

    def clear_override(self, path: str) -> None:
        self.project_overrides.pop(path, None)

    def add_account(self, key: str, config_dir: str, label: str) -> None:
        # config_dir 存 raw（含 ~，只 trim 在路由層做）；runtime（sessions/scan）才 expanduser
        self.accounts[key] = {"config_dir": config_dir, "label": label}

    def set_account_config_dir(self, key: str, config_dir: str) -> None:
        if key in self.accounts:
            self.accounts[key]["config_dir"] = config_dir

    def set_account_label(self, key: str, label: str) -> None:
        if key in self.accounts:
            self.accounts[key]["label"] = label

    def account_references(self, key: str) -> dict[str, list[str]]:
        """找出哪些 roots/manual/overrides 引用此帳號（給刪除前的級聯判斷）。"""
        return {
            "roots": [r["path"] for r in self.roots if r["default_account"] == key],
            "manual": [m["path"] for m in self.manual_projects if m["account"] == key],
            "overrides": [p for p, o in self.project_overrides.items() if o["account"] == key],
        }

    def remove_account(self, key: str, reassign_to: str | None = None) -> None:
        """刪帳號；若給 reassign_to，先把所有引用級聯改成 reassign_to（避免 dangling）。"""
        if reassign_to:
            for r in self.roots:
                if r["default_account"] == key:
                    r["default_account"] = reassign_to
            for m in self.manual_projects:
                if m["account"] == key:
                    m["account"] = reassign_to
            for o in self.project_overrides.values():
                if o["account"] == key:
                    o["account"] = reassign_to
        self.accounts.pop(key, None)

    def set_kms_root(self, path: str) -> None:
        """存 raw（含 ~，trim 在路由層 expanduser）；空字串＝未設。"""
        self.kms_root = (path or "").strip()

    def set_backup_dir(self, path: str) -> None:
        """存 raw（含 ~，runtime 才 expanduser）；空字串＝未設。

        合法性（絕對路徑、之後還會加上不得落在備份來源內）一律由路由層驗——這裡只負責存。
        把驗證放進載入路徑的話，一個事後才變得不合法的值會讓整個 app 開不起來。"""
        self.backup_dir = (path or "").strip()

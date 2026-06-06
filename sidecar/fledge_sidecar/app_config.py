"""讀寫 ~/.fledge/config.json。設定即真相源（spec §設計原則 3）。"""
from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fledge_sidecar.paths import resolve_best_effort

DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "roots": [],
    "accounts": {
        "work": {"config_dir": "~/.claude", "label": "工作"},
        "personal": {"config_dir": "~/.claude-tc", "label": "私人"},
    },
    "manual_projects": [],
    "project_overrides": {},
    "ui": {"theme": "dark"},
}


def default_config_path() -> Path:
    override = os.environ.get("FLEDGE_CONFIG_PATH")
    if override:
        return Path(override)
    return Path.home() / ".fledge" / "config.json"


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

    @classmethod
    def load(cls, path: Path | None = None) -> AppConfig:
        path = path or default_config_path()
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        else:
            data = copy.deepcopy(DEFAULT_CONFIG)  # 防止 add_root 等方法污染模組級 DEFAULT_CONFIG

        # 自我遷移：把既有 roots/manual/override key canonicalize 成與 scanner 一致的
        # resolved path，並依 canonical 去重（symlink 別名會撞同一路徑）。下次 save 持久化。
        migrated_roots: list[dict[str, str]] = []
        seen_roots: set[str] = set()
        for r in data.get("roots", []):
            cp = _migrate_path(r.get("path", ""))
            if cp in seen_roots:
                continue
            seen_roots.add(cp)
            migrated_roots.append({**r, "path": cp})

        migrated_manual: list[dict[str, str]] = []
        seen_manual: set[str] = set()
        for m in data.get("manual_projects", []):
            cp = _migrate_path(m.get("path", ""))
            if cp in seen_manual:
                continue
            seen_manual.add(cp)
            migrated_manual.append({**m, "path": cp})

        migrated_overrides: dict[str, dict[str, str]] = {}
        for k, v in data.get("project_overrides", {}).items():
            migrated_overrides[_migrate_path(k)] = v  # 兩舊 key 撞同一新 key → 後者覆蓋

        return cls(
            path=path,
            version=data.get("version", 1),
            roots=migrated_roots,
            accounts=data.get("accounts", DEFAULT_CONFIG["accounts"]),
            manual_projects=migrated_manual,
            project_overrides=migrated_overrides,
            ui=data.get("ui", DEFAULT_CONFIG["ui"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "roots": self.roots,
            "accounts": self.accounts,
            "manual_projects": self.manual_projects,
            "project_overrides": self.project_overrides,
            "ui": self.ui,
        }

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, self.path)  # 原子替換，避免 crash 中途留下半寫壞檔

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

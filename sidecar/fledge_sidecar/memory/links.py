"""Fledge-owned 連結存儲：memory-links.json（唯讀源外的唯一寫入）。
單實例假設：行程內 lock 序列化；atomic write（tmp→rename）+ 0600。"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path


def _norm(s: str) -> str:
    """正規化：小寫 + 去分隔符（- _ 空白 /）。ASCII+CJK 逐字（不做繁簡/別名）。"""
    return "".join(c for c in s.lower() if c not in "-_/ \t")


def _pair_key(a: str, b: str) -> tuple[str, str]:
    """連結/建議的 candidate identity = canonical (project_path, topic_path) 無向 pair。
    _norm() 只用於 suggest_links 的『名稱包含』比對，不是 pair key。"""
    return (a, b) if a <= b else (b, a)


# module-level 共用 lock：route 每次新建 LinksStore instance 仍序列化同行程內並寫
_STORE_LOCK = threading.Lock()


class LinksStore:
    def __init__(self, path: Path):
        self._path = Path(path)
        self._lock = _STORE_LOCK          # 共用，不是 per-instance
        self._links: list[dict] = []
        self._dismissed: list[list[str]] = []   # [[project, topic], ...]
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._links = data.get("links", []) if isinstance(data, dict) else []
            self._dismissed = data.get("dismissed", []) if isinstance(data, dict) else []
        except (OSError, ValueError):
            self._links, self._dismissed = [], []

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + f".tmp.{os.getpid()}")
        payload = {"version": 1, "links": self._links, "dismissed": self._dismissed}
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.chmod(0o600)                          # 落盤前縮權（含絕對路徑）
        os.replace(tmp, self._path)

    def links(self) -> list[dict]:
        return list(self._links)

    def add(self, a: str, b: str, note: str = "") -> None:
        key = _pair_key(a, b)
        with self._lock:
            self._load()                          # read-modify-write 前重讀
            if any(_pair_key(l["from"], l["to"]) == key for l in self._links):
                return
            self._links.append({"from": key[0], "to": key[1], "note": note, "created": ""})
            self._save()

    def remove(self, a: str, b: str) -> None:
        key = _pair_key(a, b)
        with self._lock:
            self._load()
            self._links = [l for l in self._links if _pair_key(l["from"], l["to"]) != key]
            self._save()

    def dismiss(self, project: str, topic: str) -> None:
        with self._lock:
            self._load()
            if [project, topic] not in self._dismissed:
                self._dismissed.append([project, topic])
                self._save()

    def is_dismissed(self, project: str, topic: str) -> bool:
        return [project, topic] in self._dismissed

    def confirm(self, project: str, topic: str, note: str = "") -> None:
        self.add(project, topic, note)            # 確認建議 = 建立連結


def suggest_links(projects: list[dict], topics: list[dict],
                  confirmed: set, dismissed: set) -> list[dict]:
    """自動建議：topic 資料夾名或 tags（正規化）⊇ 專案名。
    confirmed/dismissed 為 canonical {(project_path, topic_path)} pair set。
    dismiss 持久於 tag 變更；topic folder rename → 路徑改 → 視為新 candidate 會重建議（可接受）。
    專案名正規化長度<4 跳過（只手動）。"""
    out: list[dict] = []
    for p in projects:
        pkey = _norm(p.get("name") or "")
        if len(pkey) < 4:
            continue
        for t in topics:
            pair = (p["path"], t["path"])
            if pair in confirmed or pair in dismissed:
                continue
            hay = _norm(t.get("name") or "") + "".join(_norm(x) for x in t.get("tags", []))
            if pkey in hay:
                out.append({"project": p["path"], "topic": t["path"],
                            "project_name": p.get("name"), "topic_name": t.get("name")})
    return out

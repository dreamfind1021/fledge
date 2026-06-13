"""markdown + frontmatter 解析 → ParsedDoc。no-raise：壞檔回 None 或盡力降級（design §4）。"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_WIKILINK = re.compile(r"\[\[([^\[\]]+?)\]\]")


@dataclass(frozen=True)
class ParsedDoc:
    path: str
    title: str
    summary: str
    type: str
    tags: tuple[str, ...]
    status: str
    body: str
    links: tuple[str, ...]
    mtime: float


def _split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """極簡 frontmatter：第一段 --- ... --- 視為 YAML-lite。no-raise。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    block = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    meta: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, _, val = line.partition(":")
        meta[key.strip().lower()] = val.strip()
    return meta, body


def _parse_tags(raw: str) -> tuple[str, ...]:
    """支援 inline list `[a, b]` 或逗號分隔；no-raise。"""
    s = raw.strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    if not s:
        return ()
    return tuple(t.strip().strip("'\"") for t in s.split(",") if t.strip())


def parse_doc(path: Path) -> ParsedDoc | None:
    """讀檔→ParsedDoc；任何 OSError/解析錯 → None（呼叫端計數跳過）。"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        mtime = path.stat().st_mtime
    except OSError:
        return None
    try:
        meta, body = _split_frontmatter(text)
        title = (meta.get("name") or meta.get("title") or path.stem).strip()
        summary = (meta.get("summary") or meta.get("description") or "").strip()
        links = tuple(dict.fromkeys(
            m.group(1).split("|", 1)[0].strip() for m in _WIKILINK.finditer(body)
        ))
        return ParsedDoc(
            path=str(path), title=title, summary=summary,
            type=meta.get("type", "").strip(), tags=_parse_tags(meta.get("tags", "")),
            status=meta.get("status", "").strip(), body=body, links=links, mtime=mtime,
        )
    except Exception:   # 內容層絕不 raise（與 usage parser 同契約）
        return None

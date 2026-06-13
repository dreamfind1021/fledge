"""組面板 payload：scope 分層、專案中心分組、掛連結/建議、in-memory 搜尋（design §6/§7）。"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from fledge_sidecar.memory.parser import ParsedDoc
from fledge_sidecar.memory.scanner import KmsRef, NativeRef

_GLOBAL_TYPES = {"user", "feedback"}
_PROJECT_TYPES = {"project", "reference"}


def _scope_native(mtype: str) -> str:
    t = (mtype or "").lower()
    if t in _GLOBAL_TYPES:
        return "global"
    if t in _PROJECT_TYPES:
        return "project"
    return "unknown"


@dataclass(frozen=True)
class MemoryItem:
    source: str                 # native | kms
    scope: str                  # global | project | kb | unknown
    path: str
    title: str
    type: str
    summary: str
    body: str                   # 內部用（搜尋/snippet）；overview 不輸出（design §7）
    tags: tuple[str, ...]
    status: str
    links: tuple[str, ...]
    mtime: float
    account: str | None = None
    project: str | None = None
    attribution: str | None = None
    domain: str | None = None
    topic: str | None = None    # kms topics/<folder> folder 路徑


def to_item(ref, doc: ParsedDoc) -> MemoryItem:
    if isinstance(ref, NativeRef):
        return MemoryItem(source="native", scope=_scope_native(doc.type), path=doc.path,
                          title=doc.title, type=doc.type, summary=doc.summary, body=doc.body,
                          tags=doc.tags, status=doc.status, links=doc.links, mtime=doc.mtime,
                          account=ref.account, project=ref.project, attribution=ref.attribution)
    return MemoryItem(source="kms", scope="kb", path=doc.path, title=doc.title, type=doc.type,
                      summary=doc.summary, body=doc.body, tags=doc.tags, status=doc.status,
                      links=doc.links, mtime=doc.mtime, domain=ref.domain, topic=ref.topic or None)


def _snippet(body: str, q: str) -> str:
    """命中 token 周邊片段（design §7 q 回 snippet）。"""
    if not q or not body:
        return ""
    low = body.lower()
    for tok in q.lower().split():
        i = low.find(tok)
        if i >= 0:
            return body[max(0, i - 40): i + len(tok) + 60].strip().replace("\n", " ")
    return ""


def _summary_dict(it: MemoryItem, q: str = "") -> dict:
    """overview 用：摘要欄位 + path（identity）+ snippet，**不含 body**（design §7）。"""
    d = {"source": it.source, "scope": it.scope, "path": it.path, "title": it.title,
         "type": it.type, "summary": it.summary, "tags": list(it.tags), "status": it.status,
         "links": list(it.links), "mtime": it.mtime}
    for k in ("account", "project", "attribution", "domain", "topic"):
        v = getattr(it, k)
        if v is not None:
            d[k] = v
    snip = _snippet(it.body, q)
    if snip:
        d["snippet"] = snip
    return d


def _matches(it: MemoryItem, q: str) -> bool:
    if not q:
        return True
    hay = f"{it.title}\n{it.summary}\n{' '.join(it.tags)}\n{it.path}\n{it.body}".lower()  # 含 body
    return all(tok in hay for tok in q.lower().split())


def build_overview(natives: list, kms: list, links: list, suggestions: list, q: str = "") -> dict:
    """回 {global, projects[], kb, unattributed, unknown, scan_meta}。三態與 unknown 皆可見。"""
    items = [to_item(r, d) for r, d in natives] + [to_item(r, d) for r, d in kms]
    items = [it for it in items if _matches(it, q)]

    # 無向連結 index；topic folder → project（已連 topic 掛 project）
    rel: dict[str, set] = defaultdict(set)
    for l in links:
        rel[l["from"]].add(l["to"]); rel[l["to"]].add(l["from"])
    topic_to_projs: dict[str, list] = defaultdict(list)        # 同 topic 可連多 project
    for proj, ends in rel.items():
        for e in ends:
            topic_to_projs[e].append(proj)

    glob, kb, unattr, unknown = [], [], [], []
    by_proj: dict[str, list] = defaultdict(list)
    for it in items:
        if it.scope == "global":
            glob.append(it)
        elif it.source == "kms":
            projs = topic_to_projs.get(it.topic) if it.topic else None
            if projs:
                for p in projs:                                # 已連 topic 掛到「每個」連到的 project
                    by_proj[p].append(it)
            else:
                kb.append(it)                                  # 未連 topic / library → kb
        elif it.scope == "unknown":
            unknown.append(it)
        elif it.project:
            by_proj[it.project].append(it)
        else:
            unattr.append(it)                                  # orphan / ambiguous（project=None）

    rel_sugg: dict[str, list] = defaultdict(list)
    for s in suggestions:
        rel_sugg[s["project"]].append(s)
    attached: dict[str, set] = defaultdict(set)                # 已掛為 items 的 topic folder
    for proj, its in by_proj.items():
        for it in its:
            if it.source == "kms" and it.topic:
                attached[proj].add(it.topic)

    projects = [{
        "project": proj,
        "items": [_summary_dict(it, q) for it in sorted(its, key=lambda x: -x.mtime)],
        "related": sorted(rel.get(proj, set()) - attached.get(proj, set())),  # 相關只列未成 items 的端點
        "suggestions": rel_sugg.get(proj, []),
    } for proj, its in sorted(by_proj.items())]

    return {
        "global": [_summary_dict(it, q) for it in glob],
        "projects": projects,
        "kb": [_summary_dict(it, q) for it in kb],
        "unattributed": [_summary_dict(it, q) for it in unattr],   # 可見
        "unknown": [_summary_dict(it, q) for it in unknown],       # 可見
        "scan_meta": {"total": len(items), "unknown_count": len(unknown),
                      "unattributed_count": len(unattr)},
    }


def build_related(project: str, links: list, suggestions: list) -> dict:
    """右下懸浮用：單專案的相關連結 + 建議（design §6b）。"""
    related = sorted({l["to"] if l["from"] == project else l["from"]
                      for l in links if project in (l["from"], l["to"])})
    sugg = [s for s in suggestions if s["project"] == project]
    return {"project": project, "related": related, "suggestions": sugg}

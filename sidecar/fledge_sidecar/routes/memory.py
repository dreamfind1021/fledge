"""記憶層路由（design §7）。唯讀聚合 + 唯一寫 memory-links.json。"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from fledge_sidecar.app_config import AppConfig, default_config_path
from fledge_sidecar.memory.aggregator import build_overview, build_related
from fledge_sidecar.memory.links import LinksStore, suggest_links
from fledge_sidecar.memory.parser import parse_doc
from fledge_sidecar.memory.scanner import kms_files, native_memory_files, is_kms_file_allowed
from fledge_sidecar.paths import resolve_best_effort
from fledge_sidecar.project_scanner import scan_all

router = APIRouter(prefix="/memory")
_state: dict = {}


def reset_state_for_tests() -> None:
    _state.clear()


def _links_path() -> Path:
    override = os.environ.get("FLEDGE_MEMORY_LINKS")
    return Path(override) if override else default_config_path().parent / "memory-links.json"


def _scan(config: AppConfig):
    """v1 scan-on-demand（語料小、~ms；mtime memo 留作未來優化）。
    native 各帳號用 account-local known projects；KMS topic 以 folder 識別。"""
    projects, _ = scan_all(config)
    natives = []
    for key, acct in config.accounts.items():
        cd = acct.get("config_dir")
        if not cd:
            continue
        known = [p["path"] for p in projects if p.get("account") == key]      # account-local
        for ref in native_memory_files(account=key, config_dir=Path(cd).expanduser(), known_projects=known):
            doc = parse_doc(Path(ref.path))
            if doc:
                natives.append((ref, doc))
    kms = []
    topic_acc: dict[str, dict] = {}                  # folder → {path, name, tags}
    for kref in kms_files(config.kms_root):
        doc = parse_doc(Path(kref.path))
        if not doc:
            continue
        kms.append((kref, doc))
        if kref.domain == "topics" and kref.topic:   # topic = folder，name = folder basename
            t = topic_acc.setdefault(kref.topic, {"path": kref.topic, "name": Path(kref.topic).name, "tags": set()})
            t["tags"].update(doc.tags)
    topics = [{"path": t["path"], "name": t["name"], "tags": sorted(t["tags"])} for t in topic_acc.values()]
    return natives, kms, projects, topics


def _suggestions(store: LinksStore, projects, topics):
    confirmed = {(l["from"], l["to"]) for l in store.links()}
    confirmed |= {(b, a) for a, b in confirmed}
    dismissed = {(d[0], d[1]) for d in store._dismissed}
    return suggest_links([{"path": p["path"], "name": p["name"]} for p in projects],
                         topics, confirmed=confirmed, dismissed=dismissed)


@router.get("/overview")
def overview(q: str = ""):
    config = AppConfig.load()
    natives, kms, projects, topics = _scan(config)
    store = LinksStore(_links_path())
    sugg = _suggestions(store, projects, topics)
    return JSONResponse(build_overview(natives, kms, store.links(), sugg, q=q))


@router.get("/related")
def related(project: str):
    config = AppConfig.load()
    _, _, projects, topics = _scan(config)
    store = LinksStore(_links_path())
    sugg = _suggestions(store, projects, topics)
    return JSONResponse(build_related(project, store.links(), sugg))


@router.get("/item")
def item(path: str):
    """單筆全文。containment + allowlist（驗證通過後一律讀 realpath，閉 symlink TOCTOU）：
    native 限精確形狀 projects/<enc>/memory/*.md（rel 恰 3 段、中段 memory、非 MEMORY.md、regular、在帳號 projects 內）；
    kms 共用 scanner is_kms_file_allowed（*.md、regular、非 hidden/_*/CLAUDE.md、realpath 在 root 內、擋逃逸 symlink）。"""
    config = AppConfig.load()
    f = Path(path)
    real = resolve_best_effort(path)
    allowed = False
    if (real.endswith(".md") and f.name != "MEMORY.md" and Path(real).is_file()):
        for acct in config.accounts.values():
            cd = acct.get("config_dir")
            if not cd:
                continue
            base = resolve_best_effort(str(Path(cd).expanduser() / "projects"))
            if real.startswith(base + "/"):
                # 只放行精確形狀 projects/<enc>/memory/*.md：rel 恰 3 段、中段為 memory
                # （scanner 只 surface 這一層；擋 projects/<enc>/sub/memory/x 與 memory/deep/x）
                rel_parts = real[len(base) + 1:].split("/")
                if len(rel_parts) == 3 and rel_parts[1] == "memory":
                    allowed = True
                    break
    if not allowed and config.kms_root:
        root = Path(resolve_best_effort(str(Path(config.kms_root).expanduser())))
        # 傳已解析的 real（非原始 f）：is_kms_file_allowed 內的再 resolve 對 realpath 冪等，
        # 使「驗證」與下方「讀取」共用同一次 resolve（line 92），閉合 KMS 分支 check-vs-read 窗口
        if is_kms_file_allowed(Path(real), root):
            allowed = True
    if not allowed:
        return JSONResponse({"error": "path not allowed"}, status_code=403)
    doc = parse_doc(Path(real))
    if not doc:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({"path": doc.path, "title": doc.title, "body": doc.body})


@router.post("/links")
def add_link(payload: dict = Body(...)):
    LinksStore(_links_path()).add(payload["from"], payload["to"], payload.get("note", ""))
    return JSONResponse({"ok": True})


@router.delete("/links")
def del_link(payload: dict = Body(...)):
    LinksStore(_links_path()).remove(payload["from"], payload["to"])
    return JSONResponse({"ok": True})


@router.post("/links/confirm")
def confirm(payload: dict = Body(...)):
    LinksStore(_links_path()).confirm(payload["project"], payload["topic"])
    return JSONResponse({"ok": True})


@router.post("/links/dismiss")
def dismiss(payload: dict = Body(...)):
    LinksStore(_links_path()).dismiss(payload["project"], payload["topic"])
    return JSONResponse({"ok": True})

from fledge_sidecar.memory.parser import ParsedDoc
from fledge_sidecar.memory.scanner import NativeRef, KmsRef
from fledge_sidecar.memory.aggregator import build_overview, _scope_native, to_item


def _pd(title="t", typ="project", summary="s", body="b", links=()):
    return ParsedDoc(path="/x/"+title+".md", title=title, summary=summary, type=typ,
                     tags=(), status="", body=body, links=links, mtime=0.0)


def test_scope_native_mapping():
    assert _scope_native("user") == "global"
    assert _scope_native("feedback") == "global"
    assert _scope_native("project") == "project"
    assert _scope_native("reference") == "project"
    assert _scope_native("") == "unknown"
    assert _scope_native("weird") == "unknown"


def test_overview_groups_global_projects_kb():
    natives = [
        (NativeRef("/c/proj/-work-fledge/memory/u.md", "work", "/work/fledge", "matched"),
         _pd("user-fact", "user", "我是誰")),
        (NativeRef("/c/proj/-work-fledge/memory/p.md", "work", "/work/fledge", "matched"),
         _pd("fledge-thing", "project", "專案事")),
    ]
    kms = [(KmsRef("/kms/library/src.md", "library", ""), _pd("brobertsaz", "", "來源"))]
    d = build_overview(natives, kms, links=[], suggestions=[], q="")
    assert any(i["title"] == "user-fact" for i in d["global"])
    proj = next(p for p in d["projects"] if p["project"] == "/work/fledge")
    assert any(i["title"] == "fledge-thing" for i in proj["items"])
    assert any(i["title"] == "brobertsaz" for i in d["kb"])


def test_orphan_ambiguous_visible(tmp_path):
    # project=None 的 orphan/ambiguous 必須出現在 unattributed，不被靜默丟
    natives = [
        (NativeRef("/c/proj/-gone/memory/m.md", "work", None, "orphan"), _pd("孤兒", "project", "x")),
        (NativeRef("/c/proj/-coll/memory/m.md", "work", None, "ambiguous"), _pd("碰撞", "reference", "y")),
    ]
    d = build_overview(natives, [], links=[], suggestions=[], q="")
    titles = {i["title"] for i in d["unattributed"]}
    assert titles == {"孤兒", "碰撞"}
    assert d["scan_meta"]["unattributed_count"] == 2
    assert d["projects"] == []                  # 不誤掛任何 project


def test_linked_topic_attached_to_project():
    # 已連 KMS topic folder 的 item 掛到 project 的 items，不留在 kb
    topic_folder = "/kms/topics/garden-planner-irrigation"
    kms = [(KmsRef(topic_folder + "/CONTEXT.md", "topics", topic_folder), _pd("ASR topic", "", "決策"))]
    links = [{"from": "/work/Garden Planner", "to": topic_folder, "note": ""}]
    d = build_overview([], kms, links=links, suggestions=[], q="")
    proj = next(p for p in d["projects"] if p["project"] == "/work/Garden Planner")
    assert any(i["title"] == "ASR topic" for i in proj["items"])     # 掛進 project
    assert all(i["title"] != "ASR topic" for i in d["kb"])           # 不在 kb


def test_overview_excludes_body_but_item_keeps_path():
    natives = [(NativeRef("/c/proj/-work-fledge/memory/p.md", "work", "/work/fledge", "matched"),
                _pd("p", "project", body="SECRET-FULL-BODY"))]
    d = build_overview(natives, [], links=[], suggestions=[], q="")
    item = d["projects"][0]["items"][0]
    assert "body" not in item                  # overview 只回摘要
    assert item["path"].endswith("p.md")       # path 作為 identity 保留


def test_search_matches_body_and_returns_snippet():
    # token 只在 body（不在 title/summary）也要命中，並回 snippet
    natives = [
        (NativeRef("/c/proj/-work-fledge/memory/a.md", "work", "/work/fledge", "matched"),
         _pd("ASR 調優", "project", "摘要無關鍵字", body="深處藏著 multichannel 設定")),
        (NativeRef("/c/proj/-work-fledge/memory/b.md", "work", "/work/fledge", "matched"),
         _pd("無關", "project", "其他", body="完全不同")),
    ]
    d = build_overview(natives, [], links=[], suggestions=[], q="multichannel")
    items = [i for p in d["projects"] for i in p["items"]]
    titles = [i["title"] for i in items]
    assert "ASR 調優" in titles and "無關" not in titles
    hit = next(i for i in items if i["title"] == "ASR 調優")
    assert "body" not in hit and "multichannel" in hit.get("snippet", "")

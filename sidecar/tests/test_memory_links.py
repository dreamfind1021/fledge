import stat
from pathlib import Path
from fledge_sidecar.memory.links import LinksStore, suggest_links, _norm


def test_add_undirected_dedup_and_persist(tmp_path):
    p = tmp_path / "memory-links.json"
    s = LinksStore(p)
    s.add("/work/A", "/work/B", note="串接")
    s.add("/work/B", "/work/A")               # 反向 = 同一條，不重複
    assert len(s.links()) == 1
    s2 = LinksStore(p)                         # 重新載入持久化
    assert len(s2.links()) == 1


def test_file_mode_0600(tmp_path):
    p = tmp_path / "memory-links.json"
    LinksStore(p).add("/a", "/b")
    assert stat.S_IMODE(p.stat().st_mode) == 0o600


def test_dismiss_bound_to_pair(tmp_path):
    s = LinksStore(tmp_path / "l.json")
    s.dismiss("/work/Garden Planner", "/kms/topics/garden-planner-irrigation")
    assert s.is_dismissed("/work/Garden Planner", "/kms/topics/garden-planner-irrigation")
    assert not s.is_dismissed("/work/Garden Planner", "/kms/topics/other")


def test_suggest_matches_topic_name_contains_project():
    projects = [{"path": "/work/Garden Planner", "name": "Garden Planner"}]
    topics = [{"path": "/kms/topics/garden-planner-irrigation", "name": "garden-planner-irrigation", "tags": []},
              {"path": "/kms/topics/unrelated", "name": "unrelated", "tags": []}]
    sugg = suggest_links(projects, topics, confirmed=set(), dismissed=set())
    pairs = {(x["project"], x["topic"]) for x in sugg}
    assert ("/work/Garden Planner", "/kms/topics/garden-planner-irrigation") in pairs
    assert all(t != "/kms/topics/unrelated" for _, t in pairs)


def test_suggest_short_name_manual_only():
    projects = [{"path": "/work/ai", "name": "ai"}]    # 正規化長度 < 4
    topics = [{"path": "/kms/topics/ai-thing", "name": "ai-thing", "tags": []}]
    assert suggest_links(projects, topics, confirmed=set(), dismissed=set()) == []


def test_norm():
    assert _norm("Garden Planner") == "gardenplanner"
    assert _norm("garden-planner_x") == "gardenplannerx"


def test_concurrent_adds_no_loss(tmp_path):
    # 多 instance（route 每次新建）共用 module lock，並寫不互蓋
    import threading as th
    p = tmp_path / "l.json"
    def worker(i):
        LinksStore(p).add(f"/a{i}", f"/b{i}")
    ts = [th.Thread(target=worker, args=(i,)) for i in range(20)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert len(LinksStore(p).links()) == 20

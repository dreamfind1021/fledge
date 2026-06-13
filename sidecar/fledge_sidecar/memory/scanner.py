"""找檔：native（三態歸屬）+ KMS（containment）。對來源永遠唯讀（design §4）。"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from fledge_sidecar.paths import resolve_best_effort
from fledge_sidecar.project_scanner import encode_cc_project_dir

_KMS_SKIP_PREFIX = ("_", ".")        # 管理檔 _INDEX/_CONNECTIONS… 與 hidden
_KMS_SKIP_NAMES = {"CLAUDE.md"}


@dataclass(frozen=True)
class NativeRef:
    path: str
    account: str
    project: str | None
    attribution: str            # matched | orphan | ambiguous


@dataclass(frozen=True)
class KmsRef:
    path: str
    domain: str                 # library | topics（其他一律排除，design §4 資料源邊界）
    topic: str                  # topics/<folder> 的 folder 路徑（domain=topics 才有，否則 ''）


def native_memory_files(account: str, config_dir: Path, known_projects: list[str]) -> list[NativeRef]:
    """掃單一帳號 config_dir/projects/<encoded>/memory/*.md（除 MEMORY.md）。
    encoded→專案用正向比對：已知專案 encode 後建反查；同 encoded 命中 ≥2 → ambiguous。"""
    # 建 encoded → [專案路徑...] 反查（偵測碰撞）
    enc_map: dict[str, list[str]] = defaultdict(list)
    for proj in known_projects:
        enc_map[encode_cc_project_dir(proj)].append(proj)

    projects_dir = Path(config_dir).expanduser() / "projects"
    out: list[NativeRef] = []
    try:
        encoded_dirs = [d for d in projects_dir.iterdir() if d.is_dir()]
    except OSError:
        return out
    for d in encoded_dirs:
        mem = d / "memory"
        if not mem.is_dir():
            continue
        hits = enc_map.get(d.name, [])
        if len(hits) == 1:
            project, attribution = hits[0], "matched"
        elif len(hits) >= 2:
            project, attribution = None, "ambiguous"
        else:
            project, attribution = None, "orphan"
        try:
            files = sorted(mem.glob("*.md"))
        except OSError:
            continue
        for f in files:
            if f.name == "MEMORY.md" or not f.is_file():
                continue
            out.append(NativeRef(path=str(f), account=account, project=project, attribution=attribution))
    return out


def is_kms_file_allowed(f: Path, root: Path) -> bool:
    """KMS 檔 allowlist（route /memory/item 與 scanner 共用）：
    *.md、regular file、非 hidden / `_*` / CLAUDE.md、realpath 必須在 root/library 或 root/topics 內
    （與 kms_files 掃描範圍一致；順帶擋逃逸 symlink——逃出去的 realpath 不在這兩個 base 下）。"""
    name = f.name
    if not name.endswith(".md") or name in _KMS_SKIP_NAMES or name.startswith(_KMS_SKIP_PREFIX):
        return False
    real = resolve_best_effort(str(f))
    bases = (str(root / "library"), str(root / "topics"))     # route 與 scanner 同一可讀集合
    if not any(real == b or real.startswith(b + "/") for b in bases):
        return False
    # 任一層資料夾／檔名為 hidden 或 `_前綴` → 排除（與 _INDEX/_CONNECTIONS 管理慣例一致，含中間目錄）。
    # library／topics 本身不以 _/. 開頭，故不受影響；只擋更深的 _x／.x 段。
    rel = real[len(str(root)) + 1:].split("/") if real.startswith(str(root) + "/") else []
    if any(part.startswith(_KMS_SKIP_PREFIX) for part in rel):
        return False
    return Path(real).is_file()


def kms_files(kms_root: str | None) -> list[KmsRef]:
    """只掃 KMS root 的 `library/` 與 `topics/`（design §4 資料源邊界）。
    allowlist 共用 is_kms_file_allowed。topic = topics/<folder> folder 路徑。"""
    if not kms_root:
        return []
    root = Path(resolve_best_effort(str(Path(kms_root).expanduser())))
    if not root.is_dir():
        return []
    out: list[KmsRef] = []
    for domain in ("library", "topics"):
        base = root / domain
        if not base.is_dir():
            continue
        for f in base.rglob("*.md"):
            if not is_kms_file_allowed(f, root):
                continue
            topic = ""
            if domain == "topics":
                try:
                    rel = f.resolve().relative_to(base)        # <folder>/.../x.md
                    topic = str(base / rel.parts[0]) if rel.parts else ""
                except (ValueError, OSError):
                    topic = ""
            out.append(KmsRef(path=str(f), domain=domain, topic=topic))
    return out

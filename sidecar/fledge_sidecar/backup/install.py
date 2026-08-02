"""移機：把展開目錄（staging）的資產寫進新機的現役目錄。

**本模組是唯一有能力寫現役目錄的還原路徑。** `backup/restore.py` 維持零寫入能力
（那是票 09 的結構性不變式），本模組是它的下一步而非同義詞——術語見 CONTEXT.md 的
migration／restore 分界。

安全權威留在模組內：不接受 caller 宣稱已驗證的落點，所有 config_dir 一律自己
expand→absolute→resolve 後才使用（比照 common_config）。備份包的內容**一律是不可信
輸入**——manifest 只能描述來源，不能授權目的地（spec §4.2.2）。
"""
from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import logging
import os
import re
import stat as stat_module
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fledge_sidecar.paths import (
    dir_identity,
    expand_and_validate,
    is_same_or_within,
    resolve_best_effort,
)
from fledge_sidecar.project_scanner import encode_cc_project_dir
from fledge_sidecar.setup import safe_fs

logger = logging.getLogger(__name__)

Outcome = Literal["installed", "skipped", "excluded", "failed"]

# 明確不處理的頂層項目。`.claude.json` 同一個檔案裡混著真資產（projects 的權限清單、
# mcpServers）、機器身分（oauthAccount、machineID）與純快取（cachedGrowthBookFeatures
# 442 項）——整份搬會蓋掉新機剛登入好的狀態，整份不搬只是要重新累積，後者代價小得多。
EXCLUDED_NAMES: frozenset[str] = frozenset({".claude.json"})

MANIFEST_NAME = "manifest.json"

# 對話歷史所在的帳號子目錄：`projects/<encoded>` 的第二層目錄名是移機唯一的改寫點
# （票 01 實測：/resume 定位只靠目錄名、歷史檔內容完全不動）。
_PROJECTS_DIR = "projects"

# account key 會被拼進 Path(root, "accounts", key) 與 fd-relative open：絕對 key 讓 Path
# 丟棄 root、`..` 走出 staging、絕對路徑更會讓 os.open 直接忽略 dir_fd。manifest 是不可信
# 輸入、config 的 accounts 也可能被手動編輯——**在本模組的信任邊界重驗**，不依賴新增帳號
# API 的擋法（routes/config.py 的 _KEY_RE 同一規則）。
_SAFE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True)
class ItemResult:
    account: str        # target account key；extra 項用 "extra:<name>" 命名空間
    rel_path: str       # 相對該落點的路徑
    outcome: Outcome
    error: str | None = None      # 穩定判別碼；完整例外只進 log


@dataclass(frozen=True)
class InstallPlan:
    source_root: str                        # 展開目錄（resolved）
    source_identity: tuple[int, int] | None  # 建 plan 當下的身分，install 前重驗
    targets: dict[str, str]                 # account key -> resolved config_dir
    # target 側的 plan 時身分（票 03 R1，比照 source_identity）：install 開出 fd 後
    # fstat 比對。None＝plan 時不存在（全新機器的主流情境）、由 install 新建，沒有
    # 基準可比——那條窗口是殘餘，記錄於票 03。
    target_identities: dict[str, tuple[int, int] | None]
    extra_targets: dict[str, str]           # extra 項名 -> resolved 落點
    # 各落點來源在 plan 時的身分（Codex 票 05 R1 F1；帳號側比照＝票 05 收尾裁示，封
    # 票 03 殘餘窗口）。key 用落點命名空間（account key／`extra:<name>`）。install 只在
    # 「install 時狀態＝plan 時狀態」才動手——換成另一個真目錄（O_NOFOLLOW 攔不到）、
    # plan 後才出現、plan 看過卻消失，皆 failed（source_moved）；None＝plan 時不存在，
    # install 見 ENOENT 才容許靜默。內容層變動不凍結——plan 是預覽不是內容授權。
    spot_source_identities: dict[str, tuple[int, int] | None]
    # 票 06：專案目錄改名表（舊 encoded 名 → 新 encoded 名；新名一律由
    # encode_cc_project_dir 產生，不接受任意字串）與未對應專案清單（照搬原位置；
    # 路徑變動時 /resume 會找不到——前端據此提示，後端只給資料不給 prose）。
    project_renames: dict[str, str]
    unmapped_projects: list[dict]
    will_install: int
    will_skip: list[str]
    # 目的地祖先被非目錄（一般檔或 symlink）占用的葉檔：install 只會在目錄層 fail、
    # 這些葉檔根本到不了，算進 will_install 就是預覽說謊（Codex 票 03 R2）。
    blocked: list[str]
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


def validate_landing_spots(spots: dict[str, str]) -> dict[str, str]:
    """驗使用者確認的落點（adopt-config 專用，票 07）。回 {key: resolved 路徑}；任一
    不合法即整批 ValueError（判別碼由 route 轉 400）。

    key 用落點命名空間（account key／`extra:<name>`），文法驗冒號後的裸名——與
    `_SAFE_KEY_RE` 同一條信任邊界。這是**授權發生的那一刻**，驗得比 plan 嚴：除了
    路徑正規化＋ADR-0001 底線防呆，落點之間（含帳號×extra 交叉）不得互為祖先——
    外層落點的安裝會把內層目錄整個蓋掉（沿用 build_account_graph 的重疊規則）。"""
    resolved: dict[str, str] = {}
    for key, raw in spots.items():
        bare = key.split(":", 1)[1] if key.startswith("extra:") else key
        if not _SAFE_KEY_RE.fullmatch(bare):
            raise ValueError("invalid_account_key")
        resolved[key] = _resolved_config_dir(raw)
    _ensure_no_overlap(list(resolved.values()))
    return resolved


def _ensure_no_overlap(resolved: list[str]) -> None:
    """任兩落點相同或互為祖先 → overlapping_config_dirs：外層的安裝會把內容灌進內層
    落點的樹裡。adopt 授權時與 install 的 `plan` **各跑一道**——config 可被手編、路徑
    的解析結果也會隨 symlink 變動，授權時刻的檢查不能是唯一一道（Codex 票 07 R1 F2）。"""
    for i, path in enumerate(resolved):
        for other in resolved[:i]:
            if is_same_or_within(path, other) or is_same_or_within(other, path):
                raise ValueError("overlapping_config_dirs")


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
    # accounts 是後續所有迭代與拼路徑的基礎——不是 mapping（null／list／string）的話，
    # 會在 plan 內變成未捕捉的 TypeError 穿出去成裸 500，違反 error-code 合約。
    if not isinstance(data.get("accounts"), dict):
        raise ValueError("source_not_a_bundle")
    # extra 同款（票 05）：字串會被迭代成單字元 name、null 直接 TypeError。缺欄位容忍
    # （視為空），有欄位就必須是 {str: str}——JSON 物件的 key 必為字串，驗 value 即可。
    extra = data.get("extra", {})
    if not isinstance(extra, dict) or any(not isinstance(v, str) for v in extra.values()):
        raise ValueError("source_not_a_bundle")
    return data


def _walk_account(account_dir: Path) -> tuple[list[str], list[str]]:
    """回 (可安裝的相對路徑, 被排除的名字)。純掃描，不寫任何東西。

    **不跟隨 symlink**：`os.walk` 的 followlinks 預設就是 False，但這裡顯式寫出來——
    備份包裡一個指向 `/` 的目錄連結就能讓遞迴走出展開目錄。

    **只數 lstat 為一般檔的項目**：`os.walk` 會把 file symlink（含斷鏈）與特殊檔都放進
    filenames，而 install 的 scandir 路徑對 symlink 是第二階段（票 04）、對特殊檔是
    excluded——plan 照單全收的話，預覽數字會穩定大於實際結果（Codex 票 03 R1 的
    walk／scandir 語意分歧）。"""
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
                st = os.lstat(os.path.join(dirpath, name))
                if stat_module.S_ISREG(st.st_mode):
                    installable.append(rel)
    return installable, excluded


def _dest_rel(rel: str, renames: dict[str, str] | None) -> str:
    """來源相對路徑 → 目的地相對路徑：只有 `projects/<專案>` 的第二層目錄名會換
    （票 06），其餘一律原樣。"""
    if not renames:
        return rel
    parts = rel.split(os.sep)
    if len(parts) >= 2 and parts[0] == _PROJECTS_DIR and parts[1] in renames:
        parts[1] = renames[parts[1]]
        return os.sep.join(parts)
    return rel


def _scan_spot(content_dir: Path, target: str,
               renames: dict[str, str] | None = None
               ) -> tuple[int, list[str], list[str], list[str]]:
    """掃一個落點的來源目錄，回 (會裝數, 跳過, 被祖先擋, walk 排除)。純唯讀。

    帳號與 extra 共用同一支——落點的驗證規則不因它不是帳號而放寬（票 05 驗收）。
    目的地存在性與祖先檢查一律以**改名後**的位置判（票 06）：否則帶 mapping 的重跑
    會把已裝的當未裝、預覽數字說謊。skip／blocked 清單記的也是目的地位置。"""
    if not content_dir.is_dir():
        return 0, [], [], []
    installable, walk_excluded = _walk_account(content_dir)
    n_install = 0
    skip: list[str] = []
    blocked: list[str] = []
    # 目的地祖先鏈逐層 lstat（與 install 的 O_NOFOLLOW 同語意：symlink 也算占用）。
    # 快取按相對前綴——同一子樹的葉檔不必重複探測。
    blocked_dirs: set[str] = set()
    ok_dirs: set[str] = set()
    for src_rel in installable:
        rel = _dest_rel(src_rel, renames)
        parent = os.path.dirname(rel)
        bad = False
        cur = ""
        for part in parent.split(os.sep) if parent else []:
            cur = os.path.join(cur, part) if cur else part
            if cur in blocked_dirs:
                bad = True
                break
            if cur in ok_dirs:
                continue
            try:
                st = os.lstat(os.path.join(target, cur))
            except FileNotFoundError:
                ok_dirs.add(cur)            # 不存在 → install 會自己建
                continue
            except OSError:
                blocked_dirs.add(cur)       # 探測不了就 fail-closed 當占用，不虛報
                bad = True
                break
            if stat_module.S_ISDIR(st.st_mode):
                ok_dirs.add(cur)
            else:
                blocked_dirs.add(cur)
                bad = True
                break
        if bad:
            blocked.append(rel)
        elif os.path.lexists(os.path.join(target, rel)):
            skip.append(rel)
        else:
            n_install += 1
    return n_install, skip, blocked, walk_excluded


def _validate_mapping(mapping: list[tuple[str, str]],
                      project_dirs: dict[str, list[str]]) -> dict[str, str]:
    """驗 mapping（舊專案路徑 → 新專案路徑），回 {舊 encoded 名: 新 encoded 名}。
    **在寫任何東西之前一次驗完**（spec §4.2.4）：new 必須絕對路徑；old 必須是備份包
    內確實存在的專案（mapping 也是不可信輸入）；編碼有損（非英數全變 `-`），新名彼此
    相撞、同一專案對到兩個新路徑、或撞上未改寫專案的既有目錄名，都整批拒。"""
    all_names = {n for names in project_dirs.values() for n in names}
    renames: dict[str, str] = {}
    for old, new in mapping:
        if not isinstance(new, str) or not os.path.isabs(new):
            raise ValueError("mapping_not_absolute")
        old_enc = encode_cc_project_dir(str(old))
        if old_enc not in all_names:
            raise ValueError("mapping_unknown_project")
        if old_enc in renames:
            raise ValueError("mapping_collision")   # 同一專案（或編碼相撞的兩個 old）
        renames[old_enc] = encode_cc_project_dir(new)
    # 每個帳號的 projects/ 內，改名後的名字集合不得有重複（含未改寫的既有名）——
    # 不同帳號各有自己的 projects/，跨帳號同名不構成實體衝突。
    for names in project_dirs.values():
        finals = [renames.get(n, n) for n in names]
        if len(set(finals)) != len(finals):
            raise ValueError("mapping_collision")
    return renames


def _peek_cwd(project_dir: Path) -> str | None:
    """讀專案目錄歷史檔裡第一個出現的 `cwd`。**只讀不改**——編碼不可逆，這是知道
    專案舊路徑的唯一辦法（票 01：內容不必動，讀 cwd 純粹為了列給使用者做對應；
    首行可能是沒有 cwd 的 summary，故逐行找而不是只看第一行）。"""
    for f in sorted(project_dir.glob("*.jsonl")):
        try:
            with f.open(encoding="utf-8") as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    cwd = json.loads(line).get("cwd")
                    if isinstance(cwd, str):
                        return cwd
        except (OSError, ValueError):
            continue                        # 壞檔跳過，不讓它擋住整個列表
    return None


def project_paths(source_root: str) -> list[dict]:
    """列出備份包裡每個專案的舊路徑與建議新路徑。純唯讀（票 06）。

    建議值規則同落點（spec §4.2.2 決策 9）：舊路徑在舊 home 底下 → 換 home 前綴；
    其餘留空**不猜**。一律由使用者確認後經 mapping 送回。"""
    root = resolve_best_effort(source_root)
    manifest = read_manifest(root)          # 順便驗它確實是我們展開的目錄
    old_home = manifest.get("home", "")
    new_home = str(Path.home().resolve())
    found: list[dict] = []
    for key in sorted(manifest.get("accounts", {})):
        if not _SAFE_KEY_RE.fullmatch(key):
            raise ValueError("invalid_account_key")   # key 拼進路徑，同規則重驗
        pdir = Path(root, "accounts", key, _PROJECTS_DIR)
        if not pdir.is_dir():
            continue
        for child in sorted(pdir.iterdir()):
            if not child.is_dir() or child.is_symlink():
                continue
            cwd = _peek_cwd(child)
            if cwd is None:
                continue                    # 讀不出舊路徑的專案無從對應，不列
            suggested = (_rewrite_home_prefix(cwd, old_home, new_home)
                         if old_home else None)
            found.append({
                "account": key,
                "old_path": cwd,
                "encoded_dir": child.name,
                "suggested": suggested or "",
                "suggested_exists": bool(suggested) and os.path.isdir(suggested),
            })
    return found


def plan(source_root: str, accounts: dict[str, dict[str, str]],
         extra: dict[str, str] | None = None,
         mapping: list[tuple[str, str]] | None = None) -> InstallPlan:
    """掃描展開目錄與各落點，回「會裝什麼、會跳過什麼、不處理什麼」。純唯讀。

    `extra`＝帳號目錄外資產（如 `~/.agents`）的**使用者確認落點** `{name: config_dir}`；
    manifest 只提供建議值、不能自行指定目的地（spec §4.2.2）——沒確認的整項不搬、列 excluded。
    `mapping`＝使用者確認的專案路徑對應（舊絕對路徑 → 新絕對路徑，票 06）：只影響
    `projects/<encoded>` 的目錄名，歷史檔逐位元組不變。"""
    root = resolve_best_effort(source_root)
    manifest = read_manifest(root)          # 順便驗它確實是我們展開的目錄
    # 實體 accounts/ 目錄也是 bundle 形狀的一部分：缺了它 plan 會回一份空預覽、install
    # 卻在 _open_dir_pinned("accounts") 拋 OSError 穿出去——預覽與執行要同一判準。
    # lstat 判型（不跟隨）：accounts 是 symlink 時 install 的 O_NOFOLLOW 也會拒開。
    try:
        accounts_st = os.lstat(os.path.join(root, "accounts"))
    except OSError as exc:
        raise ValueError("source_not_a_bundle") from exc
    if not stat_module.S_ISDIR(accounts_st.st_mode):
        raise ValueError("source_not_a_bundle")

    will_install = 0
    will_skip: list[str] = []
    blocked: list[str] = []
    excluded: list[str] = []

    targets: dict[str, str] = {}
    spot_source_identities: dict[str, tuple[int, int] | None] = {}
    for key in manifest.get("accounts", {}):
        entry = accounts.get(key)
        if entry is None:
            continue                        # 使用者沒為這個帳號指定落點 → 不裝
        if not _SAFE_KEY_RE.fullmatch(key):
            raise ValueError("invalid_account_key")   # 進得了 targets 的 key 才會拼路徑
        targets[key] = _resolved_config_dir(entry.get("config_dir", ""))
        spot_source_identities[key] = dir_identity(str(Path(root, "accounts", key)))

    extra_targets: dict[str, str] = {}
    for name in manifest.get("extra", {}):
        confirmed = (extra or {}).get(name)
        # 確認值來自 config.json（使用者可手編）：非字串視同未確認，不讓 .strip() 炸 500
        if not confirmed or not isinstance(confirmed, str):
            excluded.append(name)           # 落點沒被使用者確認就整項不搬（spec §4.2.2）
            continue
        if not _SAFE_KEY_RE.fullmatch(name):
            raise ValueError("invalid_account_key")   # extra name 同樣拼進路徑，同規則重驗
        extra_targets[name] = _resolved_config_dir(confirmed)
        spot_source_identities[f"extra:{name}"] = \
            dir_identity(str(Path(root, "extra", name)))

    # 落點重疊以 install 時的解析結果重驗（帳號＋extra 一起），不依賴 adopt 那一道
    _ensure_no_overlap(list(targets.values()) + list(extra_targets.values()))

    # 票 06：mapping 前置驗證＋未對應清單——放在掃描之前，帳號掃描要用改名表以
    # 目的地位置判 skip／blocked。專案目錄以 lstat 語意列（symlink 不算）。
    project_dirs: dict[str, list[str]] = {}
    for key in targets:
        pdir = Path(root, "accounts", key, _PROJECTS_DIR)
        project_dirs[key] = sorted(
            c.name for c in pdir.iterdir()
            if c.is_dir() and not c.is_symlink()) if pdir.is_dir() else []
    project_renames = _validate_mapping(list(mapping or []), project_dirs)
    unmapped_projects: list[dict] = []
    for key in sorted(project_dirs):
        for name in project_dirs[key]:
            if name not in project_renames:
                unmapped_projects.append({
                    "account": key,
                    "encoded_dir": name,
                    "old_path": _peek_cwd(
                        Path(root, "accounts", key, _PROJECTS_DIR, name)),
                })

    for key, target in targets.items():
        n, sk, bl, ex = _scan_spot(Path(root, "accounts", key), target,
                                   renames=project_renames)
        will_install += n
        will_skip.extend(sk)
        blocked.extend(bl)
        excluded.extend(ex)
    for name, target in extra_targets.items():
        n, sk, bl, ex = _scan_spot(Path(root, "extra", name), target)
        will_install += n
        will_skip.extend(sk)
        blocked.extend(bl)
        excluded.extend(ex)

    identities = {key: dir_identity(t) for key, t in targets.items()}
    identities.update({f"extra:{name}": dir_identity(t) for name, t in extra_targets.items()})
    return InstallPlan(
        source_root=root,
        source_identity=dir_identity(root),
        targets=targets,
        target_identities=identities,
        extra_targets=extra_targets,
        spot_source_identities=spot_source_identities,
        project_renames=project_renames,
        unmapped_projects=unmapped_projects,
        will_install=will_install,
        will_skip=will_skip,
        blocked=blocked,
        excluded=excluded,
    )


_JOURNAL_PREFIX = "restore-journal-"


def transaction_id(plan: InstallPlan) -> str:
    """同一個實體 staging + 同一組落點 = 同一個 transaction，重跑才接得上前一輪。

    **不能只綁 source_root 路徑**（Codex 票 04 R1）：同一路徑失敗後換一份 bundle 重展、
    或改落點重跑，都會讀到前次殘留的 journal node——journal 記的是「本次發布的 node」，
    跨 bundle／落點沿用等於把舊 provenance 拿來授權新落點的既有內容，推翻整個判準。
    所以綁 `source_identity`（實體 inode，重展即變）＋落點 mapping：三者任一變就是新
    transaction，舊 journal 不被讀。用雜湊：路徑含使用者名與中文，直接當檔名會跳脫問題。"""
    material = "\x00".join([
        plan.source_root,
        repr(plan.source_identity),
        repr(sorted(plan.targets.items())),
        repr(sorted(plan.extra_targets.items())),   # 改 extra 落點也是新 transaction
        # journal node 以改名後的位置記——改 mapping 重跑＝不同 transaction，不讀舊
        # journal（比照落點 mapping 的綁定理由，票 04 R1 F1／票 06）。
        repr(sorted(plan.project_renames.items())),
    ])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def journal_path(transaction_id: str) -> Path:
    """放 ~/.fledge/：不放 staging（唯讀不變式），不放現役目錄（使用者的，不該被
    我們的簿記污染）。它同時是「這次移機還沒收尾」的訊號（ADR-0006）。"""
    return Path.home() / ".fledge" / f"{_JOURNAL_PREFIX}{transaction_id}.jsonl"


def installed_nodes(transaction_id: str) -> set[str]:
    """本 transaction 已確實發布的 node（`<account>/<rel_path>`）。

    **不存在 → 回空集合**（還沒建、或完整成功已清，都是正常）；**存在但讀不出**（權限、
    IO 錯）→ 讓 OSError 往上拋。兩者不可混為一談（Codex 票 04 R1 F3）：把 IO 錯誤當成
    「沒發布過」會讓 symlink 階段靜默略過、清除 gate 又誤判完整成功刪掉續作依據。
    壞行（JSON parse 失敗）仍逐行跳過——那是損壞容錯，與整檔讀不出是兩回事。"""
    path = journal_path(transaction_id)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return set()
    return _parse_journal_nodes(text)


def _parse_journal_nodes(text: str) -> set[str]:
    """JSONL → node 集合。壞行逐行跳過（損壞容錯）。install 第二階段（pread 已 pin 的
    journal fd）與公開 installed_nodes（pathname，給還原卡偵測）共用同一份解析。"""
    nodes: set[str] = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue                        # 壞行跳過：簿記損壞不該讓移機整個失敗
        node = entry.get("node") if isinstance(entry, dict) else None
        if isinstance(node, str):
            nodes.add(node)
    return nodes


def _open_journal_fd(journal: Path) -> int:
    """fd-relative 開 journal，全程 `O_NOFOLLOW`：`~/.fledge` 或 journal 本身被換成 symlink
    時拒絕跟隨——否則 `_record` 會把 JSONL append 到 symlink 指向的任意使用者檔案（Codex
    票 04 R2 F1）。開好 `fstat` 確認是一般檔。從 home fd 逐層下去，O_NOFOLLOW 只擋最後
    元件、父目錄那層要靠 fd-relative 才 pin 得住。"""
    home_fd = os.open(str(Path.home()), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir(".fledge", 0o700, dir_fd=home_fd)
        except FileExistsError:
            pass
        fledge_fd = _open_dir_pinned(".fledge", dir_fd=home_fd)
    finally:
        os.close(home_fd)
    try:
        # O_RDWR（非 O_WRONLY）：第二階段要從這個 pin 住的 fd 用 pread 讀回 provenance，
        # 不重解析 pathname——否則 journal 開啟後被換 symlink，讀取仍會被導向偽 journal
        # 注入授權（Codex 票 04 R3）。O_APPEND 只影響 write，pread 帶 offset 不受它影響。
        fd = os.open(journal.name, os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
                     0o600, dir_fd=fledge_fd)
    finally:
        os.close(fledge_fd)
    st = os.fstat(fd)
    if not stat_module.S_ISREG(st.st_mode):
        os.close(fd)
        raise OSError(errno.EINVAL, "journal is not a regular file")
    return fd


def _record(fd: int, account: str, rel_path: str) -> None:
    """append 一筆並 fsync。

    **順序是「發布成功 → 記錄」，不是 intent-first 的 WAL**：先記「打算裝 X」但實際被
    EEXIST 跳過的話，重跑會把使用者原本就有的 X 誤認成我們裝的——那正是這份簿記要擋的
    東西。代價是 link 與 fsync 之間有極小窗口，崩在那裡的 node 重跑時不被認作本次發布、
    依賴它的 symlink 補不回來。**刻意選的保守方向**：寧可少建一條連結，也不冒認。"""
    line = json.dumps({"node": f"{account}/{rel_path}"}, ensure_ascii=False) + "\n"
    os.write(fd, line.encode("utf-8"))
    os.fsync(fd)


@dataclass
class _PendingLink:
    account: str
    rel_path: str
    literal_target: str


def _open_dir_pinned(name: str, *, dir_fd: int | None = None) -> int:
    """從父 fd 開出子目錄，不跟隨 symlink。開失敗一律讓 OSError 往上拋。

    `O_NOFOLLOW` 讓「這一層是 symlink」直接失敗（macOS 回 ENOTDIR），所以整條路徑上
    沒有任何一層是我們沒看見就跟過去的。"""
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def _require_source_identity(plan: InstallPlan) -> int:
    """開出 staging root fd 並確認它就是 plan 驗過的那個目錄。回 fd，呼叫端負責關。

    **先 open 再 fstat**（順序不能顛倒）：先以 pathname 重驗再 open 的話，中間仍有窗口
    讓 root 被改名再換上另一個同型別目錄——`O_NOFOLLOW` 只拒絕最後元件是 symlink，
    不證明開到的是原 inode。要證明身分，只能對已經開啟的 fd 做 fstat。"""
    fd = _open_dir_pinned(plan.source_root)
    st = os.fstat(fd)
    if (st.st_dev, st.st_ino) != plan.source_identity:
        os.close(fd)
        raise ValueError("source_root_moved")
    return fd


def _read_file_pinned(name: str, dir_fd: int) -> bytes:
    """以 dir_fd 開檔後 fstat 確認型別才讀——不用 pathname 重新解析。

    判型與讀取之間若還經過一次名稱解析，那一刻被換成 symlink 就會讀到 staging 外的檔案。

    `O_NONBLOCK`：scandir 判型之後、open 之前被換成 FIFO 的話，O_RDONLY 會阻塞到有
    writer 為止——加了它 open 立即返回，fstat 照樣把非一般檔擋下（對一般檔是 no-op）。"""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    try:
        st = os.fstat(fd)
        if not stat_module.S_ISREG(st.st_mode):
            raise OSError(errno.EINVAL, "not a regular file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def _install_tree(src_fd: int, dst_fd: int, account: str, rel_prefix: str,
                  results: list[ItemResult], journal_fd: int,
                  pending: list[_PendingLink],
                  rename_children: dict[str, str] | None = None,
                  project_renames: dict[str, str] | None = None) -> None:
    """遞迴安裝一層。symlink 收集起來延到第二階段（票 04：過 provenance 授權才建）。

    `rename_children`＝本層目錄項的目的地改名表（票 06：只有 `projects/` 那一層的
    專案目錄名會換，其餘每層原名照搬）；`project_renames`＝完整改名表，只在從帳號根
    進入 `projects/` 那一步向下傳成 `rename_children`。rel／journal／results 一律記
    **目的地**位置。"""
    for entry in os.scandir(src_fd):
        dst_name = (rename_children or {}).get(entry.name, entry.name)
        rel = os.path.join(rel_prefix, dst_name) if rel_prefix else dst_name
        if entry.name in EXCLUDED_NAMES and not rel_prefix:
            results.append(ItemResult(account, rel, "excluded", "not_migrated_by_design"))
            continue
        if entry.is_symlink():
            # 延到第一階段全部發布完才建，且判準是 provenance（見 _publish_links）。
            pending.append(_PendingLink(account, rel, os.readlink(entry.name, dir_fd=src_fd)))
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                child_src = _open_dir_pinned(entry.name, dir_fd=src_fd)
                try:
                    # 目標目錄不存在才建；已存在不算衝突（目錄本身沒有內容會被覆蓋）。
                    # **只有本次新建的目錄才記進 journal**：symlink 常指向目錄（共通設置
                    # 的 commands／plugins），授權判準要認得出「這個目錄是我們裝的」；
                    # 已存在的目錄是使用者的，記了就等於讓 symlink 能指向現役內容（R4）。
                    try:
                        os.mkdir(dst_name, 0o700, dir_fd=dst_fd)
                        _record(journal_fd, account, rel)
                    except FileExistsError:
                        pass
                    child_dst = _open_dir_pinned(dst_name, dir_fd=dst_fd)
                    try:
                        # 只有帳號根層的 projects/ 那一步把改名表傳成下一層的
                        # rename_children；再往下一律原名（票 06）。
                        child_renames = (project_renames
                                         if not rel_prefix and
                                         entry.name == _PROJECTS_DIR else None)
                        _install_tree(child_src, child_dst, account, rel, results,
                                      journal_fd, pending,
                                      rename_children=child_renames)
                        # durability：link／unlink 的目錄項在斷電後不保證持久，光 fsync
                        # 檔案不夠。粒度取「每個目錄一次」而非每檔兩次——一次還原可能
                        # 上千個小檔，後者成本過高（spec §4.2.5）。
                        with contextlib.suppress(OSError):
                            os.fsync(child_dst)
                    finally:
                        os.close(child_dst)
                finally:
                    os.close(child_src)
                continue
            if not entry.is_file(follow_symlinks=False):
                # 特殊檔（FIFO／socket／device）連 open 都不碰——FIFO 一開就阻塞。
                # plan 的 _walk_account 同樣不數它們，兩邊語意才對得上。
                results.append(ItemResult(account, rel, "excluded", "not_a_regular_file"))
                continue
            data = _read_file_pinned(entry.name, src_fd)
            safe_fs.write_bytes_atomic(data, dst_name, dir_fd=dst_fd,
                                       mode=entry.stat(follow_symlinks=False).st_mode & 0o777)
            _record(journal_fd, account, rel)   # 發布成功才記（不是 intent-first）
            results.append(ItemResult(account, rel, "installed"))
        except FileExistsError:
            results.append(ItemResult(account, rel, "skipped"))
        except OSError as exc:
            logger.error("移機寫入失敗：account=%s rel=%s", account, rel, exc_info=True)
            results.append(ItemResult(account, rel, "failed", safe_fs.error_code(exc)))


def _all_landing_spots(plan: InstallPlan) -> list[tuple[str, str]]:
    """所有落點 (key, target)：帳號用 account key、extra 用 `extra:<name>` 命名空間
    （不與帳號 key 撞——後者是 `^[A-Za-z0-9_-]+$` 不含冒號）。symlink 授權與 install
    的 dst_fd 索引都靠它統一，故 `~/.agents` 的資產能作為 symlink 的授權目標（票 05）。"""
    spots = list(plan.targets.items())
    spots += [(f"extra:{name}", target) for name, target in plan.extra_targets.items()]
    return spots


def _rewrite_home_prefix(path: str, old_home: str, new_home: str) -> str | None:
    """舊 home 底下的路徑換成新 home 的同一相對位置；不在舊 home 底下回 None。

    回 None 代表「無法決定新位置」——ADR-0001 允許 config_dir 是任意路徑，所以沒有
    正確答案可推。**不猜**。"""
    if path == old_home:
        return new_home
    prefix = old_home.rstrip("/") + "/"
    if not path.startswith(prefix):
        return None
    return os.path.join(new_home, path[len(prefix):])


def _authorized_link_target(literal: str, plan: InstallPlan, manifest: dict,
                            installed: set[str]) -> str | None:
    """symlink 的字面目標 → 改寫後的目標路徑；不獲授權回 None。

    授權判準是「對應本次 transaction 確實發布的 node」，**不是 root containment**：
    後者會放行指向 root 內任意既有檔案、root 本身乃至循環的連結，等於把「連回已還原
    的資產」放大成「連到整棵 active config tree 任意位置」（spec §4.2.3）。"""
    # 相對路徑（往上逃逸）與含 `..`／非正規化的絕對路徑一律不處理——不靠「改寫後對不上
    # node」的巧合擋，直接在源頭 fail closed。
    if not os.path.isabs(literal) or os.path.normpath(literal) != literal:
        return None
    old_home = manifest.get("home", "")
    new_home = str(Path.home().resolve())
    rewritten = _rewrite_home_prefix(literal, old_home, new_home) if old_home else None
    if rewritten is None:
        return None
    for key, target in _all_landing_spots(plan):
        if rewritten == target or not is_same_or_within(rewritten, target):
            continue                        # 指向 root 本身也不算（那不是某個 node）
        rel = os.path.relpath(rewritten, target)
        if f"{key}/{rel}" in installed:
            return rewritten
    return None


def _symlink_at(root_fd: int, rel_path: str, target: str) -> None:
    """從 root_fd 逐層 `O_NOFOLLOW` 開到父目錄，再 `os.symlink(dir_fd=父)`。

    **全程不重解析完整 pathname**（Codex 票 04 R1 F2）：第二階段若用
    `plan.targets[account]/rel_path` 這種絕對路徑，target root 或中間目錄在階段間被
    rename＋換成 symlink，`os.symlink` 會跟著中間元件寫到 target 外。root_fd 是第一階段
    驗過身分的 fd（釘 inode，rename 影響不到），逐層 O_NOFOLLOW 讓任一層被換成 symlink
    直接 ENOTDIR 失敗。"""
    parts = rel_path.split(os.sep)
    opened: list[int] = []
    parent_fd = root_fd
    try:
        for part in parts[:-1]:
            parent_fd = _open_dir_pinned(part, dir_fd=parent_fd)
            opened.append(parent_fd)
        os.symlink(target, parts[-1], dir_fd=parent_fd)
    finally:
        for fd in opened:
            os.close(fd)


def _publish_links(pending: list[_PendingLink], plan: InstallPlan,
                   account_dst_fds: dict[str, int], manifest: dict,
                   installed: set[str], results: list[ItemResult]) -> None:
    """第二階段：第一階段全部發布完、journal 記妥之後才建 symlink。"""
    for link in pending:
        root_fd = account_dst_fds.get(link.account)
        if root_fd is None:
            # 該帳號第一階段失敗（target_moved／OSError），沒有可信 root fd → 不建。
            results.append(ItemResult(link.account, link.rel_path, "failed",
                                      "account_not_installed"))
            continue
        target = _authorized_link_target(link.literal_target, plan, manifest, installed)
        if target is None:
            results.append(ItemResult(link.account, link.rel_path, "excluded",
                                      "symlink_target_unauthorized"))
            continue
        try:
            _symlink_at(root_fd, link.rel_path, target)
            results.append(ItemResult(link.account, link.rel_path, "installed"))
        except FileExistsError:
            results.append(ItemResult(link.account, link.rel_path, "skipped"))
        except OSError as exc:
            logger.error("移機建連結失敗：%s", link.rel_path, exc_info=True)
            results.append(ItemResult(link.account, link.rel_path, "failed",
                                      safe_fs.error_code(exc)))


def _open_verified_source(name: str, dir_fd: int, expected: tuple[int, int] | None,
                          key: str, results: list[ItemResult]) -> int | None:
    """開一個落點的來源內容目錄並重驗 plan 時身分。回 fd（呼叫端負責關）；不可用回
    None（該記的 failed 已記）。帳號與 extra 共用（票 05 收尾：同一條不變式一次寫）。

    「install 時狀態＝plan 時狀態」才動手（Codex 票 05 R1 F1）：換成另一個真目錄
    （O_NOFOLLOW 攔不到）、plan 後才出現、plan 看過卻消失皆 `source_moved`；
    None＋ENOENT＝備份包從頭就沒有這份內容，正常靜默。開失敗（symlink、權限）記
    failed——「不存在≠開失敗」（票 04 F3 同款區分）。"""
    try:
        fd = _open_dir_pinned(name, dir_fd=dir_fd)
    except FileNotFoundError:
        if expected is not None:
            results.append(ItemResult(key, "", "failed", "source_moved"))
        return None
    except OSError as exc:
        logger.error("移機來源開啟失敗：key=%s", key, exc_info=True)
        results.append(ItemResult(key, "", "failed", safe_fs.error_code(exc)))
        return None
    st = os.fstat(fd)
    if expected is None or (st.st_dev, st.st_ino) != expected:
        os.close(fd)
        results.append(ItemResult(key, "", "failed", "source_moved"))
        return None
    return fd


@dataclass(frozen=True)
class _PreparedSpot:
    key: str
    target: str
    src_fd: int
    dst_fd: int


def _prepare_spot(key: str, target: str, plan: InstallPlan,
                  results: list[ItemResult]) -> int | None:
    """落點準備（帳號或 extra 共用）：mkdir target → 開 dst_fd → plan 時 target
    identity 重驗（不符 `target_moved`）。回 dst_fd（呼叫端負責關或轉交）；不可用回
    None（該記的 failed 已記）。單一落點失敗只讓它自己 failed、不株連也不讓 OSError
    穿出（票 03 R2）。"""
    dst_fd = None
    try:
        Path(target).mkdir(parents=True, exist_ok=True)
        dst_fd = _open_dir_pinned(target)
        expected = plan.target_identities.get(key)
        st = os.fstat(dst_fd)
        if expected is not None and (st.st_dev, st.st_ino) != expected:
            # 落點已不是 plan 驗過的那個目錄——寫下去就是寫進替身。
            results.append(ItemResult(key, "", "failed", "target_moved"))
            os.close(dst_fd)
            return None
        return dst_fd
    except OSError as exc:
        # 落點被檔案占用、權限被收走等只讓「這個落點」失敗——例外穿出去 route 只接
        # ValueError 會變裸 500，且排序在後的落點全裝不到（票 03 R2）。
        logger.error("移機落點準備失敗：key=%s target=%s", key, target, exc_info=True)
        results.append(ItemResult(key, "", "failed", safe_fs.error_code(exc)))
        if dst_fd is not None:
            os.close(dst_fd)
        return None


def _identity_chain(fd: int) -> list[tuple[int, int]]:
    """fd 的 (st_dev, st_ino) 加上其全部祖先——fd-relative 逐層開 `..`，不經 pathname
    （symlink 換不掉已開的 fd）。到根時 `..` 指向自己即停。"""
    st = os.fstat(fd)
    chain = [(st.st_dev, st.st_ino)]
    cur = os.open("..", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
    try:
        while True:
            st = os.fstat(cur)
            ident = (st.st_dev, st.st_ino)
            if ident == chain[-1]:
                break
            chain.append(ident)
            nxt = os.open("..", os.O_RDONLY | os.O_DIRECTORY, dir_fd=cur)
            os.close(cur)
            cur = nxt
    finally:
        os.close(cur)
    return chain


def _drop_overlapping_spots(prepared: list[_PreparedSpot],
                            results: list[ItemResult]) -> list[_PreparedSpot]:
    """寫入前的 **fd 版**重疊重驗（Codex 票 07 R2）：plan 的字串比對擋不住「plan 後
    才收斂」的落點——APFS 大小寫別名（尚不存在時字串不同、建立後同一實體）與中間
    目錄被換成 symlink 都會讓兩個落點變同一目錄或互為祖先，內容混裝、no-clobber
    靜默 skip。以已開 fd 的 identity 祖先鏈 pairwise 比對，涉入的落點全 failed、
    一個位元組都不寫。

    **這是縮小窗口不是關閉**（票 03／10 的措辭紀律）：比對只反映檢查當下的親緣，
    返回後、寫入中的 rename reparenting（把另一落點搬進本落點的樹）仍是
    check-then-act——該窗口與祖先釘鎖、node 身分重驗同族，收攏在票 09（Codex
    票 07 R3，威脅前提為已擁有兩側寫入權的本機行為者）。"""
    chains: dict[str, list[tuple[int, int]] | None] = {}
    for spot in prepared:
        try:
            chains[spot.key] = _identity_chain(spot.dst_fd)
        except OSError:
            logger.error("移機落點祖先鏈計算失敗：key=%s", spot.key, exc_info=True)
            chains[spot.key] = None          # 算不出 → fail-closed 視同重疊
    bad: set[str] = {k for k, c in chains.items() if c is None}
    for i, a in enumerate(prepared):
        for b in prepared[:i]:
            ca, cb = chains[a.key], chains[b.key]
            if ca is None or cb is None:
                continue
            if ca[0] in cb or cb[0] in ca:   # 同一目錄（鏈頭相等）或互為祖先
                bad.add(a.key)
                bad.add(b.key)
    kept: list[_PreparedSpot] = []
    for spot in prepared:
        if spot.key in bad:
            results.append(ItemResult(spot.key, "", "failed", "overlapping_config_dirs"))
            os.close(spot.dst_fd)
            os.close(spot.src_fd)
        else:
            kept.append(spot)
    return kept


def install(plan: InstallPlan) -> list[ItemResult]:
    """依 plan 把資產寫進各落點。逐項盡力——單項失敗不阻斷其餘。

    來源身分不符即整批停手（不是跳過單項）：那代表我們掃描過的東西已經不是現在要讀的
    東西，繼續下去等於拿沒驗過的內容寫使用者的現役目錄。

    target 側同款 identity 重驗（票 03 R1，比照票 10 的 source 側）：plan 記下當時存在
    的 target 身分，install 開出 fd 後 fstat 比對，不符回 `target_moved`、該帳號停手
    （各帳號的落點彼此獨立，不株連整批）。**這是縮小窗口不是關閉**：比對到 mutation
    之間仍是 check-then-act；plan 時不存在、由 install 新建的 target 沒有基準可比。"""
    src_root_fd = _require_source_identity(plan)
    results: list[ItemResult] = []
    pending: list[_PendingLink] = []        # symlink 收集起來，第一階段全完成才發布
    # 每個帳號第一階段驗過身分的 dst_fd 延到第二階段用——symlink 一律從這個 fd 逐層
    # 開下去建，不重解析 pathname（Codex 票 04 R1 F2：pathname 重解析會被階段間換掉的
    # 中間目錄／target root 導向外部）。fd 釘住的是 inode，rename 影響不到它。
    account_dst_fds: dict[str, int] = {}
    logger.info("移機開始：source=%s targets=%s", plan.source_root, sorted(plan.targets))
    # journal 開在 source 驗證之後、任何寫入之前：它是 symlink 授權與中斷續作的基礎，
    # 開不起來就不該動使用者的目錄——fail closed 回穩定判別碼，不讓 OSError 裸穿。
    journal = journal_path(transaction_id(plan))
    try:
        journal_fd = _open_journal_fd(journal)
    except OSError as exc:
        os.close(src_root_fd)
        raise ValueError("journal_unavailable") from exc
    try:
        try:
            accounts_fd = _open_dir_pinned("accounts", dir_fd=src_root_fd)
        except OSError as exc:
            # plan 之後 accounts/ 被拿掉或換型——bundle 形狀已不成立，映成穩定判別碼
            # 而不是讓 OSError 穿出去變裸 500。
            raise ValueError("source_not_a_bundle") from exc
        try:
            # 準備階段：所有落點（帳號＋extra）先開好 src／dst fd 並各自驗證——寫入
            # 延到全體 fd 版重疊重驗通過之後（Codex 票 07 R2）。fd 釘 inode，準備與
            # 寫入之間的 rename／symlink 置換影響不到已開的 fd。
            prepared: list[_PreparedSpot] = []
            for key, target in plan.targets.items():
                account_fd = _open_verified_source(
                    key, accounts_fd, plan.spot_source_identities.get(key),
                    key, results)
                if account_fd is None:
                    continue
                dst_fd = _prepare_spot(key, target, plan, results)
                if dst_fd is None:
                    os.close(account_fd)
                    continue
                prepared.append(_PreparedSpot(key, target, account_fd, dst_fd))
            # extra（帳號目錄外資產）同一套準備，key 用 extra:<name> 命名空間。
            # 從 src_root_fd 開 extra/——「不存在」是正常（多數備份包沒有），但「存在
            # 而開不了」（被換成 symlink、權限被收走）必須記 failed：靜默跳過會讓
            # 「plan 說會裝」的整組 extra 無聲消失、journal 也被誤清（票 04 F3 的
            # 「不存在≠讀不出」同款區分，票 05）。
            try:
                extra_fd = _open_dir_pinned("extra", dir_fd=src_root_fd)
            except FileNotFoundError:
                extra_fd = None
                # extra/ 不存在：只有「plan 時也不存在」的項目容許靜默；plan 看過的
                # 消失了就是誤報成功的形狀（Codex 票 05 R1 F1）。
                for name in plan.extra_targets:
                    if plan.spot_source_identities.get(f"extra:{name}") is not None:
                        results.append(ItemResult(f"extra:{name}", "", "failed",
                                                  "source_moved"))
            except OSError as exc:
                logger.error("移機 extra/ 開啟失敗", exc_info=True)
                for name in plan.extra_targets:
                    results.append(ItemResult(f"extra:{name}", "", "failed",
                                              safe_fs.error_code(exc)))
                extra_fd = None
            if extra_fd is not None:
                try:
                    for name, target in plan.extra_targets.items():
                        spot_key = f"extra:{name}"
                        item_fd = _open_verified_source(
                            name, extra_fd,
                            plan.spot_source_identities.get(spot_key),
                            spot_key, results)
                        if item_fd is None:
                            continue
                        dst_fd = _prepare_spot(spot_key, target, plan, results)
                        if dst_fd is None:
                            os.close(item_fd)
                            continue
                        prepared.append(_PreparedSpot(spot_key, target, item_fd, dst_fd))
                finally:
                    os.close(extra_fd)
            # 寫入階段：fd 版重疊重驗通過的落點才逐一裝樹。
            for spot in _drop_overlapping_spots(prepared, results):
                try:
                    # 專案改名表只作用於帳號落點——extra 是帳號外資產，沒有 projects/
                    # 語意（extra key 帶 "extra:" 前綴，帳號 key 的正則不含冒號）。
                    _install_tree(spot.src_fd, spot.dst_fd, spot.key, "", results,
                                  journal_fd, pending,
                                  project_renames=(plan.project_renames
                                                   if not spot.key.startswith("extra:")
                                                   else None))
                    # 根層目錄項的斷電持久性掛在這裡（票 03 R1）；目錄 fsync 不受支援時
                    # 降級不整批失敗。
                    with contextlib.suppress(OSError):
                        os.fsync(spot.dst_fd)
                    account_dst_fds[spot.key] = spot.dst_fd   # 轉交第二階段，此處不關
                except OSError as exc:
                    logger.error("移機落點安裝失敗：key=%s target=%s",
                                 spot.key, spot.target, exc_info=True)
                    results.append(ItemResult(spot.key, "", "failed",
                                              safe_fs.error_code(exc)))
                    os.close(spot.dst_fd)
                finally:
                    os.close(spot.src_fd)
            # 第二階段：所有帳號／extra 的一般檔／目錄都發布完、journal 也記妥了，才建 symlink。
            # 授權集合從 journal 重讀（不是本輪記憶體）——中斷續作時前一輪發布的 node
            # 也算數（ADR-0006／spec §4.2.3.1）。
            if pending:
                try:
                    manifest = read_manifest(plan.source_root)
                    # 從 pin 住的 journal_fd 直接 pread 全檔（含前輪 append 的，故中斷續作
                    # 天然涵蓋），**不重解析 pathname**——階段間換 .fledge／journal symlink
                    # 影響不到已開的 fd（Codex 票 04 R3）。
                    size = os.fstat(journal_fd).st_size
                    raw = os.pread(journal_fd, size, 0) if size else b""
                    installed = _parse_journal_nodes(raw.decode("utf-8"))
                except (OSError, ValueError):
                    # provenance 讀不出（journal 可寫不可讀、manifest 階段間被動）→ 降級：
                    # pending 全判 failed（不是 excluded），清除 gate 因此保留 journal。
                    # 靜默略過 symlink 又刪 journal 會誤報成功且永久失去續作依據（F3）。
                    logger.error("移機 symlink 階段 provenance 讀取降級", exc_info=True)
                    for link in pending:
                        results.append(ItemResult(link.account, link.rel_path,
                                                  "failed", "provenance_unavailable"))
                else:
                    _publish_links(pending, plan, account_dst_fds, manifest,
                                   installed, results)
        finally:
            os.close(accounts_fd)
    finally:
        for fd in account_dst_fds.values():
            os.close(fd)
        os.close(journal_fd)
        os.close(src_root_fd)
    logger.info("移機完成：%s", dict(Counter(r.outcome for r in results)))
    # 完整成功才清 journal：它是「這次移機還沒收尾」的訊號（ADR-0006），留著會讓還原卡
    # 永遠顯示「上次移機未完成」。有 failed 則保留——供修好後重跑，中斷續作靠它認得
    # 前一輪已發布的 node（excluded 是刻意拒絕、不算未完成，不阻止清除）。
    if not any(r.outcome == "failed" for r in results):
        with contextlib.suppress(OSError):
            journal.unlink()
    return results

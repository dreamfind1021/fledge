"""Artifact manifest：記錄某次 build 打包了哪些範本，以及對帳用的驗證判定。

存在理由：`.gitignore` 擋得住私有內容進 repo，擋不住它被打包進 shipped binary。
釋出一旦發生就不可逆，所以判定邏輯放在有測試的純函式裡，build 腳本與 CI 只呼叫它。
`source_class` 的唯一真實來源是 `templates.TEMPLATE_SPECS`——manifest 不自行宣告分類。
"""
from __future__ import annotations

import hashlib
import os
import shutil
import stat
from pathlib import Path

from fledge_sidecar.setup.templates import TEMPLATE_SPECS, SourceClass

ARTIFACT_MANIFEST_FILENAME = "artifact-manifest.json"


def _file_digest(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _inventory(root: str) -> tuple[list[str], list[str], list[str]]:
    """以 lstat 盤點目錄樹，回 (檔案, 目錄, 非常規物件) 三份相對路徑清單。

    不用 `os.walk` 的預設行為就好的原因：走訪必須看得見**空目錄**與 **symlink**。
    `os.walk` 會把 symlink 目錄放進 dirnames 卻不遞迴，等於安靜地跳過——對「盤點
    artifact 內到底有什麼」而言，安靜跳過就是漏洞。"""
    files: list[str] = []
    dirs: list[str] = []
    others: list[str] = []
    stack = [root]
    while stack:
        current = stack.pop()
        for name in sorted(os.listdir(current)):
            full = os.path.join(current, name)
            rel = os.path.relpath(full, root)
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                others.append(rel)                 # symlink 一律列為違規物件
            elif stat.S_ISDIR(st.st_mode):
                dirs.append(rel)
                stack.append(full)
            elif stat.S_ISREG(st.st_mode):
                files.append(rel)
            else:
                others.append(rel)                 # fifo/socket/device
    return sorted(files), sorted(dirs), sorted(others)


def stage_templates(public_root: str, private_root: str | None, dest_root: str) -> list[str]:
    """把範本內容複製到 staging 目錄，回實際帶入的 id 清單。

    來源樹先整棵盤點：出現任何 symlink 或非常規物件就**直接失敗**，不做「跳過就好」
    ——安靜略過會產出一個少檔案但驗證照樣通過的 artifact。這也是不能交給
    `rsync -a --no-links` 的原因：它遇到 symlink 只印警告、exit code 仍是 0（已實測）。
    private_root 為 None 時完全不碰私有內容（public-mode）。"""
    if os.path.isdir(dest_root):
        shutil.rmtree(dest_root)
    os.makedirs(dest_root)
    spec_by_id = {s.id: s for s in TEMPLATE_SPECS}
    included: list[str] = []

    sources: list[tuple[str, SourceClass]] = [(public_root, "public")]
    if private_root is not None:
        sources.append((private_root, "private"))

    for root, expected_class in sources:
        if not os.path.isdir(root):
            raise ValueError(f"範本來源目錄不存在：{root}")
        for name in sorted(os.listdir(root)):
            src = os.path.join(root, name)
            if not os.path.isdir(src) or os.path.islink(src):
                raise ValueError(f"範本來源根目錄只能有範本目錄，發現：{name}")
            spec = spec_by_id.get(name)
            if spec is None:
                raise ValueError(f"範本 id 不在 allowlist：{name}")
            if spec.source_class != expected_class:
                # public 目錄放 private 範本（或反之）＝分類與實際來源脫節，直接擋
                raise ValueError(
                    f"{name}：allowlist 分類為 {spec.source_class}，卻放在 {expected_class} 來源")
            if name in included:
                raise ValueError(f"{name}：public 與 private 來源都有同一個 id")
            _, _, others = _inventory(src)
            if others:
                raise ValueError(f"{name}：來源樹含 symlink 或非常規物件 {others}")
            shutil.copytree(src, os.path.join(dest_root, name), symlinks=False)
            included.append(name)
    return sorted(included)


def build_artifact_manifest(staged_root: str, included_ids: list[str]) -> dict:
    """列出**所有**已知範本（不只 included 的）與其分類、是否打包、實際檔案與雜湊。
    全部列出是刻意的：驗證端才分得出「沒帶」與「漏登記」。
    目錄也要登記——空目錄不列的話，artifact 裡多一個空目錄就沒人看得見。"""
    templates: list[dict] = []
    for spec in TEMPLATE_SPECS:
        included = spec.id in included_ids
        files: list[dict] = []
        dirs: list[str] = []
        if included:
            template_dir = os.path.join(staged_root, spec.id)
            if not os.path.isdir(template_dir):
                # 呼叫端給的 included 清單與 staged 實況不符（例如 build 腳本改壞）。
                # 不擋的話會從 _inventory 深處噴 FileNotFoundError，看不出是什麼問題；
                # verify_artifact 也把這個狀態當成一種違規，兩邊態度要一致。
                raise ValueError(f"{spec.id}：宣稱要打包但 staged 內沒有這個目錄")
            found_files, dirs, others = _inventory(template_dir)
            if others:
                raise ValueError(f"{spec.id}：staged 內含 symlink 或非常規物件 {others}")
            files = [{"path": rel, "sha256": _file_digest(os.path.join(template_dir, rel))}
                     for rel in found_files]
        templates.append({
            "id": spec.id,
            "source_class": spec.source_class,
            "included": included,
            "files": files,
            "dirs": dirs,
        })
    return {"templates": templates}


def verify_artifact(staged_root: str, manifest: dict, allow_private: bool) -> list[str]:
    """對帳 staged 內容與 manifest。回違規描述清單（空=通過）。

    fail-closed：manifest 缺欄位／分類與 allowlist 不符／雙向不符／雜湊對不上／
    出現任何未登記的物件，一律算違規，不給預設值也不做寬容解讀。"""
    violations: list[str] = []
    entries = manifest.get("templates") if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not entries:
        return ["artifact manifest 缺少 templates 清單或格式錯誤"]

    spec_by_id = {s.id: s for s in TEMPLATE_SPECS}
    seen_ids: set[str] = set()
    for item in entries:
        if not isinstance(item, dict):
            violations.append("templates 內含非物件項目")
            continue
        tid = item.get("id")
        source_class = item.get("source_class")
        included = item.get("included")
        spec = spec_by_id.get(tid) if isinstance(tid, str) else None
        if spec is None:
            violations.append(f"未知範本 id：{tid}")
            continue
        if tid in seen_ids:
            violations.append(f"{tid}：artifact manifest 內重複登記")
            continue
        seen_ids.add(tid)
        # 分類必須與 allowlist **相等**，不是「是個合法值」就好——否則把 private
        # 改標成 public 就能通過 public-mode 驗證，整道閘等於不存在。
        if source_class != spec.source_class:
            violations.append(
                f"{tid}：source_class 與 allowlist 不符（manifest={source_class!r}、"
                f"allowlist={spec.source_class!r}）")
            continue
        if not isinstance(included, bool):
            violations.append(f"{tid}：included 必須是布林")
            continue
        if included and spec.source_class == "private" and not allow_private:
            violations.append(f"{tid}：public build 不得包含 private 範本")

        # **schema 驗證必須在目錄存在與否之前**：先看目錄再驗欄位的話，
        # included=false 的記錄會整段跳過驗證（目錄不存在就 continue），
        # 等於把 files/dirs 刪掉或塞成字串都能過——fail-open。
        declared_files = item.get("files")
        declared_dirs = item.get("dirs")
        if not isinstance(declared_files, list) or not isinstance(declared_dirs, list):
            violations.append(f"{tid}：files／dirs 欄位缺漏或格式錯誤")
            continue
        # dirs 逐項驗型別：混進 dict／list 會讓下面的 set() 拋 TypeError，
        # 破壞「本函式只回違規清單、不拋例外」的合約
        if any(not isinstance(d, str) for d in declared_dirs):
            violations.append(f"{tid}：dirs 內含非字串項目")
            continue
        if len(set(declared_dirs)) != len(declared_dirs):
            violations.append(f"{tid}：dirs 內有重複項目")
            continue
        if not included and (declared_files or declared_dirs):
            violations.append(f"{tid}：included=false 的記錄必須帶空的 files 與 dirs")
            continue

        template_dir = os.path.join(staged_root, tid)
        if not os.path.isdir(template_dir):
            if included:
                violations.append(f"{tid}：manifest 標 included=true 但 artifact 內沒有這個目錄")
            continue
        if not included:
            # 標了 included=false，目錄本身就不該存在。只檢查「有沒有內容」的話，
            # 一個空的 dev-methodology/ 目錄會通過——留著它等於留一個沒人看管的位置。
            violations.append(f"{tid}：manifest 標 included=false 但 artifact 內有這個目錄")
            continue
        actual_files, actual_dirs, others = _inventory(template_dir)
        for bad in others:
            violations.append(f"{tid}：artifact 內有 symlink 或非常規物件 {bad}")

        by_path: dict[str, str] = {}
        for f in declared_files:
            if (not isinstance(f, dict) or not isinstance(f.get("path"), str)
                    or not isinstance(f.get("sha256"), str)):
                violations.append(f"{tid}：files 內含格式錯誤的項目")
                continue
            if f["path"] in by_path:
                violations.append(f"{tid}：files 內重複登記 {f['path']}")
                continue
            by_path[f["path"]] = f["sha256"]

        for missing in sorted(set(by_path) - set(actual_files)):
            violations.append(f"{tid}：manifest 列出但 artifact 內不存在 {missing}")
        for extra in sorted(set(actual_files) - set(by_path)):
            violations.append(f"{tid}：artifact 內有未登記的檔案 {extra}")
        for missing_dir in sorted(set(declared_dirs) - set(actual_dirs)):
            violations.append(f"{tid}：manifest 列出但 artifact 內不存在目錄 {missing_dir}")
        for extra_dir in sorted(set(actual_dirs) - set(declared_dirs)):
            violations.append(f"{tid}：artifact 內有未登記的目錄 {extra_dir}")
        # 逐檔重算雜湊：只比路徑集合的話，內容被抽換完全看不出來
        for rel in sorted(set(by_path) & set(actual_files)):
            actual_digest = _file_digest(os.path.join(template_dir, rel))
            if actual_digest != by_path[rel]:
                violations.append(f"{tid}：{rel} 內容與 manifest 雜湊不符")

    for tid in sorted(set(spec_by_id) - seen_ids):
        violations.append(f"{tid}：未出現在 artifact manifest（缺席視為違規）")

    # staged 根目錄採**白名單 schema**：只允許已知範本目錄 + 唯一一個 artifact manifest。
    # 其餘一律違規——包含根層檔案、隱藏檔、空目錄、symlink。只檢查「含檔案的
    # 未知目錄」的話，等於根層放一個 secret.txt 完全掃不到。
    if os.path.isdir(staged_root):
        for name in sorted(os.listdir(staged_root)):
            full = os.path.join(staged_root, name)
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                violations.append(f"staged 根目錄不得有 symlink：{name}")
            elif stat.S_ISDIR(st.st_mode):
                if name not in spec_by_id:
                    violations.append(f"artifact 內有不在 allowlist 的範本目錄：{name}")
            elif name != ARTIFACT_MANIFEST_FILENAME:
                violations.append(f"staged 根目錄不得有其他檔案：{name}")
            elif not stat.S_ISREG(st.st_mode):
                # 只比名字的話，一個叫 artifact-manifest.json 的 FIFO 也會過
                violations.append(f"{ARTIFACT_MANIFEST_FILENAME} 必須是一般檔案")
    return violations


__all__ = [
    "ARTIFACT_MANIFEST_FILENAME",
    "build_artifact_manifest",
    "stage_templates",
    "verify_artifact",
]

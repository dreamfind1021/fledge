#!/usr/bin/env python3
"""驗 CI 打出來的發版成品（票 54）：發版時由負責發版的 session 跑，rc 與正式版各一次。

    sidecar/.venv/bin/python admin/verify_release.py \\
      --app <新版 Fledge.app> --tag vX.Y.Z[-rc.N] --control <上一版 Fledge.app> \\
      --fp 模組:字串 [--fp 模組:字串 ...] \\
      --release-dir <gh release download 的目錄> \\
      --prev-manifest <上一版的 templates-artifact-manifest.json>

每項印一行「過／失敗」，最後一行「全部通過」或「有 N 項失敗」。結束碼：全過 0、有失敗 1、參數錯 2。
用 sidecar 的 venv 跑：讀成品的 PYZ 要 import PyInstaller（`sidecar/pyproject.toml` 宣告的依賴）。

CI（`.github/workflows/release.yml`）已驗簽章身分、sidecar 啟動、範本子樹；這裡補 CI 做不到的三類：
跟上一版比、跟 git 原始檔逐位元組比、下載之後再驗。設計見
`docs/superpowers/specs/2026-11-17-verify-release-script-design.md`。

發版時的步驟：
1. `gh release download <tag> -D <新的空目錄>`（要 dangerouslyDisableSandbox）。dmg 也要下載：它的雜湊要真的驗過。
2. 在另一個新的空目錄解開 `Fledge_aarch64.app.tar.gz`，得到新版 `Fledge.app`。
3. 對照組：先讀 `/Applications/Fledge.app/Contents/Info.plist` 的版本，是上一版就用它；
   不是就下載上一版的 `Fledge_aarch64.app.tar.gz` 解開來用。
4. 上一版的範本清單：`gh release download v<上一版> -p templates-artifact-manifest.json -D <目錄>`。
5. 挑指紋：sidecar 改了就挑「上一版 tag 裡 `git grep` 為 0、這一版有」的名字；沒改就用
   `fledge_sidecar:<新版號>`。
6. 跑本腳本，`--tag` 用第 1 步同一個字串。正式版是 CI 重新打包的，要再跑一次。

改了本腳本時，照 spec §7.1 拿真成品實跑三組（正向全過／新舊對調要失敗／兩版都有的指紋要失敗）。
"""
from __future__ import annotations

import argparse
import functools
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent

MAIN = "Contents/MacOS/fledge"
SIDECAR = "Contents/Resources/fledge-sidecar/fledge-sidecar"
SCRIPTS_DIR = "Contents/Resources/fledge-sidecar/_internal/scripts"
# ＝`sidecar/build_binary.sh` 裡目的是 scripts 的 --add-data。刻意寫死、不從 build_binary.sh 推：
# 驗收的預期要獨立於被驗的東西——宣告被誤刪時，推出來的預期會跟著少一個、成品也同步少，比對全過（spec §4.3）。
PACKAGED_SCRIPTS = ("backup-claude.sh", "backup-extra-paths.txt", "restore-claude.sh", "expansion_guard.py")
TAG_RE = re.compile(r"^v(\d+\.\d+\.\d+)(?:-rc\.\d+)?$")
# 讀取自我檢查：每一版的 fledge_sidecar/__init__.py 都有這個名字。「對照組不含」只有在對照組真的讀得到內容時才有意義。
SANITY_MODULE, SANITY_NEEDLE = "fledge_sidecar", b"__version__"

Row = tuple[bool, str, str]  # (過不過, 項目, 細節)


def run_cmd(cmd: list[str], cwd: str | None = None) -> tuple[int, str]:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def open_real_pyz(sidecar: str):
    from PyInstaller.archive.readers import CArchiveReader  # 只有讀真成品才需要，測試不 import

    arch = CArchiveReader(sidecar)
    names = [n for n, entry in arch.toc.items() if entry[-1] == "z"]
    if len(names) != 1:
        raise ValueError(f"找不到唯一的 PYZ（{len(names)} 個）")
    return arch.open_embedded_archive(names[0])


def _row(label: str, fn) -> Row:
    """算一行。出錯只讓這一行失敗，其他項照驗、最後一行照印（spec §4）。"""
    try:
        ok, detail = fn()
    except Exception as exc:  # noqa: BLE001 — 任何錯都只能變成「失敗」那一行
        return (False, label, f"出錯：{exc}")
    return (bool(ok), label, detail)


def _plist(app: str) -> dict:
    with open(os.path.join(app, "Contents/Info.plist"), "rb") as fh:
        return plistlib.load(fh)


def _short_version(app: str) -> str:
    v = _plist(app).get("CFBundleShortVersionString")
    if not v:  # 讀不到版本不能當成「跟新版不同」
        raise ValueError("Info.plist 沒有 CFBundleShortVersionString")
    return v


def check_version(app: str, control: str, version: str) -> list[Row]:
    def new():
        v = _short_version(app)
        return v == version, v

    def ctl():
        v = _short_version(control)
        return v != version, v

    return [_row(f"新版 Info.plist 版本＝{version}", new), _row(f"對照組不是 {version}", ctl)]


def authority(app: str, run) -> list[str]:
    _, out = run(["codesign", "-dvv", app])
    return sorted(set(re.findall(r"^Authority=(.*)$", out, re.M)))


def minos(binary: str, run) -> list[str]:
    _, out = run(["vtool", "-show-build", binary])
    return re.findall(r"minos (\S+)", out)


def check_signing(app: str, control: str, run) -> list[Row]:
    def auth():
        a = authority(app, run)
        return bool(a) and a == authority(control, run), " / ".join(a) or "空的"

    def lsmin():
        a = _plist(app).get("LSMinimumSystemVersion")
        return bool(a) and a == _plist(control).get("LSMinimumSystemVersion"), str(a)

    def mos(rel):
        def fn():
            m = minos(os.path.join(app, rel), run)
            return bool(m) and m == minos(os.path.join(control, rel), run), ",".join(m) or "空的"
        return fn

    return [
        _row("codesign Authority 與對照組相同", auth),
        _row("LSMinimumSystemVersion 與對照組相同", lsmin),
        *(_row(f"{rel} 的 minos 與對照組相同", mos(rel)) for rel in (MAIN, SIDECAR)),
    ]


def _git_show(repo: Path, tag: str, path: str) -> bytes:
    r = subprocess.run(["git", "-C", str(repo), "show", f"{tag}:{path}"], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace").strip())
    return r.stdout


def _sha12(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:12]


def check_scripts(app: str, tag: str, repo: Path) -> list[Row]:
    d = Path(app) / SCRIPTS_DIR

    def same(name):
        def fn():
            want = _git_show(repo, tag, f"scripts/{name}")
            if not (d / name).is_file():
                return False, "不存在"
            got = (d / name).read_bytes()
            return got == want, _sha12(got) if got == want else f"成品 {_sha12(got)}／{tag} {_sha12(want)}"
        return fn

    def no_extra():
        if not d.is_dir():
            return False, "目錄不存在"
        files = sorted(str(p.relative_to(d)) for p in d.rglob("*") if p.is_file())
        extra = [f for f in files if f not in PACKAGED_SCRIPTS]
        if extra:
            return False, f"多了 {'、'.join(extra)}（打包清單加了新檔的話，PACKAGED_SCRIPTS 要一起加）"
        return True, f"{len(files)} 個檔"

    return [_row(f"成品的 scripts/{n} 與 {tag} 相同", same(n)) for n in PACKAGED_SCRIPTS] + [
        _row("成品 scripts/ 沒有清單外的檔", no_extra)
    ]


def _module_bytes(pyz, module: str) -> bytes | None:
    """模組 zlib 解壓後的內容（raw=True，不 unmarshal：成品是 3.12 編的，本機 venv 版本不同會 segfault）。

    PYZ 目錄裡沒有這個模組 → None，這是唯一算「不含」的情況。namespace package（extract 回 None）
    或其他任何錯 → 丟例外，由 _row 判失敗——讀不開不能當成沒有（spec §4.4）。"""
    if isinstance(pyz, BaseException):  # 打開那一步就失敗了；包成一般錯誤，SystemExit 才不會穿過 _row
        raise RuntimeError(f"sidecar 打不開：{pyz}") from None
    try:
        raw = pyz.extract(module, raw=True)
    except KeyError:
        return None
    except SystemExit as exc:  # PyInstaller 讀檔時執行檔不見了會丟 SystemExit（不屬於 Exception），會穿過 _row
        raise RuntimeError(f"讀 PYZ 時中止：{exc}") from None
    if raw is None:
        raise ValueError(f"{module} 是 namespace package，沒有內容可搜")
    return raw


def check_fingerprints(app: str, control: str, fps: list[tuple[str, str]], open_pyz) -> list[Row]:
    pyz = {}
    for side, path in (("新版", app), ("對照組", control)):
        try:
            pyz[side] = open_pyz(os.path.join(path, SIDECAR))
        except (Exception, SystemExit) as exc:  # noqa: BLE001 — 打不開的那一邊，後面每一行用到它都判失敗
            pyz[side] = exc

    def sanity(side):
        def fn():
            raw = _module_bytes(pyz[side], SANITY_MODULE)
            if raw is None:
                return False, f"PYZ 裡沒有 {SANITY_MODULE}"
            return SANITY_NEEDLE in raw, ""
        return fn

    def fingerprint(module, needle):
        def fn():
            new = _module_bytes(pyz["新版"], module)
            if new is None:
                return False, "新版抽不出模組（PYZ 裡沒有）"
            if needle.encode() not in new:
                return False, "新版不含"
            ctl = _module_bytes(pyz["對照組"], module)
            if ctl is not None and needle.encode() in ctl:
                return False, "對照組也有，不是這次才有的東西"
            return True, "新版有、對照組沒有" if ctl is not None else "新版有、對照組沒有這個模組"
        return fn

    label = f"PYZ 讀得到內容（{SANITY_MODULE} 含 {SANITY_NEEDLE.decode()}）"
    return [_row(f"{side}的 {label}", sanity(side)) for side in ("新版", "對照組")] + [
        _row(f"指紋 {m}:{n}", fingerprint(m, n)) for m, n in fps
    ]


def _included(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    items = d.get("templates", d) if isinstance(d, dict) else d
    return {t["id"]: t["included"] for t in items}


SHASUM = ["shasum", "-a", "256", "-c", "checksums.txt", "--ignore-missing"]


def check_release_dir(release_dir: str, version: str, prev_manifest: str, run) -> list[Row]:
    @functools.cache  # 雜湊與 dmg 兩項看同一次的結束碼與輸出；跑失敗丟出的例外不會被快取，兩項各自判失敗
    def shasum():
        return run(SHASUM, cwd=release_dir)

    def checksums():
        code, out = shasum()
        oks = out.count(": OK")
        return code == 0 and oks >= 1, f"{oks} 個 OK"

    dmg = f"Fledge_{version}_aarch64.dmg"

    def dmg_verified():
        # 不自己解析 checksums.txt，只看 shasum 有沒有真的驗過這一版的 dmg：shasum 會略過註解、格式不對的行，
        # 也把檔名尾端的空白算進檔名、找不到就略過，照樣回 0——自己解析被 plan 審查連抓兩次這種漏洞。
        # 保證範圍是手誤（下載錯版本、漏下載 dmg），不含刻意偽造的檔名（例：檔名夾換行，讓輸出多出一行
        # 「…dmg: OK」）——能把那種檔放進 Release 的人也改得了 checksums.txt，這裡本來就擋不住（使用者定的）
        _, out = shasum()
        ok = [ln[: -len(": OK")] for ln in out.splitlines() if ln.endswith(": OK")]
        return dmg in ok, "、".join(ok) or "沒有任何檔驗過"

    def manifest():
        new = _included(os.path.join(release_dir, "templates-artifact-manifest.json"))
        old = _included(prev_manifest)
        if not new and not old:
            return False, "兩邊都是空的"
        if new == old:
            return True, f"{sum(new.values())}/{len(new)} 收錄"
        diff = [f"多了 {k}" for k in sorted(new.keys() - old.keys())]
        diff += [f"少了 {k}" for k in sorted(old.keys() - new.keys())]
        diff += [f"{k} 的 included 變了" for k in sorted(new.keys() & old.keys()) if new[k] != old[k]]
        return False, "、".join(diff)

    return [
        _row("checksums.txt 雜湊相符", checksums),
        _row(f"{dmg} 的雜湊驗過", dmg_verified),
        _row("範本清單 {id: included} 與上一版相同", manifest),
    ]


def _tag(s: str) -> str:
    if not TAG_RE.match(s):
        raise argparse.ArgumentTypeError(f"要是 vX.Y.Z 或 vX.Y.Z-rc.N：{s!r}")
    return s


def _fp(s: str) -> tuple[str, str]:
    module, sep, needle = s.partition(":")
    if not (sep and module and needle):
        raise argparse.ArgumentTypeError(f"要是 模組:字串：{s!r}")
    return module, needle


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="驗 CI 打出來的發版成品（票 54）")
    ap.add_argument("--app", required=True)
    ap.add_argument("--tag", required=True, type=_tag)
    ap.add_argument("--control", required=True)
    ap.add_argument("--fp", required=True, action="append", type=_fp)
    ap.add_argument("--release-dir", required=True)
    ap.add_argument("--prev-manifest", required=True)
    return ap.parse_args(argv)


def verify(a: argparse.Namespace, *, run=run_cmd, open_pyz=open_real_pyz, repo: Path = _REPO) -> list[Row]:
    version = TAG_RE.match(a.tag).group(1)
    return (
        check_version(a.app, a.control, version)
        + check_signing(a.app, a.control, run)
        + check_scripts(a.app, a.tag, repo)
        + check_fingerprints(a.app, a.control, a.fp, open_pyz)
        + check_release_dir(a.release_dir, version, a.prev_manifest, run)
    )


def main(argv: list[str] | None = None, *, run=run_cmd, open_pyz=open_real_pyz, repo: Path = _REPO) -> int:
    rows = verify(parse_args(argv), run=run, open_pyz=open_pyz, repo=repo)
    for ok, label, detail in rows:
        print(("過    " if ok else "失敗  ") + label + (f"（{detail}）" if detail else ""))
    fails = sum(not ok for ok, _, _ in rows)
    print("全部通過" if not fails else f"有 {fails} 項失敗")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""驗證打包出來的範本與 artifact manifest 相符，且 public build 不含 private 範本。

判定邏輯全在 `fledge_sidecar.setup.template_manifest`（有單元測試）；本檔只負責
讀檔、串接與 exit code。fail-closed：任何違規、任何讀不到，都 exit 1。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from fledge_sidecar.setup.template_manifest import verify_artifact  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--staged-root", required=True, help="打包後的範本根目錄")
    parser.add_argument("--manifest", required=True, help="artifact-manifest.json 路徑")
    parser.add_argument("--allow-private", action="store_true",
                        help="自用 build 才用；CI/release 一律不得帶")
    args = parser.parse_args()

    try:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"無法讀取 artifact manifest：{exc}", file=sys.stderr)
        return 1

    violations = verify_artifact(args.staged_root, manifest, allow_private=args.allow_private)
    if violations:
        print("範本 artifact 驗證失敗：", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1
    print("範本 artifact 驗證通過")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

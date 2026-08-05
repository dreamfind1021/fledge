#!/usr/bin/env bash
# 同步 5 處版本來源到 X.Y.Z（prerelease 只放 git tag、不進這些檔；spec §3.3）。
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?usage: bump-version.sh X.Y.Z}"
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo "version 必須是 X.Y.Z（prerelease 只放 git tag）"; exit 1; }

# JSON：用 sed 只換 "version" 那行，避免 json.dump 重排格式（inline object 問題）
sed -i '' -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
sed -i '' -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" package.json
# Cargo.toml / pyproject.toml：只有 [package]/[project] 的 version 在行首（deps 的 version 不在行首）
sed -i '' -E "s/^version = \"[^\"]+\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
sed -i '' -E "s/^version = \"[^\"]+\"/version = \"$VERSION\"/" sidecar/pyproject.toml
# 第 5 處：sidecar 套件的 __version__——/api/health 回的版本取自這裡，漏掉它，後端自報的
# 版本會與 app 顯示的（tauri.conf.json）各說各話。只換左半，行尾若加了 updater 註解不受影響
sed -i '' -E "s/^__version__ = \"[^\"]+\"/__version__ = \"$VERSION\"/" sidecar/fledge_sidecar/__init__.py
echo "Bumped 5 version sources to $VERSION"

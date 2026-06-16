#!/usr/bin/env bash
# 偵錯打包：帶 devtools（Web Inspector）的 Fledge.app，給「只有打包版重現、dev 正常」的
# prod-only bug 蒐證用（在打包版的 webview 開 console/network/sources）。
#
# 與正式 build 的唯一差別＝ tauri build 多帶 `--features devtools`（見 src-tauri/Cargo.toml
# 的 [features] devtools = ["tauri/devtools"]）。正式 build 不帶此 feature → 不外洩 devtools。
# 啟動後 app 會自動開 Web Inspector（src-tauri/src/lib.rs 的 cfg(feature="devtools") 區塊）。
#
# 用法：scripts/build-app-devtools.sh
# 產出：src-tauri/target/release/bundle/macos/Fledge.app（帶 devtools）
#
# 注意：只出 .app（--bundles app），避開 macOS Tahoe 本機 dmg build 失敗（見 memory
# fledge-desktop-packaging-branch）。蒐證完用正式流程重打包即還原無 devtools 版。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1/2 打包 sidecar binary（onedir + ad-hoc 簽 → src-tauri/binaries/）==="
( cd sidecar && ./build_binary.sh )

echo ""
echo "=== 2/2 tauri build（--features devtools，只出 .app）==="
npm run tauri -- build --bundles app --features devtools

echo ""
echo "✅ 完成：src-tauri/target/release/bundle/macos/Fledge.app（帶 devtools，啟動自動開 Inspector）"
echo "   open src-tauri/target/release/bundle/macos/Fledge.app"

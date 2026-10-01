#!/usr/bin/env bash
# 打包前檢查：tauri.conf.json 指定的簽章憑證在不在鑰匙圈裡（票 22）。
#
# 定位是「友善的錯誤訊息」，不是防線。真正讓沒有憑證時打包失敗的，是 tauri.conf.json 的
# bundle.macOS.signingIdentity——codesign 找不到身分就會失敗。這支只讓最常用的 `tauri build`
# 一開始就用看得懂的話停下來，而不是編譯幾分鐘後丟一句 codesign 原文。
# `tauri bundle`、`--no-sign`、`--config` 都不經過這裡（spec §6）。
#
# 為什麼要擋：同一台 Mac 上只要執行過一次簽章不同的 Fledge，TCC 就會「記下拒絕」蓋掉
# 正式版的完整磁碟取用授權（票 22 驗證結果），而且是無聲、延後才發現的。
#
# 由 tauri.conf.json 的 build.beforeBuildCommand 與 scripts/build-app-devtools.sh 呼叫。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/src-tauri/tauri.conf.json"

warn_other_identity() {
  echo "⚠ 本次用「${1}」簽章，和正式版不是同一個簽章。" >&2
  echo "  在同一台 Mac 上執行這份 Fledge，會讓正式版的完整磁碟取用授權失效" >&2
  echo "  （系統設定裡的開關會變成關，要再打開一次）。" >&2
}

# 有設環境變數就照它簽（Tauri 會用它蓋過設定檔）；設了卻是空字串時 Tauri 會把空字串交給
# codesign，錯誤訊息看不懂，這裡先擋。
if [ -n "${APPLE_SIGNING_IDENTITY+set}" ]; then
  if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
    echo "✗ APPLE_SIGNING_IDENTITY 設了但是空的。要改用 ad-hoc 請設成 -：" >&2
    echo "  APPLE_SIGNING_IDENTITY=- npm run tauri build" >&2
    exit 1
  fi
  warn_other_identity "$APPLE_SIGNING_IDENTITY"
  exit 0
fi

# 名稱只寫在 tauri.conf.json 一處；沒寫等同 ad-hoc
NAME=$(python3 -c '
import json, sys
conf = json.load(open(sys.argv[1], encoding="utf-8"))
print(((conf.get("bundle") or {}).get("macOS") or {}).get("signingIdentity") or "-")
' "$CONF")

if [ "$NAME" = "-" ]; then
  warn_other_identity "ad-hoc（-）"
  exit 0
fi

# 不加 -v：自建憑證會被標成未受信任，不在 Valid 段，但能簽（票 22 驗證結果）。
# 比對連同前後引號，避免 "Fledge Self-Signed (old)" 被當成找到。
IDS=$(security find-identity -p codesigning)
if grep -Fq "\"$NAME\"" <<<"$IDS"; then
  exit 0
fi

echo "✗ 找不到簽章憑證「${NAME}」（src-tauri/tauri.conf.json 的 bundle.macOS.signingIdentity）。" >&2
echo "" >&2
echo "只是想自己打包來用：改用 ad-hoc 簽章" >&2
echo "  APPLE_SIGNING_IDENTITY=- npm run tauri build" >&2
echo "  注意：ad-hoc 版和正式版不是同一個簽章。在同一台 Mac 上執行它，會讓正式版的" >&2
echo "  完整磁碟取用授權失效（系統設定裡的開關會變成關，要再打開一次）。" >&2
echo "" >&2
echo "維護者：照 docs/guides/signing-certificate.md（只在維護者本機）從密碼管理器把憑證匯入登入鑰匙圈。" >&2
exit 1

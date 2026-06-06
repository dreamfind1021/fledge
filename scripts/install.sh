#!/usr/bin/env bash
# Fledge 終端機安裝（macOS Apple Silicon）。裝 .app.tar.gz（終端機下載不打 quarantine、未簽章也乾淨啟動）。
# 用 bash + pipefail（非 /bin/sh）——curl|grep|sed 抓 tag 失敗才會被 set -e 接住。
set -euo pipefail
OWNER="dreamfind1021"; REPO="fledge"   # 單一來源
ASSET="Fledge_aarch64.app.tar.gz"; APP="Fledge.app"; INSTALL_DIR="/Applications"; VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?}"; shift 2 ;;      # 指定已 published 的 (pre)release（draft 不可）
    --install-dir) INSTALL_DIR="${2:?}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --version 若有，須為 vX.Y.Z 或 vX.Y.Z-rc.N（否則錯誤會被誤歸成 asset 不存在）
if [ -n "$VERSION" ]; then
  echo "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
    || { echo "--version 格式須為 vX.Y.Z 或 vX.Y.Z-rc.N" >&2; exit 2; }
fi

# arch guard：只支援 Apple Silicon。Rosetta 下 uname -m 回 x86_64，會誤拒支援平台——
# 用 sysctl.proc_translated 判斷「其實是 arm64 跑在 Rosetta」就放行（Codex PR-gate High）。
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
  if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    : # Rosetta 翻譯中、底層其實是 Apple Silicon → 放行
  else
    echo "Fledge 目前只支援 Apple Silicon (arm64)，偵測到 $ARCH" >&2; exit 1
  fi
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
API="https://api.github.com/repos/$OWNER/$REPO/releases"
if [ -n "$VERSION" ]; then TAG="$VERSION"
  # || true：pipefail 下 grep 無命中(rate-limit/錯誤)會殺腳本，加這個讓 TAG 設空、由下行 guard 給友善錯誤
else TAG=$(curl -fsSL "$API/latest" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name" *: *"([^"]+)".*/\1/' || true); fi
[ -n "${TAG:-}" ] || { echo "找不到 release（API rate limit？repo 非 public？）" >&2; exit 1; }

BASE="https://github.com/$OWNER/$REPO/releases/download/$TAG"
echo "下載 $TAG ..."
curl -fSL "$BASE/$ASSET" -o "$TMP/$ASSET" || { echo "下載 $ASSET 失敗（asset 不存在？）" >&2; exit 1; }
curl -fSL "$BASE/checksums.txt" -o "$TMP/checksums.txt" || { echo "下載 checksums 失敗" >&2; exit 1; }
# 驗 sha256（格式對齊 CI：<hash>␣␣<檔名>）
( cd "$TMP" && grep "  $ASSET\$" checksums.txt | shasum -a 256 -c - ) || { echo "sha256 校驗失敗" >&2; exit 1; }

# 偵測 app 執行中
if pgrep -x "Fledge" >/dev/null 2>&1; then
  echo "Fledge 正在執行，請先關閉再安裝" >&2; exit 1
fi

tar -xzf "$TMP/$ASSET" -C "$TMP"
# 安裝（/Applications 無權限 → fallback ~/Applications）
if [ ! -w "$INSTALL_DIR" ]; then
  if [ "$INSTALL_DIR" = "/Applications" ]; then INSTALL_DIR="$HOME/Applications"; mkdir -p "$INSTALL_DIR"; else
    echo "$INSTALL_DIR 不可寫" >&2; exit 1; fi
fi
# 原子覆蓋：先把新 app 搬到目標旁 staging（跨 volume copy 在這步、舊 app 還在），
# 舊的改 backup → 新的 rename 上位 → 成功刪 backup、失敗回復舊 app（Codex PR-gate Low）。
NEW="$INSTALL_DIR/$APP.new.$$"; BAK="$INSTALL_DIR/$APP.bak.$$"
rm -rf "$NEW"; mv "$TMP/$APP" "$NEW"
[ -e "$INSTALL_DIR/$APP" ] && mv "$INSTALL_DIR/$APP" "$BAK"
if mv "$NEW" "$INSTALL_DIR/$APP"; then
  rm -rf "$BAK"
else
  [ -e "$BAK" ] && mv "$BAK" "$INSTALL_DIR/$APP"
  rm -rf "$NEW"
  echo "安裝失敗，已回復原安裝" >&2; exit 1
fi
xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP" 2>/dev/null || true
echo "已安裝到 $INSTALL_DIR/$APP — 從 Spotlight 開或：open '$INSTALL_DIR/$APP'"

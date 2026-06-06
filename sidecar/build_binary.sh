#!/usr/bin/env bash
# 打包 Python sidecar 成 onedir（資料夾：exe + _internal/），不再每次解壓（修 ~14s 冷啟動）。
# nested Mach-O deepest-first ad-hoc 簽章（arm64 要求可執行碼有簽章）。複製到 Tauri binaries/。
set -euo pipefail
cd "$(dirname "$0")"
source .venv/bin/activate

# onedir（取代 onefile）
pyinstaller --onedir --name fledge-sidecar --clean --noconfirm fledge_sidecar/__main__.py

# nested ad-hoc 簽章：-depth 深度優先；file 探測真 Mach-O，避免亂簽 script。
# 排除主 exe（! -name）——它在最後單獨簽，確保 nested→framework→exe 的由內而外順序（不重複簽）。
find dist/fledge-sidecar -depth -type f ! -name 'fledge-sidecar' | while read -r f; do
  if file "$f" | grep -q 'Mach-O'; then codesign --force --sign - "$f"; fi
done
# 只在真的有 .framework 時才簽容器層；不吞真失敗
if find dist/fledge-sidecar -depth -type d -name '*.framework' -print -quit | grep -q .; then
  find dist/fledge-sidecar -depth -type d -name '*.framework' -exec codesign --force --sign - {} \;
fi
codesign --force --sign - dist/fledge-sidecar/fledge-sidecar  # 主 exe 最後簽（最外層）
chmod 755 dist/fledge-sidecar/fledge-sidecar

# 複製整個 onedir 到 Tauri binaries/fledge-sidecar/（rsync -a 保留 symlink + 權限）。
# 清掉舊 onefile 殘檔（target-triple 後綴）。binaries/ 已在 .gitignore。
DEST="../src-tauri/binaries/fledge-sidecar"
rm -rf "$DEST"
rm -f ../src-tauri/binaries/fledge-sidecar-*-apple-darwin
mkdir -p "$(dirname "$DEST")"
rsync -a dist/fledge-sidecar/ "$DEST/"
echo "Copied onedir to $DEST"

#!/usr/bin/env bash
# 打包 Python sidecar 成 onedir（資料夾：exe + _internal/），不再每次解壓（修 ~14s 冷啟動）。
# nested Mach-O deepest-first ad-hoc 簽章（arm64 要求可執行碼有簽章）。複製到 Tauri binaries/。
set -euo pipefail
cd "$(dirname "$0")"
source .venv/bin/activate

# ---- 範本 staging（public 預設；private 只在明確帶 flag 時從 repo 外路徑帶入）----
# 判定與複製全在 template_manifest（有單元測試），shell 只負責 flag 解析與串接。
WITH_PRIVATE=0
for arg in "$@"; do
  [ "$arg" = "--with-private-templates" ] && WITH_PRIVATE=1
done

STAGE="build/templates"
PRIVATE_ARG=""
if [ "$WITH_PRIVATE" = "1" ]; then
  : "${FLEDGE_PRIVATE_TEMPLATES_DIR:?帶了 --with-private-templates 就必須設 FLEDGE_PRIVATE_TEMPLATES_DIR}"
  PRIVATE_ARG="$FLEDGE_PRIVATE_TEMPLATES_DIR"
fi

.venv/bin/python -c "
import json, sys
from fledge_sidecar.setup.templates import build_manifest_entries, MANIFEST_FILENAME
from fledge_sidecar.setup.template_manifest import (
    ARTIFACT_MANIFEST_FILENAME, build_artifact_manifest, stage_templates)

public_root, private_root, stage = sys.argv[1], (sys.argv[2] or None), sys.argv[3]
included = stage_templates(public_root, private_root, stage)

# 每個 staged 範本重新產生 manifest（出貨的 manifest 永遠與出貨的內容一致）
for tid in included:
    root = f'{stage}/{tid}'
    entries = build_manifest_entries(root)
    with open(f'{root}/{MANIFEST_FILENAME}', 'w', encoding='utf-8') as fh:
        fh.write(json.dumps({'entries': [{'path': e.path, 'type': e.type} for e in entries]},
                            ensure_ascii=False) + '\n')

# build_artifact_manifest 必須在 manifest 覆寫之後才跑，否則登記到的是舊雜湊
manifest = build_artifact_manifest(stage, included)
with open(f'{stage}/{ARTIFACT_MANIFEST_FILENAME}', 'w', encoding='utf-8') as fh:
    fh.write(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print('staged:', included)
" "resources/templates-public" "$PRIVATE_ARG" "$STAGE"

# 打包前先驗一次（release 之外的手動 build 也擋得住誤帶）
VERIFY_ARGS=(--staged-root "$STAGE" --manifest "$STAGE/artifact-manifest.json")
[ "$WITH_PRIVATE" = "1" ] && VERIFY_ARGS+=(--allow-private)
.venv/bin/python ../scripts/verify_templates_artifact.py "${VERIFY_ARGS[@]}"

# onedir（取代 onefile）
pyinstaller --onedir --name fledge-sidecar --clean --noconfirm \
  --add-data "build/templates:templates" \
  fledge_sidecar/__main__.py

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

#!/usr/bin/env bash
# 版本號統一更新。用法：scripts/bump-version.sh X.Y.Z
#
# prerelease（-rc.N）只放 git tag、不進這些檔（spec §3.3）——CI 的 Version guard
# 會把 tag 的 vX.Y.Z-rc.N 剝成 X.Y.Z 再跟 tauri.conf.json 比。
#
# ═══ 為什麼版號要由一支腳本管 ═══════════════════════════════════════════
# 版號散在多個檔案，漏一處就「各說各話」：app 標題列顯示一版、/api/health 回另一版。
# 這不是假想——4 處 manifest 都到 0.5.0 時，sidecar 的 __version__ 還停在 0.1.0。
# CI 的 Version guard（.github/workflows/release.yml）只比對 tauri.conf.json 一處，
# 其餘幾處漂移它抓不到，所以「跑完這支腳本」是唯一防線。
#
# ═══ 管什麼、不管什麼 ═══════════════════════════════════════════════════
#   自動改　：下方 bump_one 列出的 5 處版本來源
#   自動同步：package-lock.json、src-tauri/Cargo.lock（生成物，交給各自的工具寫）
#   只提醒　：sidecar/tests/test_health.py（刻意不自動改，理由見「注意 3」）
#
# ═══ 修改本腳本時的注意事項 ═════════════════════════════════════════════
# 1. 新增版本來源＝加一行 bump_one，不要另外寫 sed。
#    bump_one 內建前後兩道驗證，繞過它就等於沒有驗證。
#
# 2. sed 未命中會靜默成功。實測：對完全不匹配的檔案跑 `sed -i '' -E`，
#    回傳 exit 0 且檔案原封不動。所以「腳本沒報錯」不等於「改成功了」。
#    bump_one 因此改之前驗匹配恰好 1 行（0 行＝正則過時；2 行以上＝會改到別的欄位），
#    改之後再驗那一行確實含新版號。
#    而且 bump_all 跑兩輪：第一輪 MODE=check 只驗不寫，全部過了第二輪才動手。
#    少了這一輪，第 3 個檔案驗不過時前 2 個已經被改掉，留下半套狀態要人工回滾。
#
# 3. sidecar/tests/test_health.py 硬編碼 assert body["version"] == "X.Y.Z"。
#    刻意不由腳本自動改：那條斷言的作用就是「版號變動時強迫有人看一眼」，
#    自動改掉等於把防線拆了（同一個道理見 sidecar/tests/test_usage_pricing.py
#    釘死 gpt-5.6 三個 tier 的定價數字）。腳本只偵測並提醒，人改完要跑 pytest。
#
# 4. sed -i '' 是 BSD/macOS 語法；GNU sed 會把 '' 當成腳本檔名而失敗。
#    本專案只在 macOS 打包，暫不處理跨平台。要支援 Linux 得改 `sed -i` 或 `perl -pi`。
#
# 5. JSON 必須維持多行格式化。bump_one 靠「一行一個欄位」定位，JSON 被壓成單行後
#    匹配數仍是 1、卻可能改到別的 "version" 欄位。也因此不用 python json.dump 重寫——
#    那會重排格式、破壞既有的 inline object 寫法。
#
# 6. 兩個 lock 檔即使沒同步也不會弄壞 CI（實測：npm ci 只檢查 dependencies 一致性，
#    version 欄位不同不影響），純粹是為了不讓那幾行改動混進下一次不相干的 commit。
#    所以工具不在 PATH 時只警告、不中斷。
#
# 7. release-please 導入後本腳本退役（docs/planning/release-please-adoption.md §9），
#    版號改由 bot 維護。在那之前這裡是唯一入口，別在別處手改版號。

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: bump-version.sh X.Y.Z}"
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo "version 必須是 X.Y.Z（prerelease 只放 git tag）" >&2; exit 1; }

MODE=check   # check＝只驗不寫；apply＝真的寫入（見「注意 2」的兩輪設計）

die() {
  echo "✗ $*" >&2
  if [ "$MODE" = apply ]; then
    echo "  （本輪已改的檔案沒有回滾：git checkout -- <檔案> 還原後再重跑）" >&2
  fi
  exit 1
}
warn() { echo "  ! $*"; }

# 改一處版本來源並驗證。用法：bump_one <檔案> <定位正則> <sed 表達式> <這處是給誰看的>
bump_one() {
  local file="$1" locate="$2" expr="$3" desc="$4" hits line
  [ -f "$file" ] || die "$file 不存在"
  hits=$(grep -cE "$locate" "$file" || true)
  [ "$hits" = "1" ] \
    || die "$file 匹配到 $hits 行，預期恰好 1 行（0＝正則已過時；2 以上＝會改到別的欄位）"
  if [ "$MODE" = check ]; then return 0; fi
  sed -i '' -E "$expr" "$file"
  line=$(grep -E "$locate" "$file" || true)
  case "$line" in
    *"$VERSION"*) printf '  ✓ %-42s %s\n' "$file" "$desc" ;;
    *) die "$file 替換後仍不含 $VERSION——sed 靜默未命中，正則與檔案內容已對不上" ;;
  esac
}

# 版本來源全集中在這個函式裡——新增一處＝加一行 bump_one，其餘都不必動
bump_all() {
  bump_one src-tauri/tauri.conf.json '"version": "[^"]+"' \
    's/"version": "[^"]+"/"version": "'"$VERSION"'"/' \
    'app 顯示的版本、打包檔名；CI Version guard 比的就是這處'
  bump_one package.json '"version": "[^"]+"' \
    's/"version": "[^"]+"/"version": "'"$VERSION"'"/' \
    '前端套件版號'
  # Cargo.toml / pyproject.toml：只有 [package]/[project] 的 version 在行首，依賴的不在
  bump_one src-tauri/Cargo.toml '^version = "[^"]+"' \
    's/^version = "[^"]+"/version = "'"$VERSION"'"/' \
    'Tauri 殼（Rust crate）'
  bump_one sidecar/pyproject.toml '^version = "[^"]+"' \
    's/^version = "[^"]+"/version = "'"$VERSION"'"/' \
    'sidecar Python 套件'
  # 正則刻意不錨定行尾：release-please 導入後這行會加 # x-release-please-version 註解，
  # 只換左半才不會把註解吃掉
  bump_one sidecar/fledge_sidecar/__init__.py '^__version__ = "[^"]+"' \
    's/^__version__ = "[^"]+"/__version__ = "'"$VERSION"'"/' \
    '/api/health 回的版本'
}

bump_all                # 第一輪：只驗，任一處不過就在動手前中止
echo "→ 版本來源（5 處）"
MODE=apply
bump_all                # 第二輪：全部驗過了才真的寫入

echo "→ lock 檔（生成物，交給工具自己寫）"
if command -v npm >/dev/null 2>&1; then
  npm install --package-lock-only --silent >/dev/null 2>&1 \
    && printf '  ✓ %-42s %s\n' "package-lock.json" "npm install --package-lock-only" \
    || warn "npm install --package-lock-only 失敗 → package-lock.json 未同步"
else
  warn "npm 不在 PATH → package-lock.json 未同步"
fi
if command -v cargo >/dev/null 2>&1; then
  # -p fledge 只鎖本 crate 的版號、不動其餘依賴（crate 名取自 src-tauri/Cargo.toml，
  # 改名後這裡會失敗並落到 warn）；--offline 不連網
  ( cd src-tauri && cargo update -p fledge --offline >/dev/null 2>&1 ) \
    && printf '  ✓ %-42s %s\n' "src-tauri/Cargo.lock" "cargo update -p fledge --offline" \
    || warn "cargo update 失敗 → src-tauri/Cargo.lock 未同步"
else
  warn "cargo 不在 PATH → src-tauri/Cargo.lock 未同步"
fi

echo "→ 需要人工處理的"
TEST_HEALTH=sidecar/tests/test_health.py
if ! grep -qE '\["version"\] == "[0-9]+\.[0-9]+\.[0-9]+"' "$TEST_HEALTH" 2>/dev/null; then
  warn "$TEST_HEALTH 找不到版號斷言——斷言寫法可能變了，請確認這道防線還在"
elif grep -q "== \"$VERSION\"" "$TEST_HEALTH"; then
  printf '  ✓ %-42s %s\n' "$TEST_HEALTH" "已是 $VERSION"
else
  warn "$TEST_HEALTH 仍斷言舊版號 → 手動改成 \"$VERSION\"（為何不自動改：見本檔「注意 3」）"
fi

cat <<EOF

已同步到 ${VERSION}。接下來：
  1. 上面標 ! 的項目逐一處理
  2. cd sidecar && .venv/bin/python -m pytest tests/ -q
  3. git diff 複核後 commit——明列檔案路徑，別用 git add -A
     （repo 根目錄有長駐未追蹤檔，-A 會把它們一起帶進去）
  4. 發版才打 tag：git tag v${VERSION}（push 這個 tag 會觸發 release.yml 打包）
EOF

#!/usr/bin/env bash
#
# 備份 Claude 生態（所有登記帳號的 config_dir）成一個帶時間戳的備份包。
#
# 範圍依「可再生性」分層（ADR-0004）：丟了無法再生的才收，快取與執行期狀態一律不收。
# **永不收憑證**——Claude 的在 Keychain 本就拿不到，`daemon/control.key` 這類明確排除，
# 所以備份包可以自由存放。但它仍含使用者識別資訊（`.claude.json` 的 userID），不可公開。
#
# 安全不變式：**來源全程唯讀**。本腳本只寫輸出目錄底下的東西，不碰任何帳號目錄。
#
# 用法：
#   scripts/backup-claude.sh              # 備份到預設位置
#   scripts/backup-claude.sh -o <目錄>    # 指定輸出目錄
#   scripts/backup-claude.sh --list       # 只列出會收什麼、不打包
#
# 環境變數：FLEDGE_BACKUP_DIR 覆寫預設輸出目錄。

set -euo pipefail

OUT_DIR="${FLEDGE_BACKUP_DIR:-/Users/tc/NAS/work/claude-backups}"
CONFIG_JSON="${HOME}/.fledge/config.json"
LIST_ONLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT_DIR="$2"; shift 2 ;;
    --list) LIST_ONLY=true; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知參數：$1" >&2; exit 1 ;;
  esac
done

# ── 備份清單（ADR-0004 的判定結果）───────────────────────────────────────────
# 資產：使用者寫的東西、以及使用者選擇保留的工作歷史
ASSET_DIRS=(skills commands scripts plugins projects file-history image-cache paste-cache jobs)
ASSET_FILES=(CLAUDE.md settings.json settings.local.json .claude.json history.jsonl)

# 明確判定「不收」的。列在這裡不是為了跳過（不在 ASSET_* 就不會收），而是為了讓
# 「出現了清單上沒有的新東西」能被偵測出來——Claude Code 加目錄時要有人重新判定。
KNOWN_SKIP=(
  cache telemetry backups tasks session-env sessions shell-snapshots chrome daemon downloads
  stats-cache.json mcp-needs-auth-cache.json daemon.log daemon-auth-status.json
  daemon-auth-cooldown .last-cleanup .last-update-result.json .DS_Store .claude.json.backup
)

# 帳號目錄之外的資產。skill 真身可以放在 config_dir 外、再從 skills/ 用 symlink 指過去
# （~/.agents/skills 就是這樣），只備 config_dir 會收到一條指向空氣的連結。
EXTRA_PATHS=(~/.agents)

expand_home() { case "$1" in "~/"*) echo "${HOME}/${1#\~/}" ;; "~") echo "${HOME}" ;; *) echo "$1" ;; esac; }

# ── 帳號清單 ────────────────────────────────────────────────────────────────
if [ ! -f "${CONFIG_JSON}" ]; then
  echo "找不到 ${CONFIG_JSON}——Fledge 尚未落檔，無從得知有哪些帳號。" >&2
  echo "先完成引導，或用 FLEDGE_BACKUP_ACCOUNTS='work=~/.claude' 手動指定。" >&2
  exit 1
fi

accounts=$(python3 -c "
import json, os
cfg = json.load(open(os.path.expanduser('${CONFIG_JSON}')))
for key, acc in cfg.get('accounts', {}).items():
    d = (acc.get('config_dir') or '').strip()
    if d:
        print(f'{key}\t{d}')
")
[ -n "${accounts}" ] || { echo "設定檔裡沒有任何帳號。" >&2; exit 1; }

# ── 掃描：這次會收什麼、跳過什麼、有沒有沒判定過的新東西 ──────────────────────
stamp=$(date +%Y%m%d-%H%M)
declare -a plan_lines=()
unknown_found=false
outside_link_found=false
total_kb=0

while IFS=$'\t' read -r key raw_dir; do
  dir=$(expand_home "${raw_dir}")
  if [ ! -d "${dir}" ]; then
    plan_lines+=("  [${key}] ${raw_dir} — 目錄不存在，略過整個帳號")
    continue
  fi
  plan_lines+=("  [${key}] ${dir}")
  for item in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}"; do
    [ -e "${dir}/${item}" ] || continue
    kb=$(du -sk "${dir}/${item}" 2>/dev/null | cut -f1 || echo 0)
    total_kb=$((total_kb + kb))
    plan_lines+=("$(printf '      收  %-16s %8s KB' "${item}" "${kb}")")
  done
  # 指向 config_dir 之外的 symlink：連結會被存起來，但**目標內容不在備份包裡**。
  # 備份看起來完整、還原後卻是斷鏈——最危險的失敗，所以要出聲（實際踩過：
  # ~/.claude/skills/huashu-design → ~/.agents/skills/huashu-design）。
  for item in "${ASSET_DIRS[@]}"; do
    [ -d "${dir}/${item}" ] || continue
    while IFS= read -r link; do
      [ -n "${link}" ] || continue
      target=$(cd "$(dirname "${link}")" && cd "$(dirname "$(readlink "${link}")")" 2>/dev/null && pwd)/$(basename "$(readlink "${link}")")
      case "${target}" in
        "${dir}"/*) ;;   # 指回自己帳號內，內容會一起被收
        *)
          covered=false
          while IFS=$'\t' read -r _k other_raw; do
            other=$(expand_home "${other_raw}")
            case "${target}" in "${other}"/*) covered=true ;; esac
          done <<< "${accounts}"
          for extra in "${EXTRA_PATHS[@]}"; do
            case "${target}" in "$(expand_home "${extra}")"*) covered=true ;; esac
          done
          [ "${covered}" = true ] || {
            plan_lines+=("      ⚠   ${item}/$(basename "${link}") → ${target}")
            plan_lines+=("          連結指向備份範圍外，內容不會被收！")
            outside_link_found=true
          }
          ;;
      esac
    done <<< "$(find "${dir}/${item}" -maxdepth 2 -type l 2>/dev/null)"
  done
  # 清單外的頂層項目：可能是 Claude Code 新增的東西，需要人重新判定（ADR-0004）
  for path in "${dir}"/* "${dir}"/.[!.]*; do
    [ -e "${path}" ] || continue
    name=$(basename "${path}")
    known=false
    for k in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}" "${KNOWN_SKIP[@]}"; do
      [ "${name}" = "${k}" ] && { known=true; break; }
    done
    case "${name}" in *.tmp.*|*.backup.*) known=true ;; esac
    if [ "${known}" = false ]; then
      plan_lines+=("      ?   ${name} — 清單上沒有，這次不收（請判定後更新腳本）")
      unknown_found=true
    fi
  done
done <<< "${accounts}"

for extra in "${EXTRA_PATHS[@]}"; do
  p=$(expand_home "${extra}")
  [ -e "${p}" ] || continue
  kb=$(du -sk "${p}" 2>/dev/null | cut -f1 || echo 0)
  total_kb=$((total_kb + kb))
  plan_lines+=("$(printf '  [帳號外] %-24s %8s KB' "${extra}" "${kb}")")
done

printf '%s\n' "${plan_lines[@]}"
printf '\n  合計 %s MB（壓縮前）\n' "$((total_kb / 1024))"
[ -f "${CONFIG_JSON}" ] && echo "  另收 ~/.fledge/config.json"

if [ "${outside_link_found}" = true ]; then
  echo
  echo "⚠️  上面標 ⚠ 的連結指向備份範圍外——備份包只會有連結、沒有內容。"
  echo "    把目標加進本腳本的 EXTRA_PATHS，否則還原後那些是斷鏈。"
fi
if [ "${unknown_found}" = true ]; then
  echo
  echo "⚠️  上面標 ? 的項目不在判定清單內，這次不會被備份。"
  echo "    確認它是資產還是快取後，更新本腳本的 ASSET_* 或 KNOWN_SKIP。"
fi

[ "${LIST_ONLY}" = true ] && exit 0

# ── 打包 ────────────────────────────────────────────────────────────────────
mkdir -p "${OUT_DIR}"
out="${OUT_DIR}/claude-backup-${stamp}.tar.gz"
[ -e "${out}" ] && { echo "輸出檔已存在，不覆蓋：${out}" >&2; exit 1; }

# staging 用 APFS clone（同卷零成本、瞬間完成），tar 再打包它。
# stage 路徑由本腳本 mkdir 產生、含 PID，trap 只清這一個。
stage="${OUT_DIR}/.staging-$$"
cleanup() { [ -n "${stage:-}" ] && [ -d "${stage}" ] && rm -rf "${stage}"; }
trap cleanup EXIT
mkdir -p "${stage}/accounts"

echo
echo "打包中…"
while IFS=$'\t' read -r key raw_dir; do
  dir=$(expand_home "${raw_dir}")
  [ -d "${dir}" ] || continue
  mkdir -p "${stage}/accounts/${key}"
  for item in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}"; do
    [ -e "${dir}/${item}" ] || continue
    # -R 遞迴且不跟隨 symlink（連結存連結本身）；-c 走 APFS clonefile，跨卷時自動退回一般複製
    cp -Rc "${dir}/${item}" "${stage}/accounts/${key}/" 2>/dev/null \
      || cp -R "${dir}/${item}" "${stage}/accounts/${key}/"
  done
done <<< "${accounts}"

for extra in "${EXTRA_PATHS[@]}"; do
  p=$(expand_home "${extra}")
  [ -e "${p}" ] || continue
  mkdir -p "${stage}/extra"
  cp -Rc "${p}" "${stage}/extra/" 2>/dev/null || cp -R "${p}" "${stage}/extra/"
done

mkdir -p "${stage}/fledge"
cp "${CONFIG_JSON}" "${stage}/fledge/config.json"

extra_json=$(printf '%s\n' "${EXTRA_PATHS[@]}" | while read -r e; do
  p=$(expand_home "${e}"); [ -e "${p}" ] && echo "$(basename "${p}")	${p}"
done)
python3 - "${stage}/manifest.json" "${stamp}" "${extra_json}" <<'PY'
import json, os, sys, platform
out_path, stamp, extra_raw = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(os.path.expanduser("~/.fledge/config.json")))
extra = dict(line.split("\t", 1) for line in extra_raw.splitlines() if "\t" in line)
json.dump({
    "format": 1,
    "created": stamp,
    "host": platform.node(),
    "home": os.path.expanduser("~"),
    # 還原時要知道每個帳號原本在哪；移機到不同使用者名時，帳號間的 symlink 會斷鏈（ADR-0004）
    "accounts": {k: (v.get("config_dir") or "") for k, v in cfg.get("accounts", {}).items()},
    # 帳號目錄之外的資產（skill 真身可能放這裡，再從 skills/ symlink 過去）
    "extra": extra,
    "excludes_credentials": True,
}, open(out_path, "w"), indent=2, ensure_ascii=False)
PY

tar czf "${out}" -C "${stage}" accounts fledge manifest.json $([ -d "${stage}/extra" ] && echo extra)

# ── 驗證：讀得回來才算數 ────────────────────────────────────────────────────
if ! tar tzf "${out}" > /dev/null 2>&1; then
  echo "打包後驗證失敗，刪除半成品：${out}" >&2
  rm -f "${out}"
  exit 1
fi
entries=$(tar tzf "${out}" | wc -l | tr -d ' ')

echo
echo "✅ ${out}"
echo "   $(du -h "${out}" | cut -f1)．${entries} 個項目"
echo
echo "已有的備份包："
ls -1t "${OUT_DIR}"/claude-backup-*.tar.gz 2>/dev/null | head -10 | while read -r f; do
  echo "   $(du -h "$f" | cut -f1)  $(basename "$f")"
done
n=$(ls -1 "${OUT_DIR}"/claude-backup-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
[ "${n}" -gt 5 ] && echo "   （共 ${n} 份。本腳本不自動刪除任何備份，要清請自行處理。）"
exit 0

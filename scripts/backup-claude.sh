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

OUT_DIR="${FLEDGE_BACKUP_DIR:-}"
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

# 沒有輸出目錄就停：舊版寫死的預設值只對開發者那台機器有意義，公開 repo 不能留它。
# GUI 一律傳 -o；CLI 使用者請自行指定或設 FLEDGE_BACKUP_DIR。
if [ -z "${OUT_DIR}" ]; then
  echo "未指定輸出目錄。用 -o <目錄> 或設定 FLEDGE_BACKUP_DIR。" >&2
  exit 1
fi

# ── 備份清單（ADR-0004 的判定結果）───────────────────────────────────────────
# 資產：使用者寫的東西、以及使用者選擇保留的工作歷史
ASSET_DIRS=(skills commands scripts plugins projects file-history image-cache paste-cache jobs)
ASSET_FILES=(CLAUDE.md settings.json settings.local.json .claude.json history.jsonl)

# 需要萬用字元展開的資產。**不能直接塞進 ASSET_FILES**：下面三處用法（掃描的 -e 測試、
# 未分類判定的字串相等、打包的複製）都是引號包住的字面比對，字面的 `settings.json.bak.*`
# 三處都不會匹配——結果是既沒收到檔案、`?` 警示也沒消掉，比什麼都不做更糟。
#
# `settings.json.bak.<時間戳>` 是共通設置把 settings.json 換成 symlink 前，那份使用者
# 手寫設定的唯一副本：丟了回不來，按 ADR-0004 的可再生性判準它是資產。
ASSET_GLOBS=(settings.json.bak.*)

# 對某個帳號目錄展開 ASSET_GLOBS，結果放進全域 matched 陣列。
# 局部開 nullglob：零匹配時得到空陣列，而不是留下字面 pattern。掃描／複製／未分類判定
# 三處共用同一份結果，避免「列出來了卻沒收進去」這種只在打開備份包時才會發現的失敗。
expand_globs() {
  local dir="$1" pat f
  matched=()
  for pat in "${ASSET_GLOBS[@]}"; do
    while IFS= read -r -d '' f; do
      matched+=("$(basename "${f}")")
    done < <(cd "${dir}" 2>/dev/null && shopt -s nullglob && for g in ${pat}; do printf '%s\0' "${g}"; done)
    # 用 for 迴圈而不是 `printf '%s\0' ${pat}`：**printf 帶格式字串但沒有引數時仍會輸出
    # 一次空字串**，於是零匹配會讓 matched 多一個空元素，`"${dir}/${item}"` 變成
    # `"${dir}/"`——掃描階段對整個帳號目錄 du，打包階段 `cp -Rc` 整棵帳號目錄，
    # 把 ADR-0004 判定不收的 sessions/、cache/ 全部收進備份包。
  done
}

# 明確判定「不收」的。列在這裡不是為了跳過（不在 ASSET_* 就不會收），而是為了讓
# 「出現了清單上沒有的新東西」能被偵測出來——Claude Code 加目錄時要有人重新判定。
KNOWN_SKIP=(
  cache telemetry backups tasks session-env sessions shell-snapshots chrome daemon downloads
  stats-cache.json mcp-needs-auth-cache.json daemon.log daemon-auth-status.json
  daemon-auth-cooldown .last-cleanup .last-update-result.json .DS_Store .claude.json.backup
)

# 帳號目錄之外的資產。清單放在共用檔而非寫死在這裡：sidecar 的 containment 防呆要讀
# 同一份（它決定備份輸出目錄不得落在哪些目錄裡），各存一份就會漂移——只改 bash 的話，
# 新來源會被打包但 containment 不知道它，使用者就能把備份設進那個來源裡。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRA_PATHS_FILE="${SCRIPT_DIR}/backup-extra-paths.txt"
EXTRA_PATHS=()
if [ -f "${EXTRA_PATHS_FILE}" ]; then
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line#"${line%%[![:space:]]*}"}"     # 去前導空白
    case "${line}" in ''|'#'*) continue ;; esac
    EXTRA_PATHS+=("${line}")
  done < "${EXTRA_PATHS_FILE}"
fi

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
  expand_globs "${dir}"   # 掃描／未分類判定共用這一份展開結果
  for item in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}" ${matched[@]+"${matched[@]}"}; do
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
          for extra in ${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"}; do
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
    for k in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}" "${KNOWN_SKIP[@]}" ${matched[@]+"${matched[@]}"}; do
      [ "${name}" = "${k}" ] && { known=true; break; }
    done
    case "${name}" in *.tmp.*|*.backup.*) known=true ;; esac
    if [ "${known}" = false ]; then
      plan_lines+=("      ?   ${name} — 清單上沒有，這次不收（請判定後更新腳本）")
      unknown_found=true
    fi
  done
done <<< "${accounts}"

for extra in ${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"}; do
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
# 驗證通過前寫的名字：前導 `.` 加 `.partial` 後綴，兩重都不符合「完整備份包」的形狀，
# 所以半成品永遠不會被 UI 當成一次成功的備份（原子發布）。
#
# **帶 PID**（比照 stage）：`stamp` 只有分鐘精度，只用它命名的話，同分鐘啟動的兩個備份
# （GUI + CLI、或兩個實例）會寫同一個檔案。更糟的是先完成的那個 rename 成最終名之後，
# 另一個的 open fd 仍指向同一個 inode——它會繼續寫，把一份**已經驗證過**的備份包寫壞。
partial="${OUT_DIR}/.claude-backup-${stamp}-$$.tar.gz.partial"
[ -e "${out}" ] && { echo "輸出檔已存在，不覆蓋：${out}" >&2; exit 1; }

# 回收超齡殘骸：SIGKILL、程序崩潰或斷電時下面的 trap 不會執行，殘骸會一直累積，
# 吃掉的正是要拿來放備份的空間。**嚴格命名 + 24 小時年齡閘**——只刪本腳本自己產生的
# 格式，且不誤刪另一個正在跑的實例。命名不符的一律不動，即使它很舊。
find "${OUT_DIR}" -maxdepth 1 -type f \
  -name '.claude-backup-????????-????-*.tar.gz.partial' -mmin +1440 -delete 2>/dev/null || true

# staging 用 APFS clone（同卷零成本、瞬間完成），tar 再打包它。
# stage 路徑由本腳本 mkdir 產生、含 PID，trap 只清這一個；partial 同理。
stage="${OUT_DIR}/.staging-$$"
cleanup() {
  [ -n "${stage:-}" ] && [ -d "${stage}" ] && rm -rf "${stage}"
  [ -n "${partial:-}" ] && [ -f "${partial}" ] && rm -f "${partial}"
  return 0   # trap 的回傳值會變成腳本的結束碼；上面任一 [ ] 為假都會讓成功的備份回非零
}
trap cleanup EXIT
mkdir -p "${stage}/accounts"

echo
echo "打包中…"
while IFS=$'\t' read -r key raw_dir; do
  dir=$(expand_home "${raw_dir}")
  [ -d "${dir}" ] || continue
  mkdir -p "${stage}/accounts/${key}"
  expand_globs "${dir}"   # 這是另一個迴圈，要重新展開；沿用掃描那輪的結果會拿到別的帳號的檔名
  for item in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}" ${matched[@]+"${matched[@]}"}; do
    [ -e "${dir}/${item}" ] || continue
    # -R 遞迴且不跟隨 symlink（連結存連結本身）；-c 走 APFS clonefile，跨卷時自動退回一般複製
    cp -Rc "${dir}/${item}" "${stage}/accounts/${key}/" 2>/dev/null \
      || cp -R "${dir}/${item}" "${stage}/accounts/${key}/"
  done
done <<< "${accounts}"

for extra in ${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"}; do
  p=$(expand_home "${extra}")
  [ -e "${p}" ] || continue
  mkdir -p "${stage}/extra"
  cp -Rc "${p}" "${stage}/extra/" 2>/dev/null || cp -R "${p}" "${stage}/extra/"
done

mkdir -p "${stage}/fledge"
cp "${CONFIG_JSON}" "${stage}/fledge/config.json"

# 用 `|| continue` 而不是 `[ -e ] && echo`：後者在「所有 EXTRA_PATHS 都不存在」時會讓
# 迴圈以非零狀態結束，command substitution 跟著非零，`set -e` 就在**做完所有工作之後**
# 把腳本殺掉。有 ~/.agents 的機器永遠踩不到，沒有的機器每次備份都在最後一刻失敗。
extra_json=$(printf '%s\n' ${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"} | while read -r e; do
  p=$(expand_home "${e}")
  [ -e "${p}" ] || continue
  printf '%s\t%s\n' "$(basename "${p}")" "${p}"
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

tar czf "${partial}" -C "${stage}" accounts fledge manifest.json $([ -d "${stage}/extra" ] && echo extra)

# ── 驗證：讀得回來才算數，通過了才叫得出最終名 ──────────────────────────────
if ! tar tzf "${partial}" > /dev/null 2>&1; then
  echo "打包後驗證失敗，刪除半成品：${partial}" >&2
  rm -f "${partial}"
  exit 1
fi
# 發布用 `ln` 而不是 `mv`：hard link 遇到既有目標會直接失敗（EEXIST），是真正的原子
# no-clobber——上面那行 `[ -e "${out}" ]` 只是 check-then-act，兩個同分鐘的備份可能都通過
# 它然後互相覆寫。link 成功後 partial 與 out 是同一個 inode，unlink 掉 partial 這個名字即可。
if ! ln "${partial}" "${out}" 2>/dev/null; then
  echo "輸出檔已存在（另一個備份可能同分鐘完成），不覆蓋：${out}" >&2
  exit 1
fi
rm -f "${partial}"
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

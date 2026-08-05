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

# 路徑走 argv、程式碼用**單引號**包住：把 `${CONFIG_JSON}` 插進雙引號的 `-c` 字串，
# HOME 含單引號時（`/Users/o'brien` 在 macOS 上完全合法）那段 Python 會變成
# SyntaxError——備份直接跑不起來，而訊息是使用者看不懂的一段 traceback。
# `restore-claude.sh` 已是這個寫法，兩支腳本一致。
accounts=$(python3 -c '
import json, sys
cfg = json.load(open(sys.argv[1]))
for key, acc in cfg.get("accounts", {}).items():
    d = (acc.get("config_dir") or "").strip()
    if d:
        print(f"{key}\t{d}")
' "${CONFIG_JSON}")
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
  # extra 一律當**目錄樹**處理（見打包段的合約註解）。普通檔案、或指向檔案的連結都不收，
  # 但要出聲——靜靜跳過等於讓使用者以為收了。
  if [ ! -d "${p}" ]; then
    plan_lines+=("  [帳號外] ${extra} — 不是目錄，不收")
    continue
  fi
  # 估算要與打包**同一條界線**：先把最外層解開（`du` 對 symlink 參數不跟隨，直接量會
  # 得到連結本身的 0 KB），再用不跟隨的 `du` 量那棵樹。
  #
  # **不要圖省事用 `du -L`**：那是整棵跟隨，會把內容裡的連結指向的東西也算進來，而打包
  # 不收那些——實測 5100 KB 對實收 100 KB。修掉「最外層算成 0」時很容易順手用 `-L`，
  # 那只是把一個「一邊有一邊沒有」換成另一個。
  real=$(cd "${p}" && pwd -P)
  kb=$(du -sk "${real}" 2>/dev/null | cut -f1 || echo 0)
  total_kb=$((total_kb + kb))
  plan_lines+=("$(printf '  [帳號外] %-24s %8s KB' "${extra}" "${kb}")")
  # 收的東西與清單上寫的路徑不是同一個位置時，備份前就要看得到
  if [ -L "${p}" ]; then
    plan_lines+=("           ↳ 是連結，實收 ${real} 的內容")
  fi
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
# **帶 PID 與隨機段**：`stamp` 只有分鐘精度，只用它命名的話，同分鐘啟動的兩個備份
# （GUI + CLI、或兩個實例）會寫同一個檔案。更糟的是先完成的那個發布成最終名之後，
# 另一個的 open fd 仍指向同一個 inode——它會繼續寫，把一份**已經驗證過**的備份包寫壞。
#
# 光靠 PID 只在單機成立：輸出目錄若是網路掛載，兩台主機同分鐘拿到相同 PID 並不罕見；
# PID 也會重用。加一段 $RANDOM 把碰撞機率壓到可忽略。
partial="${OUT_DIR}/.claude-backup-${stamp}-$$-${RANDOM}.tar.gz.partial"
[ -e "${out}" ] && { echo "輸出檔已存在，不覆蓋：${out}" >&2; exit 1; }

# 回收超齡殘骸：SIGKILL、程序崩潰或斷電時下面的 trap 不會執行，殘骸會一直累積，
# 吃掉的正是要拿來放備份的空間。**嚴格命名 + 24 小時年齡閘**——只刪本腳本自己產生的
# 格式，且不誤刪另一個正在跑的實例。
#
# find 先粗篩，再**逐檔以 regex 覆核 basename**：glob 的 `-*` 會匹配 `-`、`-imported`
# 這種不是本腳本產生的名字，而 sidecar 的 `_PARTIAL_RE` 只認 `-<數字>-<數字>`。兩邊認定
# 不一致 = 腳本會刪掉 UI 明確不承認是自己殘骸的檔案，違反「只刪自己建的」。
while IFS= read -r -d '' f; do
  [[ "$(basename "${f}")" =~ ^\.claude-backup-[0-9]{8}-[0-9]{4}-[0-9]+-[0-9]+\.tar\.gz\.partial$ ]] || continue
  rm -f "${f}"
done < <(find "${OUT_DIR}" -maxdepth 1 -type f -name '.claude-backup-*.tar.gz.partial' \
  -mmin +1440 -print0 2>/dev/null)

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

# extra 的合約：**解一層參照後的真實目錄樹**。
#
# `~/.agents` 本身是連結（skill 真身放第三個位置，常見設置）時，`cp -R "${p}"` 不跟隨
# 最外層，包裡會是一條指向**舊機絕對路徑**的連結。還原端是 fd-relative `O_NOFOLLOW`，
# 那一項必然 `not_a_directory` 而腳本 rc = 0——使用者拿到一個看起來成功、裡面有一項
# 永遠搬不回去的包，失敗要到移機的最後一步才看得到。
#
# **界線是「只解最外層那一層」**：`cp -R "${p}/."` 複製的是連結指向的目錄內容，而內容
# 裡的連結仍原樣存連結（`-R` 的天然行為）。不要改成 `-L`——那會把每條連結指向的東西
# 都拖進來，備份包會膨脹成不相干的資料。跟隨最外層是使用者的意圖（那條路徑是他自己
# 寫進 `backup-extra-paths.txt` 的），跟隨內容裡的連結不是。
#
# 目的地名字**明確給 `${name}`**，兩個理由：`cp -R "${p}/" "${stage}/extra/"`（尾斜線）
# 在 BSD cp 會把內容攤平到 `extra/` 底下，`.agents` 這個名字整個消失；而名字必須來自
# **連結本身**的 basename，不是 target 的——manifest 的 key、`_safe_extra_name`（票 13）、
# 落點對應三處都靠它，用 target 的名字會讓還原端拿到一個本機 config 查不到的 key。
for extra in ${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"}; do
  p=$(expand_home "${extra}")
  [ -d "${p}" ] || continue     # `-d` 跟隨連結；非目錄在掃描階段已經說明過了
  name=$(basename "${p}")
  mkdir -p "${stage}/extra/${name}"
  cp -Rc "${p}/." "${stage}/extra/${name}/" 2>/dev/null \
    || cp -R "${p}/." "${stage}/extra/${name}/"
done

mkdir -p "${stage}/fledge"
cp "${CONFIG_JSON}" "${stage}/fledge/config.json"

# 用 `|| continue` 而不是 `[ -e ] && echo`：後者在「所有 EXTRA_PATHS 都不存在」時會讓
# 迴圈以非零狀態結束，command substitution 跟著非零，`set -e` 就在**做完所有工作之後**
# 把腳本殺掉。有 ~/.agents 的機器永遠踩不到，沒有的機器每次備份都在最後一刻失敗。
#
# 判準要與上面的打包迴圈**逐字一致**（`-d`）：一邊 `-e` 一邊 `-d` 的話，非目錄的項目會被
# 寫進 manifest 卻不在包裡，還原端就拿著一個查得到 key、找不到內容的項目對帳。
#
# 值存**連結本身**的路徑（`~/.agents`），不是解參照後的真實路徑：那是使用者在舊機認得的
# 位置。還原端只用 key 查本機 config（`local_live_paths` 明確不退回 manifest 的路徑），
# 這個值純粹是舊機資訊。
extra_json=$(printf '%s\n' ${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"} | while read -r e; do
  p=$(expand_home "${e}")
  [ -d "${p}" ] || continue
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
# 發布優先用 `ln`：hard link 遇既有目標會直接失敗（EEXIST），是真正的原子 no-clobber
# ——上面那行 `[ -e "${out}" ]` 只是 check-then-act，兩個同分鐘的備份可能都通過它然後
# 互相覆寫。link 成功後 partial 與 out 是同一個 inode，unlink 掉 partial 這個名字即可。
#
# 但 hard link 不是每個檔案系統都支援（exFAT、部分 SMB／NFS 掛載）。那時**不能把失敗
# 一律報成「輸出檔已存在」**——使用者會朝完全錯誤的方向排查，而真正的原因是
# `Operation not supported`／權限／quota／I/O error。所以依「目標存不存在」分流，
# 並在退回 rename 時把原始錯誤說出來。
if publish_error=$(ln "${partial}" "${out}" 2>&1); then
  rm -f "${partial}"
elif [ -e "${out}" ]; then
  echo "輸出檔已存在（另一個備份可能同分鐘完成），不覆蓋：${out}" >&2
  exit 1
else
  # rename 到處都能用，但沒有 no-clobber 語意——所以只在確認目標不存在時才走這條。
  echo "註：hard link 不可用（${publish_error}），改用 rename 發布。" >&2
  mv "${partial}" "${out}"
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

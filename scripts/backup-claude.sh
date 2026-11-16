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

# 一律用系統內建的 bsdtar，**不從 PATH 找**（xz 改版 spec §6.1）。App 把使用者登入 shell 的
# PATH 原樣交給 sidecar 與它開的終端機（`src-tauri/src/sidecar.rs`）；PATH 前面若是 Homebrew
# 的 GNU tar，參數與錯誤訊息都和 bsdtar 不同，而備份包的格式只對 bsdtar 驗證過。
# `FLEDGE_TAR` 只是**測試接縫**（比照 FLEDGE_MAX_ENTRIES）：測試要換成會失敗／會拖慢的假 tar。
# 能設環境變數的人本來就能執行任意命令，它不是安全邊界。
TAR="${FLEDGE_TAR:-/usr/bin/tar}"

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
#
# 票 17（2026-09-21）補判定：`agents`／`output-styles` 與 skills、commands 同類，是使用者
# 寫的內容；`skills-archive` 是使用者自建的舊版 skill 封存（不在 Claude Code 載入路徑）。
# `usage-data` 是 `/insights` 的衍生物，照理可重算——但 30 天 session 清理後舊 facets 就
# 算不回來，且重跑要花 token，使用者選擇當工作歷史保留（與 file-history 同一類）。
ASSET_DIRS=(skills commands scripts plugins projects file-history image-cache paste-cache jobs
            agents output-styles skills-archive usage-data)
ASSET_FILES=(CLAUDE.md settings.json settings.local.json .claude.json history.jsonl)

# 需要萬用字元展開的資產。**不能直接塞進 ASSET_FILES**：下面三處用法（掃描的 -e 測試、
# 未分類判定的字串相等、打包的複製）都是引號包住的字面比對，字面的 `settings.json.bak.*`
# 三處都不會匹配——結果是既沒收到檔案、`?` 警示也沒消掉，比什麼都不做更糟。
#
# `settings.json.bak.<時間戳>` 是共通設置把 settings.json 換成 symlink 前，那份使用者
# 手寫設定的唯一副本：丟了回不來，按 ADR-0004 的可再生性判準它是資產。
# `settings.json.bak-<日期>[-說明]` 是改設定前手動留的舊版，同樣丟了回不來；分隔符是減號，
# 上一個 pattern 對不上，所以另列（票 52）。
ASSET_GLOBS=(settings.json.bak.* settings.json.bak-*)

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
# `feedback` 是 SendFeedback 工具的本機草稿佇列（`feedback/drafts/`），使用者核准送出後即
# 消失——暫存佇列不是資產（票 17）。
# `state` 目前只有 `mcp-discover-verdicts.json`（MCP 伺服器回報的協定版本＋觀測時間），
# 連線時重新探測就會長回來，是快取（票 52）。
KNOWN_SKIP=(
  cache telemetry backups tasks session-env sessions shell-snapshots chrome daemon downloads
  stats-cache.json mcp-needs-auth-cache.json daemon.log daemon-auth-status.json
  daemon-auth-cooldown .last-cleanup .last-update-result.json .DS_Store .claude.json.backup
  feedback state
)

# 被備份的根目錄底下刻意不收的子路徑——相對於**每一個**根：帳號的 config_dir，以及帳號外位置
# （`backup-extra-paths.txt`，預設 `~/.agents`，skill 真身常放那裡）。`skills/.trash` 是刪掉的
# skill 放的垃圾桶：刪掉的東西不是資產（使用者判定，xz 改版 spec §6.4）。
# **只在這裡定義一次**：掃描估算、symlink 警告、從 staging 刪除都讀它；manifest 照抄一份給
# 還原端的差異報告用，還原端不另寫清單。每一項都要有父路徑（`a/b` 的形狀）。
EXCLUDE_PATHS=(skills/.trash)

# 帳號目錄之外的資產。清單放在共用檔而非寫死在這裡：sidecar 的 containment 防呆要讀
# 同一份（它決定備份輸出目錄不得落在哪些目錄裡），各存一份就會漂移——只改 bash 的話，
# 新來源會被打包但 containment 不知道它，使用者就能把備份設進那個來源裡。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRA_PATHS_FILE="${SCRIPT_DIR}/backup-extra-paths.txt"
# 展開量判準，與 restore-claude.sh 共用（見打包段的發布前檢查）
EXPANSION_GUARD="${SCRIPT_DIR}/expansion_guard.py"
EXTRA_PATHS=()
if [ -f "${EXTRA_PATHS_FILE}" ]; then
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line#"${line%%[![:space:]]*}"}"     # 去前導空白
    case "${line}" in ''|'#'*) continue ;; esac
    EXTRA_PATHS+=("${line}")
  done < "${EXTRA_PATHS_FILE}"
fi

expand_home() { case "$1" in "~/"*) echo "${HOME}/${1#\~/}" ;; "~") echo "${HOME}" ;; *) echo "$1" ;; esac; }

# 把路徑正規化成「絕對、每一段都解參照過」的形式。**路徑本身可以尚不存在**。
#
# 為什麼不能只對已存在的路徑解參照（票 18 R1 F1）：登記來源根時 `config_dir` 可能還不
# 存在，而 `mkdir -p "${OUT_DIR}"` 之後它就會存在、打包迴圈照樣把它當來源。「不存在就
# 沒有 inode、也就沒有別名問題」這個推論是錯的——**別名可以在祖先上**（`alias -> real`
# 時 `alias/ghost` 與 `real/ghost` 是同一個位置），也可以是**懸空的連結本身**（票 18 R3
# F1：`alias -> real/ghost` 而 target 還不存在，`mkdir` 一建它當場就變成有效目錄）。
#
# **走 Python 的 `os.path.realpath` 而不是自己在 bash 裡上溯**：手寫版本要同時處理
# 「不存在的尾段」「祖先上的連結」「懸空的終端連結」「連結環」「`//` 的實作定義語意」
# （bash 的 `pwd -P` 對 `//` 回 `//`，zsh 回 `/`——在互動 shell 裡驗會得到錯誤結論），
# 每一項都踩過一次。realpath 一次全部處理，而且與 sidecar 的路徑語意是同一套。
# 成本約 17ms／次、每次備份呼叫數次，可忽略。
#
# 路徑走 argv、程式碼用單引號包住（與本檔其他 python3 呼叫同一個理由：HOME 含單引號時
# 插值進去會變成 SyntaxError）。空字串會被正規化成 CWD，呼叫端必須先擋掉。
resolve_path() {
  python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

# 相對路徑是不是 EXCLUDE_PATHS 之一、或落在其中之一底下（symlink 警告用）。
# case 的 pattern 加引號＝字面比對（路徑裡的 `*`、`[` 不會被當萬用字元），只有結尾的 `/*` 是 glob。
is_excluded() {
  local rel="$1" ex
  for ex in "${EXCLUDE_PATHS[@]}"; do
    case "${rel}" in "${ex}"|"${ex}"/*) return 0 ;; esac
  done
  return 1
}

# `<根>/<排除路徑>` 除了最後一段以外，每一段都是真資料夾（不是 symlink）才回 0。
# 從 staging 刪除前一定要過這一關：`cp -R` 把 symlink 存成 symlink，帳號的 `skills` 若是指向
# 現役目錄的連結，`staging/.../skills/.trash` 就在連結目標裡，刪下去刪到的是現役檔案。
# 最後一段（`.trash` 本身）是連結或一般檔沒關係——`rm -rf` 刪的是它本身，不跟隨。
parents_are_real_dirs() {
  local cur="$1" part
  local -a parts
  IFS=/ read -r -a parts <<< "${2%/*}"
  for part in "${parts[@]}"; do
    cur="${cur}/${part}"
    [ -d "${cur}" ] && [ ! -L "${cur}" ] || return 1
  done
}

# 從 staging 的某個根（`accounts/<key>` 或 `extra/<名稱>`）刪掉 EXCLUDE_PATHS（xz 改版 spec §6.4）。
# **照舊整項 `cp -Rc` 再刪**，不在複製時逐項跳過：逐項列舉要自己把「列不出來」傳成失敗，
# 做錯就是「備份成功卻少了整個目錄」（plan 審查連兩輪打在這裡）；整項複製把這件事交給
# `cp`，讀不到就失敗，跟改版前一樣。刪除排在量測與打包之前，staging、包的內容、展開量判準
# 三者是同一棵樹。
drop_excluded() {
  local root="$1" ex
  for ex in "${EXCLUDE_PATHS[@]}"; do
    if parents_are_real_dirs "${root}" "${ex}"; then rm -rf "${root:?}/${ex}"; fi
  done
}

# 掃描估算要與打包同一條界線：`<根>` 底下、落在 `<項目>/` 之下（項目給空字串＝整個根）的
# 排除路徑，會被刪掉的那些的大小（KB）。判斷用的是同一個 parents_are_real_dirs，只是對象是來源。
excluded_kb() {
  local root="$1" item="$2" ex kb total=0
  for ex in "${EXCLUDE_PATHS[@]}"; do
    if [ -n "${item}" ]; then
      case "${ex}" in "${item}"/*) ;; *) continue ;; esac
    fi
    if parents_are_real_dirs "${root}" "${ex}" && { [ -e "${root}/${ex}" ] || [ -L "${root}/${ex}" ]; }; then
      kb=$(du -sk "${root}/${ex}" 2>/dev/null | cut -f1 || echo 0)
      total=$((total + kb))
    fi
  done
  echo "${total}"
}

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

# ── 來源根與輸出目錄的 containment ───────────────────────────────────────────
#
# 備份會讀的所有來源根（帳號的 config_dir ∪ 額外來源）。
#
# **交錯存放**（說明, 根, 說明, 根…）而不是用分隔字元把兩者串成一筆：路徑是不受限的
# 檔案系統字串，tab 在 Unix 路徑裡合法，串起來再從第一個 tab 切開就會被路徑自己的 tab
# 帶偏，取到錯的根而讓檢查失準。
#
# **尚不存在的來源根也要登記**：`mkdir -p "${OUT_DIR}"` 會把祖先一起建出來，於是打包
# 迴圈重新判斷時它已經是目錄、照樣會被複製，而裡面只有剛寫進去的 staging。sidecar 的
# `source_roots()` 同樣不管來源存不存在。一律走 `resolve_path`（絕對、祖先解參照）——
# 「不存在就沒有 inode、也就不會有別名問題」是錯的，**別名可以在祖先上**（票 18 R1 F1）。
#
# 空路徑不是來源根。登記它會讓比對的 pattern 變成 `/*`＝**任何**輸出目錄都被判成落在
# 來源裡，備份完全不能用。含換行的 `config_dir` 會真的走到這裡：`accounts` 那份逐行
# 資料被換行拆成兩行，第二行沒有 tab，`raw_dir` 就是空的。
declare -a source_roots=()

while IFS=$'\t' read -r key raw_dir; do
  dir=$(expand_home "${raw_dir}")
  if [ -n "${dir}" ]; then
    source_roots+=("帳號 ${key} 的目錄" "$(resolve_path "${dir}")")
  fi
done <<< "${accounts}"

for extra in ${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"}; do
  p=$(expand_home "${extra}")
  if [ -n "${p}" ]; then
    source_roots+=("額外來源 ${extra}" "$(resolve_path "${p}")")
  fi
done

# 輸出目錄不得落在**任何來源根**之下（帳號的 config_dir ∪ 額外來源）。staging 建在
# OUT_DIR 底下，落在來源裡就會被複製進自己。兩邊的症狀不同、都不可接受：
#
#   - extra（票 17）：`cp -R "${p}/."` 會遞迴到路徑過長而**失敗**——rc≠0，訊息是一長串
#     看不懂的路徑，且失敗前已經寫了大量資料。
#   - 帳號（票 18）：`cp -R "${dir}/${item}"` 複製的是開始當下的樹、不追自己新寫的內容，
#     所以**不報錯**。它靜靜地把 staging 連同輸出目錄裡**既有的備份包**收進新包——實測
#     新包 3004 KB 含著舊包 3000 KB，每次備份吞掉之前所有的包，體積指數成長到磁碟滿，
#     而每一次的 `rc` 都是 0。更隱蔽，也更持久。
#
# **粒度是粗判**（落在 config_dir 之下即擋，不細到 ASSET_DIRS），與 sidecar 的
# `check_backup_dir` 逐字一致——實測它對 `<config_dir>/backups` 也回 `inside_source`。
# 細判會讓判準隨 `ASSET_DIRS` 清單漂移：哪天把某個目錄加進清單，本來放行的落點就變成
# 不安全，而使用者不會知道。
#
# 這是 sidecar 那份 containment 的第二份實作，**刻意的**：腳本必須能獨立執行、拿不到
# sidecar 的 Python，而它的用法說明明確支援直接跑。兩邊漂移會造成「GUI 擋、CLI 放行」，
# 所以 `test_script_and_sidecar_agree_on_containment` 拿同一組落點對帳釘住。
#
# 兩邊都經過 `resolve_path`（絕對、祖先解參照），字串比對足夠：APFS 的大小寫別名在
# `pwd -P` 這一層已經正規化，不必為此引入 inode 比對。
#
# **檢查排在 `mkdir -p "${OUT_DIR}"` 之前**（Codex 票 18 R1 F2）：反過來的話，落點在來源
# 樹裡而尚不存在時，腳本會先在使用者的資料裡建出整段目錄再說「不行」——直接違反檔頭
# 宣告的「來源全程唯讀」。所以 `out_real` 也要能正規化**尚不存在**的路徑。
#
# **檢查排在掃描之前**：掃描會對每個來源 `du`，來源清單荒謬時（有人把 `/` 列進去）光是
# 估算就會讀遍整個檔案系統。檢查是廉價的，要排在任何昂貴或有副作用的動作之前——這與
# 「拒絕前不得寫入來源樹」是同一條原則的兩面。
#
# `"${root}"` 的**引號不可省**：case 的 pattern 位置若讓變數裸展開，路徑裡的 `[bc]`、`*`
# 會被當成萬用字元，`/home/a[bc]/*` 反而去匹配 `/home/ab/…`——真正落在來源裡的輸出目錄
# 漏擋。加引號後那段是字面比對，只有結尾的 `/*` 保留 glob 意義。
out_real=$(resolve_path "${OUT_DIR}")
idx=0
label=""
for entry in ${source_roots[@]+"${source_roots[@]}"}; do
  # 交錯陣列：偶數位是說明、奇數位是來源根（見宣告處的理由）。用位置計數而不是
  # 「label 是不是空的」判斷——後者會依賴值的內容，路徑理論上可以是任何字串。
  if [ $((idx % 2)) -eq 0 ]; then
    label="${entry}"
  else
    root="${entry}"
    # **去掉尾斜線再組 pattern**（Codex 票 18 R2 F1）：來源根是 `/` 時直接組出的是 `//*`，
    # 只匹配以兩條斜線開頭的字串——於是把 `/` 列進來源反而讓 containment 完全失效，而那
    # 正是「整個檔案系統都是來源」、沒有任何安全落點的情況。`${root%/}` 讓 `/` 變成空字串，
    # pattern 成為 `/*`＝匹配所有絕對路徑；其餘來源根不受影響（它們沒有尾斜線）。
    root_prefix="${root%/}"
    case "${out_real}/" in
      "${root_prefix}"/*)
        echo "輸出目錄在備份來源裡：${out_real}" >&2
        echo "    它落在 ${root} 之下，而那是${label}。" >&2
        echo "    備份會把正在寫入的暫存區收進自己，換一個不在來源樹裡的輸出目錄。" >&2
        exit 1
        ;;
    esac
  fi
  idx=$((idx + 1))
done


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
    kb=$((kb - $(excluded_kb "${dir}" "${item}")))     # 與打包同一條界線：不收的不算
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
      is_excluded "${link#"${dir}/"}" && continue   # 不收的東西不警告（xz 改版 spec §6.4）
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
  real=$(resolve_path "${p}")     # 來源根已在上面登記過，這裡只是估算與提示要用
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
  kb=$(du -sk "${real}" 2>/dev/null | cut -f1 || echo 0)
  kb=$((kb - $(excluded_kb "${real}" "")))
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

# 判準檔不見時寧可擋下也不放行（少了它無法確認備份包還原得回來），而且要在打包**之前**停——
# 打包可能要一分鐘，做完才說不行是白等。
[ -f "${EXPANSION_GUARD}" ] || {
  echo "找不到 ${EXPANSION_GUARD}——它應該與本腳本放在同一個資料夾。" >&2
  echo "少了它無法確認備份包還原得回來，所以這次不備份。" >&2
  exit 1
}

# ── 打包 ────────────────────────────────────────────────────────────────────
#
mkdir -p "${OUT_DIR}"
out="${OUT_DIR}/claude-backup-${stamp}.tar.xz"
# 驗證通過前寫的名字：前導 `.` 加 `.partial` 後綴，兩重都不符合「完整備份包」的形狀，
# 所以半成品永遠不會被 UI 當成一次成功的備份（原子發布）。
#
# **帶 PID 與隨機段**：`stamp` 只有分鐘精度，只用它命名的話，同分鐘啟動的兩個備份
# （GUI + CLI、或兩個實例）會寫同一個檔案。更糟的是先完成的那個發布成最終名之後，
# 另一個的 open fd 仍指向同一個 inode——它會繼續寫，把一份**已經驗證過**的備份包寫壞。
#
# 光靠 PID 只在單機成立：輸出目錄若是網路掛載，兩台主機同分鐘拿到相同 PID 並不罕見；
# PID 也會重用。加一段 $RANDOM 把碰撞機率壓到可忽略。
partial="${OUT_DIR}/.claude-backup-${stamp}-$$-${RANDOM}.tar.xz.partial"
# 同一分鐘只能有一份備份包，**不分格式**（xz 改版 spec §6.6）：同分鐘已有舊的 .tar.gz 時照樣
# 開始的話，這次若被強制中止，殘骸的時間戳與那份 gzip 包相同，而 sidecar 判斷「上一次沒跑完」
# 用的是嚴格大於，就看不到它了。兩個程序同時啟動、都在完成包出現前通過這裡，是現行 gzip
# 就有的既有限制，這一道不處理（spec §6.6）。
same_minute_gz="${OUT_DIR}/claude-backup-${stamp}.tar.gz"
for f in "${out}" "${same_minute_gz}"; do
  if [ -e "${f}" ]; then echo "輸出檔已存在，不覆蓋：${f}" >&2; exit 1; fi
done

# 回收超齡殘骸：SIGKILL、程序崩潰或斷電時下面的 trap 不會執行，殘骸會一直累積，
# 吃掉的正是要拿來放備份的空間。**嚴格命名 + 24 小時年齡閘**——只刪本腳本自己產生的
# 格式，且不誤刪另一個正在跑的實例。
#
# find 先粗篩，再**逐檔以 regex 覆核 basename**：glob 的 `-*` 會匹配 `-`、`-imported`
# 這種不是本腳本產生的名字，而 sidecar 的 `_PARTIAL_RE` 只認 `-<數字>-<數字>`。兩邊認定
# 不一致 = 腳本會刪掉 UI 明確不承認是自己殘骸的檔案，違反「只刪自己建的」。
# 新舊兩種副檔名都認：改版前被中斷留下的 .tar.gz.partial 一樣是自己的殘骸。
while IFS= read -r -d '' f; do
  [[ "$(basename "${f}")" =~ ^\.claude-backup-[0-9]{8}-[0-9]{4}-[0-9]+-[0-9]+\.tar\.(xz|gz)\.partial$ ]] || continue
  rm -f "${f}"
done < <(find "${OUT_DIR}" -maxdepth 1 -type f -name '.claude-backup-*.tar.*.partial' \
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
  drop_excluded "${stage}/accounts/${key}"
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
declare -a packed_extra=()
for extra in ${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"}; do
  p=$(expand_home "${extra}")
  [ -d "${p}" ] || continue     # `-d` 跟隨連結；非目錄在掃描階段已經說明過了
  name=$(basename "${p}")
  mkdir -p "${stage}/extra/${name}"
  cp -Rc "${p}/." "${stage}/extra/${name}/" 2>/dev/null \
    || cp -R "${p}/." "${stage}/extra/${name}/"
  drop_excluded "${stage}/extra/${name}"     # 帳號外同一條規則
  # manifest 只從這份清單產生，不重新探測來源（見下方 manifest 段的理由）。
  # 名字與路徑**交錯存放**，不用分隔字元串接——理由同 extra_roots。
  packed_extra+=("${name}" "${p}")
done

mkdir -p "${stage}/fledge"
cp "${CONFIG_JSON}" "${stage}/fledge/config.json"

# **manifest 描述的是「包裡有什麼」，所以只能從打包結果產生**（Codex 票 17 R1 F1）。
# 原本這裡對現役來源重新探測一次，於是打包與 manifest 是兩次獨立觀測：來源在兩段之間
# 被刪掉或換掉，包裡有 `extra/.agents` 而 manifest 沒有那個 key——還原端靠 manifest 列出
# 可搬的項目，已經備份到的資料就選不出來；反向變化則讓 manifest 宣稱一個包裡沒有的項目。
# 把判準統一成 `-d` 只解決了「判準不同」那一半，沒解決「觀測時機不同」。
#
# 值存**連結本身**的路徑（`~/.agents`），不是解參照後的真實路徑：那是使用者在舊機認得的
# 位置。還原端只用 key 查本機 config（`local_live_paths` 明確不退回 manifest 的路徑），
# 這個值純粹是舊機資訊。
#
# 名字與路徑**逐項走 argv**（交錯：name path name path…），不串成一份文字再解析：
# 兩者都是不受限的檔案系統字串，用 tab 串再切會被路徑自己的 tab 帶偏，用換行分行則會被
# `splitlines()` 截斷——兩種字元在 Unix 路徑裡都合法。argv 沒有這個問題。
python3 - "${stage}/manifest.json" "${stamp}" "${#EXCLUDE_PATHS[@]}" "${EXCLUDE_PATHS[@]}" \
  ${packed_extra[@]+"${packed_extra[@]}"} <<'PY'
import json, os, sys, platform
out_path, stamp = sys.argv[1], sys.argv[2]
cfg = json.load(open(os.path.expanduser("~/.fledge/config.json")))
n_excluded = int(sys.argv[3])
excluded = sys.argv[4:4 + n_excluded]
extra = dict(zip(sys.argv[4 + n_excluded::2], sys.argv[5 + n_excluded::2]))
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
    # 刻意不收的子路徑（相對於每個帳號目錄與帳號外位置）。還原端的差異報告依它過濾，
    # 不另寫一份清單；舊包沒有這一欄＝沒有排除任何東西（xz 改版 spec §6.4）。
    "excluded": excluded,
}, open(out_path, "w"), indent=2, ensure_ascii=False)
PY

# xz 等級 1（使用者定案，2026-11-16 實測同一份 3654 MB 的內容）：gzip 882 MB／41 秒、xz 等級 1
# 425 MB／54 秒、等級 3 377 MB／97 秒、等級 6 331 MB／263 秒。等級 1 拿到大部分的好處，打包幾乎
# 不變慢；再往上每多省幾十 MB 要多等一到三分鐘。macOS 內建的 tar 接受 `xz:threads` 但沒有效果
# （實測），單核心是既定條件。
"${TAR}" cJf "${partial}" --options xz:compression-level=1 \
  -C "${stage}" accounts fledge manifest.json $([ -d "${stage}/extra" ] && echo extra)

# ── 驗證：讀得回來才算數，通過了才叫得出最終名 ──────────────────────────────
# 驗證與數項目合成一次讀取：xz 包讀一遍約十幾秒，分兩次讀就多等一次。不帶壓縮旗標，讓
# bsdtar 自己認格式。
if ! listing=$("${TAR}" tf "${partial}" 2>/dev/null); then
  echo "打包後驗證失敗，刪除半成品：${partial}" >&2
  rm -f "${partial}"
  exit 1
fi
# 還原端會擋的包不發布（xz 改版 spec §6.5、G5）：對 staging 與暫存包套用**還原端同一份**判準。
# 少了這一道，還原時會被擋的包照樣顯示「備份成功」，要等到需要還原那天才發現——那時現役
# 資料多半已經沒了。在這裡失敗，使用者當下就看得到，現役資料也還在。
if ! python3 "${EXPANSION_GUARD}" "${stage}" "${partial}"; then
  echo "這份備份包還原時會被擋下（原因見上一行），所以不發布，已刪除半成品。" >&2
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
entries=$(printf '%s\n' "${listing}" | wc -l | tr -d ' ')
# 開始時沒有、打包期間才出現的同分鐘舊格式包（例如還沒更新的舊版腳本），發布前再查一次——
# `ln` 的 no-clobber 只管同名的 .tar.xz。這仍是 check-then-act，只縮小窗口（spec §6.6）。
if [ -e "${same_minute_gz}" ]; then
  echo "輸出檔已存在（另一個備份可能同分鐘完成），不覆蓋：${same_minute_gz}" >&2
  exit 1
fi
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

echo
echo "✅ ${out}"
echo "   $(du -h "${out}" | cut -f1)．${entries} 個項目"
echo
echo "已有的備份包："
# 新舊兩種格式一起列（xz 改版 spec G2）。用 nullglob 陣列，不讓 ls 去碰沒展開的 pattern：
# 其中一種一份都沒有時 ls 會回非零，在 pipefail＋set -e 之下整支腳本會在印完成功之後才失敗。
shopt -s nullglob
all_bundles=("${OUT_DIR}"/claude-backup-*.tar.xz "${OUT_DIR}"/claude-backup-*.tar.gz)
shopt -u nullglob
ls -1t "${all_bundles[@]}" | head -10 | while read -r f; do
  echo "   $(du -h "$f" | cut -f1)  $(basename "$f")"
done
n=${#all_bundles[@]}
[ "${n}" -gt 5 ] && echo "   （共 ${n} 份。本腳本不自動刪除任何備份，要清請自行處理。）"
exit 0

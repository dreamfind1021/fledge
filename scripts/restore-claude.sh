#!/usr/bin/env bash
#
# 展開一個備份包並列出它與現役目錄的差異。
#
# 安全不變式：**不寫任何現役目錄**（ADR-0004）。備份包展開到一個獨立位置，差異report
# 給你看，搬什麼回去由你決定。還原是低頻操作，不值得為它承擔「選錯備份包就蓋掉現役
# 資料」的風險。
#
# 用法：
#   scripts/restore-claude.sh <備份包.tar.gz>        # 指定備份包
#   scripts/restore-claude.sh -o <展開目錄> ...      # 指定展開位置
#   scripts/restore-claude.sh --diff-only -o <目錄>  # 只比差異，不展開（用既有的展開目錄）
#
# 備份包來源：直接給 .tar.gz 路徑，或設 FLEDGE_BACKUP_DIR 用該目錄裡最新的一份。
# 兩者都沒有就報錯——不預設任何路徑（寫死的預設值只對某一台機器有意義）。

set -euo pipefail

BACKUP_DIR="${FLEDGE_BACKUP_DIR:-}"
BUNDLE=""
DEST=""
DIFF_ONLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    -o) DEST="$2"; shift 2 ;;
    --diff-only) DIFF_ONLY=true; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) BUNDLE="$1"; shift ;;
  esac
done

# --diff-only 不需要備份包（它讀既有展開目錄裡的 manifest），其餘情況都要。
if [ -z "${BUNDLE}" ] && [ "${DIFF_ONLY}" = false ]; then
  [ -n "${BACKUP_DIR}" ] || {
    echo "未指定備份包。給一個 .tar.gz 路徑，或設定 FLEDGE_BACKUP_DIR。" >&2; exit 1; }
  BUNDLE=$(ls -1t "${BACKUP_DIR}"/claude-backup-*.tar.gz 2>/dev/null | head -1 || true)
  [ -n "${BUNDLE}" ] || { echo "在 ${BACKUP_DIR} 找不到任何備份包。" >&2; exit 1; }
fi
if [ "${DIFF_ONLY}" = false ]; then
  [ -f "${BUNDLE}" ] || { echo "找不到備份包：${BUNDLE}" >&2; exit 1; }
fi

DEST="${DEST:-${HOME}/.claude-restore-$(basename "${BUNDLE}" .tar.gz | sed 's/^claude-backup-//')}"

# ── 展開量的防呆（票 12）──────────────────────────────────────────────────────
# tar bomb：壓縮後幾 KB、展開後爆量。判準用**壓縮比**而不是絕對大小——後者會誤擋「真的
# 有很多資產」的誠實大包，而壓縮比正是 tar bomb 的特徵。
#
# **宣稱等級**：這不是「防止磁碟耗盡」，也不是「防止 inode 耗盡」。解壓當下的空間與 inode
# 都已經被佔掉了（磁碟真的滿的話是 tar 自己失敗，由既有的 cleanup 處理），這一層擋的是
# **不讓一個離譜的展開目錄留在磁碟上**——大得離譜或項目多得離譜都算。
# 它擋得住「宣告小、實際大」（量的是實際落地的東西，不看 header 宣告值），擋不住「解壓
# 過程中就把磁碟塞爆」（那需要 streaming 計量）。
EXPANSION_MIN_BYTES=8388608   # 8 MiB 以下不看比例：小包的 gzip 固定開銷會讓比例失真
EXPANSION_MAX_RATIO=200       # 真實備份包多是文字（jsonl／md），實測比例個位數到十幾倍
# **大小配額擋不住「多」**：symlink、目錄與零大小檔案的 st_size 全是 0，幾十萬個這種成員
# 可以讓總量停在 0 而完全繞過比例判準，留下的正是一個離譜的展開目錄（inode 耗用、清理極慢）。
# 上限依實測定：本機真實 `~/.claude` 是 1.5 萬個項目，留 13 倍餘裕。
# `FLEDGE_MAX_ENTRIES` 只是**測試接縫**（比照 FLEDGE_BACKUP_SCRIPTS_DIR）——造 20 萬個成員的
# 測試會慢到不可接受。能設環境變數的人本來就能執行任意命令，它不是安全邊界。
MAX_ENTRIES="${FLEDGE_MAX_ENTRIES:-200000}"

check_expansion() {
  python3 - "$1" "$2" "${EXPANSION_MIN_BYTES}" "${EXPANSION_MAX_RATIO}" "${MAX_ENTRIES}" <<'PYEOF'
import os, stat, sys

staging, bundle = sys.argv[1], sys.argv[2]
floor, max_ratio, max_entries = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])

# 只加總**一般檔**的大小：目錄項本身的 st_size 在 APFS 有幾百 bytes，算進去會讓「很多
# 空目錄」的包被誤判。symlink 不跟隨（lstat），它的 size 是目標字串長度。
total = 0
entries = 0
seen = set()
for dirpath, dirnames, filenames in os.walk(staging, followlinks=False):
    entries += len(dirnames) + len(filenames)
    for name in filenames:
        try:
            st = os.lstat(os.path.join(dirpath, name))
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        # hardlink：同一個 inode 的每個名字 lstat 都回相同的 st_size，逐名加總會把一份
        # 內容算 N 次。誤擋方向雖然安全，但仍然是誤擋。
        key = (st.st_dev, st.st_ino)
        if key in seen:
            continue
        seen.add(key)
        total += st.st_size

# **項目數的上限與大小無關**：零大小的成員不貢獻 total，只有這一道擋得住「多」。
if entries > max_entries:
    print(
        f"拒絕發布：這份備份包展開後有 {entries} 個項目，遠超過正常備份包的規模。",
        file=sys.stderr,
    )
    print("正常的備份包不會有這種數量，多半是一份惡意或損壞的包。", file=sys.stderr)
    raise SystemExit(1)

if total <= floor:
    raise SystemExit(0)
try:
    packed = os.stat(bundle).st_size
except OSError:
    raise SystemExit(0)          # 量不到來源就不做這個判斷，不擋合法的還原
# 不用整數截斷比較——`total // packed > 200` 會讓實際 200.9 倍的包通過。
if packed > 0 and total > packed * max_ratio:
    print(
        f"拒絕發布：這份備份包展開後是它本身的 {total // packed} 倍"
        f"（{total // (1 << 20)} MiB ← {packed // 1024} KiB）。",
        file=sys.stderr,
    )
    print("正常的備份包不會有這種比例，多半是一份惡意或損壞的包。", file=sys.stderr)
    raise SystemExit(1)
PYEOF
}

# ── manifest 的安全讀取（票 12）───────────────────────────────────────────────
# 備份包的內容是**不可信輸入**（使用者可能從網路下載到一份假的）。原本用 `[ -f ]` 判存在、
# 再 `json.load(open(...))` 讀——兩者都跟隨 symlink，所以一份把 `manifest.json` 做成 symlink
# 的包，會讓腳本解析包外的檔案並把欄位印在畫面上。
#
# **與 sidecar 的 `backup/install.py::read_manifest` 是同一組判準的兩份實作**：腳本要能獨立
# 執行（不能 import sidecar），所以無法共用程式碼。**改一邊務必改另一邊**（票 10／票 12）。
#
# 錯誤訊息刻意**不含檔案內容**——擋下來卻仍把內容印出去，等於沒擋。
MANIFEST_MAX_BYTES=1048576   # 1 MiB。manifest 只有帳號清單與幾個欄位，實測不到 1 KB。

verify_manifest() {
  python3 - "$1" "${MANIFEST_MAX_BYTES}" <<'PYEOF'
import json, os, stat, sys

path, limit = sys.argv[1], int(sys.argv[2])
BAD = "這不是一份可用的備份包"
try:
    # O_NOFOLLOW：manifest.json 自己是 symlink 就直接失敗，不跟著讀出包外的檔案。
    # O_NONBLOCK：它若是 FIFO，唯讀 open 會阻塞而根本走不到下面的型別判定。
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except OSError:
    print(f"{BAD}（manifest.json 讀不到，或它是連結而不是檔案）。", file=sys.stderr)
    raise SystemExit(1)
try:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        print(f"{BAD}（manifest.json 不是一般檔案）。", file=sys.stderr)
        raise SystemExit(1)
    if st.st_size > limit:
        print(f"{BAD}（manifest.json 大得不合理）。", file=sys.stderr)
        raise SystemExit(1)
    raw = os.read(fd, limit)
finally:
    os.close(fd)
try:
    data = json.loads(raw)
except ValueError:
    print(f"{BAD}（manifest.json 不是合法的 JSON）。", file=sys.stderr)
    raise SystemExit(1)

# **形狀也要驗，不只語法**——與 sidecar 的 `backup/install.py::read_manifest` 同一組判準
# （一邊有一邊沒有同樣是漂移）。少了這道，`accounts` 是 list 的包會一路走到差異報告才
# 以 AttributeError traceback 中止，而那時 DEST **已經發布**：使用者看到一個「看起來完成」
# 的展開目錄配一段 traceback、沒有差異報告。在發布前驗，壞包就根本不會留下東西。
if not isinstance(data, dict):
    print(f"{BAD}（manifest.json 的內容不是一個物件）。", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(data.get("accounts"), dict):
    print(f"{BAD}（manifest.json 的 accounts 欄位形狀不對）。", file=sys.stderr)
    raise SystemExit(1)
extra = data.get("extra", {})
if not isinstance(extra, dict) or any(not isinstance(v, str) for v in extra.values()):
    print(f"{BAD}（manifest.json 的 extra 欄位形狀不對）。", file=sys.stderr)
    raise SystemExit(1)
PYEOF
}

expand_home() { case "$1" in "~/"*) echo "${HOME}/${1#\~/}" ;; "~") echo "${HOME}" ;; *) echo "$1" ;; esac; }

# ── 展開位置的 containment 防呆 ─────────────────────────────────────────────
# **這一層必須在腳本裡，不能只在 GUI**：約束是「根本沒有那條路」而不是「GUI 預設不走那
# 條路」。sidecar 的 `_restore_blocked` 是同一組規則的另一份實作（那邊比對 (st_dev,st_ino)
# 身分、比這裡精確），兩層都在，直接跑腳本的人也擋得住。
#
# 展開到現役資料裡面的後果不是覆蓋（解的是 DEST/accounts/…）而是更難察覺的：把一份完整
# 副本折回備份來源，下一次備份會把它整包再收一遍。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_JSON="${HOME}/.fledge/config.json"
EXTRA_PATHS_FILE="${SCRIPT_DIR}/backup-extra-paths.txt"

# 判定整段收在**一個 Python 區塊**裡，不在 bash 與 python 之間傳路徑清單。前一版把 root
# 清單以換行序列化再由 `read` 逐行切割，含換行的路徑會被拆成兩個 root（資料與分隔符混用）；
# 而規則寫兩份（bash 一份、`containment.py` 一份）也必然漂移——R3 抓到的三條 finding 全是
# 同一個根因。判定所需的東西全部走 argv 傳進去，回傳只有「擋不擋、為什麼」。
if [ "${DIFF_ONLY}" = false ]; then
  python3 -c '
import json, os, sys

dest, config_json, extra_file, home = sys.argv[1:5]


def fail(msg, hint=""):
    print("拒絕執行：" + msg, file=sys.stderr)
    if hint:
        print(hint, file=sys.stderr)
    raise SystemExit(1)


def roots():
    """現役來源。**與 sidecar 的 `backup/containment.py::source_roots` 逐條對齊**——
    兩層規則不等價的後果是 GUI 說可以、直接跑腳本卻放行（或反過來）。"""
    out = []
    # lexists 而非 isfile：目錄、壞掉的 symlink、FIFO 都算「存在但讀不懂」，那時候我們不
    # 知道使用者的自訂帳號目錄有哪些，只能停手。只有真的不存在才退回預設。
    if os.path.lexists(config_json):
        try:
            with open(config_json) as fh:
                cfg = json.load(fh)
            accounts = cfg["accounts"] if isinstance(cfg, dict) else None
            if not isinstance(accounts, dict):
                raise ValueError("accounts 不是物件")
            for acc in accounts.values():
                if not isinstance(acc, dict):
                    raise ValueError("account 不是物件")
                # 缺 config_dir 的畸形 account 退回預設帳號目錄，**不是略過**：
                # source_roots 的 `acc.get("config_dir") or "~/.claude"` 就是這個語意，
                # 略過會讓 GUI 擋 ~/.claude 而腳本放行。
                out.append(os.path.expanduser(acc.get("config_dir") or "~/.claude"))
        except (OSError, ValueError) as exc:
            fail(
                "讀不懂 %s（%s）。" % (config_json, exc),
                "無從得知哪些目錄是現役資料，因此不展開——修好設定檔或先把它移開再試。",
            )
    else:
        # 設定檔不存在：移機到新機器上還沒設定過 Fledge 正是最常見的還原情境，
        # 而那時候 ~/.claude 一樣是現役目錄。
        out.append(os.path.expanduser("~/.claude"))
    try:
        with open(extra_file) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    out.append(os.path.expanduser(line))
    except OSError:
        pass          # 清單檔讀不到只會讓防呆變寬鬆一格，不該讓整個還原壞掉
    return out


def key(path):
    """字面正規化（展開 ~、轉絕對、消掉 . 與 ..），**不解析 symlink**。與 sidecar 的
    `expand_and_validate` 同語意。

    **不可以改用 realpath**：dest 是「在 root 底下、但指向外面」的 symlink 時，realpath
    會判它不在 root 內而放行，可是腳本的 staging 建在 `dirname(DEST)`——那個父目錄仍在
    來源樹裡面。**也不轉小寫**：case-sensitive volume 上 /X 與 /x 是兩個不同的目錄，
    無條件折疊會讓 GUI 說可以、腳本卻拒絕。大小寫別名交給下面的 inode 身分處理。"""
    return os.path.abspath(os.path.expanduser(path))


def identity(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_dev, st.st_ino)


def same_dir(a, b):
    """逐行對齊 `paths.same_dir`：字串相等涵蓋尚不存在的目錄，inode 身分涵蓋大小寫別名。"""
    if a == b:
        return True
    ident = identity(a)
    return ident is not None and ident == identity(b)


def is_same_or_within(inner, outer):
    """逐行對齊 `paths.is_same_or_within`：先字面比對（涵蓋尚不存在的目錄），不中再以
    inode 身分逐層上溯。

    `rstrip(os.sep)` 不可省：root 是 "/" 時不 rstrip 會組出 "//"，任何絕對路徑都不以它
    開頭，那個 root 等於完全沒守（`config_dir: "/"` 帳號 API 收得下，那時 sidecar 判
    inside_source、腳本卻放行）。"""
    base = outer.rstrip(os.sep)
    if inner == base or inner.startswith(base + os.sep):
        return True
    outer_id = identity(outer)
    if outer_id is None:
        return False
    current = inner
    while True:
        if identity(current) == outer_id:
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


dest_key = key(dest)
if dest_key == os.sep:
    fail("不能展開到檔案系統根目錄。")
# 家目錄「本身」才擋，落在它底下是正常的（預設展開位置就在 home 下）
if same_dir(dest_key, key(home)):
    fail("不能展開到家目錄本身，請選一個專用的資料夾。")
for root in roots():
    if is_same_or_within(dest_key, key(root)):
        fail(
            "%s 在現役的 Claude 資料（%s）裡面。" % (dest, root),
            "展開到那裡會把一份完整副本折回備份來源。換一個 Claude 目錄以外的位置。",
        )
' "${DEST}" "${CONFIG_JSON}" "${EXTRA_PATHS_FILE}" "${HOME}"
fi

# ── 展開 ────────────────────────────────────────────────────────────────────
if [ "${DIFF_ONLY}" = false ]; then
  # 展開目標必須是空的或不存在——絕不往既有內容上疊
  if [ -e "${DEST}" ] && [ -n "$(ls -A "${DEST}" 2>/dev/null)" ]; then
    echo "拒絕執行：${DEST} 已存在且非空。" >&2
    echo "換一個位置：$0 -o <別的目錄> ${BUNDLE}" >&2
    exit 1
  fi
  parent="$(dirname "${DEST}")"
  mkdir -p "${parent}"

  # **先解到 staging，驗過才整棵改名成 DEST。** tar 中途失敗（壞包、磁碟滿、被中斷）時
  # DEST 必須根本不存在——留一棵解到一半的樹，使用者會拿它當還原結果，而它缺的正是他要
  # 找的那些檔案。staging 名含 PID 與隨機段（同一分鐘的兩次還原不共用）、放在 DEST 的
  # 父目錄以確保同一個檔案系統（跨卷 mv 不是原子的）。
  staging="${parent}/.$(basename "${DEST}").fledge-restore-$$-${RANDOM}.partial"
  cleanup() {
    # 只刪自己這一輪 mkdir 出來的那一個目錄。**不做超齡回收**：staging 在使用者挑的位置
    # 旁邊（常是家目錄），為了清殘骸而在那裡遞迴刪除，風險與收益不成比例。
    [ -n "${staging:-}" ] && [ -d "${staging}" ] && rm -rf "${staging}"
    return 0   # trap 的回傳值會變成腳本的結束碼；上面任一 [ ] 為假都會讓成功的還原回非零
  }
  trap cleanup EXIT

  # 回收超齡殘骸。**這是真機驗收（B7）逼出來的**：EXIT trap 在掛斷時確實會跑，但關掉設定頁
  # 時 ptyprocess 在 0.3 秒後就送 SIGKILL，而 `rm -rf` 幾百 MB 要好幾秒——清到一半被砍，
  # 家目錄裡就留下 525MB 的隱藏目錄，沒有人會清它。原本判定「不做回收」的前提是「殘骸只在
  # SIGKILL／斷電時出現」，而驗收顯示它發生在一個正常的使用者動作上，前提不成立。
  #
  # 這是在**使用者的家目錄**裡遞迴刪除，所以認定要嚴：find 先粗篩，再逐一以 regex 覆核
  # basename（含 PID 與隨機段，只有本腳本會產生這種名字），且加年齡閘避免誤刪另一個正在
  # 跑的實例。年齡閘用 60 分鐘而非 backup-claude.sh 的 24 小時——那邊的殘骸是備份目錄裡的
  # 小檔案，這邊是家目錄裡最大幾百 MB 的目錄，而沒有任何一次合法的展開會跑超過一小時。
  while IFS= read -r -d '' stale; do
    [[ "$(basename "${stale}")" =~ ^\..*\.fledge-restore-([0-9]+)-[0-9]+\.partial$ ]] || continue
    # 名字裡的 PID 比時間精確：產生它的程序已經不在＝確定是棄置的，立刻回收。
    # 「中斷 → 立刻重跑」是最自然的反應，只靠年齡閘的話那份殘骸要留一小時（真機驗收
    # B7 就是這樣：第二次還原在 47 秒後啟動，清不到第一次的殘骸）。
    if kill -0 "${BASH_REMATCH[1]}" 2>/dev/null; then
      # 程序還活著：多半是另一個正在跑的還原，不碰。PID 被回收給不相干的程序時會落到
      # 這裡，交給年齡閘處理——誤判方向是「少刪一個」，那是安全的那一邊。
      [ -n "$(find "${stale}" -maxdepth 0 -mmin +60)" ] || continue
    fi
    rm -rf "${stale}"
  done < <(find "${parent}" -maxdepth 1 -type d -name '.*.fledge-restore-*.partial' \
    -print0 2>/dev/null)

  mkdir -p "${staging}"

  echo "展開 $(basename "${BUNDLE}") → ${DEST}"
  # tar 自己的錯誤（`gzip: stdin: unexpected end of file` 之類）留著給人看，但要在後面補一句
  # 說得出「這代表什麼」的話——驗收要的是「明確說明」，而系統原文只說了「解壓失敗」。
  if ! tar xzf "${BUNDLE}" -C "${staging}"; then
    echo "備份包解不開，多半是它本身損壞（傳輸中斷、儲存媒介出錯）：${BUNDLE}" >&2
    echo "換一份備份包再試；上面那行是 tar 的原始錯誤。" >&2
    exit 1
  fi

  # 備份包必須自帶一份**讀得出來的** manifest.json：它是差異報告的唯一依據。
  # 在**發布前**檢查，不完整的包因此不會留下任何半套目錄；而且 symlink manifest 必須在
  # 這裡就被擋掉——`rename` 整棵樹時 symlink 會跟著過去，發布後才驗等於沒驗。
  verify_manifest "${staging}/manifest.json" || exit 1

  # 展開量的防呆同樣在**發布前**：拒絕時 staging 由 EXIT trap 清掉，磁碟上不留東西。
  check_expansion "${staging}" "${BUNDLE}" || exit 1

  # **發布走 os.rename 而不是 mv**：`mv A B` 在 B 是既有目錄時會把 A 移**進去**變成
  # B/<staging名>，於是兩個同時還原到同一個 DEST 的程序，第二個會把自己整棵樹藏進第一份
  # 結果裡面，而且因為 DEST/manifest.json（第一份的）存在，它還會照樣印出成功的差異報告
  # ——整套設計最反對的假成功。rename(2) 的語意正是我們要的：目標不存在或是**空目錄**才
  # 成功、非空回 ENOTEMPTY，而且是原子的（「先 rmdir 再 mv」的 check-then-act 擋不住併發）。
  python3 -c '
import os, sys
try:
    os.rename(sys.argv[1], sys.argv[2])
except OSError as exc:
    print("展開位置在執行期間被佔用了（%s）：%s" % (exc.strerror, sys.argv[2]), file=sys.stderr)
    print("多半是同時跑了兩個還原。換一個位置再試。", file=sys.stderr)
    raise SystemExit(1)
' "${staging}" "${DEST}"
fi

MANIFEST="${DEST}/manifest.json"
# `--diff-only` 跳過解壓直接走到這裡，所以這一道不能省——那條路上的展開目錄不是本次驗過的。
verify_manifest "${MANIFEST}" || exit 1

python3 - "${MANIFEST}" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
print(f"\n備份包資訊：建立於 {m['created']}．來自主機 {m.get('host','?')}．home={m.get('home','?')}")
print(f"  帳號：{', '.join(f'{k}={v}' for k, v in m.get('accounts', {}).items())}")
if m.get("excludes_credentials"):
    print("  不含憑證——還原後 claude 與 codex 都要重新登入。")
PY

# ── 差異報告 ────────────────────────────────────────────────────────────────
# 比清單與大小，不比內容：500MB 逐位元比對太慢，而「哪些檔不見了／多出來／變大小」
# 已足以決定要搬什麼。要逐位元請對個別檔案自行 cmp。
echo
echo "── 差異（備份 vs 現役）─────────────────────────────"
python3 - "${DEST}" "${MANIFEST}" "${CONFIG_JSON}" "${EXTRA_PATHS_FILE}" <<'PY'
import json, os, re, sys

dest, manifest_path, config_json, extra_file = sys.argv[1:5]
m = json.load(open(manifest_path))


def local_live_paths():
    """現役側的位置：**由 manifest 的 key 對應到本機 config 的路徑**，回 (帳號, 帳號外) 兩張表。

    **兩個理由都不能只顧一個**：

    1. **不可用 manifest 的 path value**（票 12 R1）：那是備份包提供的不可信輸入，直接拿去
       `expanduser` + 遞迴 `snapshot`，一份惡意包就能指定掃描本機任意目錄（指向 `/` 就是整個
       檔案系統）並把檔名印進差異報告——已實測可利用。`verify_manifest` 擋不住它：那支驗的
       是 inode、大小與 JSON 語法，**不是語意**。
    2. **也不可拿 manifest 的 path 去跟本機路徑比字串**（票 12 R2）：manifest 記的是**舊機**的
       絕對路徑，移機換了使用者名或落點之後必然不相等，於是每個帳號都被略過、報告變成一份
       **假的空報告**，使用者以為沒東西要搬。而移機正是這批票的主題。

    **key 是穩定的、path 不是**——所以用 key 對應。manifest 的 path 只拿來顯示「這包來自哪裡」。
    """
    try:
        with open(config_json, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        # 讀不出 config：只認預設帳號那一個對應（移機到新機還沒設定 Fledge 是最常見的還原
        # 情境）。**不是**放行任意路徑，也不從 manifest 取任何位置。
        return {"default": os.path.normpath(os.path.expanduser("~/.claude"))}, {}

    by_account = {}
    for key, acct in (cfg.get("accounts") or {}).items():
        if isinstance(acct, dict) and isinstance(acct.get("config_dir"), str):
            by_account[key] = os.path.normpath(os.path.expanduser(acct["config_dir"]))
    by_extra = {}
    for name, path in (cfg.get("extra") or {}).items():      # 票 07 起 config 有 extra
        if isinstance(path, str):
            by_extra[name] = os.path.normpath(os.path.expanduser(path))
    # `backup-extra-paths.txt` 的項目以 basename 當 name——與 `backup-claude.sh` 產 manifest
    # 時同一條規則，兩邊各寫一份必然漂移。config 已有的不覆蓋（那是使用者確認過的落點）。
    try:
        with open(extra_file, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    expanded = os.path.normpath(os.path.expanduser(line))
                    by_extra.setdefault(os.path.basename(expanded), expanded)
    except OSError:
        pass
    return by_account, by_extra


LIVE_ACCOUNTS, LIVE_EXTRA = local_live_paths()

def snapshot(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        # symlink 一律先記下來再從 dirnames 移除（移除是為了不追進去）。**順序有意義**：
        # os.walk 把「有效的 symlink 目錄」歸在 dirnames、「斷鏈的」歸在 filenames，
        # 先過濾再記錄的話，同一條連結在現役（有效）與備份（展開後相對路徑失效）兩邊
        # 會落入不同分類，報成假的「現役已不見」。
        links = [d for d in dirnames if os.path.islink(os.path.join(dirpath, d))]
        dirnames[:] = [d for d in dirnames if d not in links]
        for name in links + dirnames + filenames:
            p = os.path.join(dirpath, name)
            rel = os.path.relpath(p, root)
            if os.path.islink(p):
                out[rel] = ("link", os.readlink(p))
            elif os.path.isfile(p):
                try:
                    out[rel] = ("file", os.path.getsize(p))
                except OSError:
                    out[rel] = ("file", -1)
    return out

total = {"only_backup": 0, "only_live": 0, "differ": 0, "same": 0}
# manifest 的 **key 同樣是不可信輸入**：它會被拼進 `os.path.join(dest, ...)`，`../../x`
# 這種 key 能讓比對的備份側走出展開目錄、把外面的檔名列出來。查表查不到固然也會略過，
# 但那是副作用不是防線——調換兩個判斷的順序、或加一個「沒登記就用預設」的 fallback 就
# 破功。**與 sidecar 的 `backup/install.py::_SAFE_KEY_RE` 同一條信任邊界、同一組字元**
# （一邊有一邊沒有同樣是漂移）；`extra` 的 name 走同一條規則。
SAFE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")


def safe_keys(mapping, label):
    """回形狀合法的 key；不合法的當場說明並跳過（**不整份拒絕**——一個壞 key 不該讓
    使用者連其餘正常帳號的差異都看不到）。"""
    out = []
    for k in mapping if isinstance(mapping, dict) else {}:
        if isinstance(k, str) and SAFE_KEY.fullmatch(k):
            out.append(k)
        else:
            print(f"\n[{k!r}] {label}名稱不合法，略過（名稱會被用來組路徑）")
    return out


# **只取 manifest 的 key**，位置一律從本機 config 查（理由見 `local_live_paths`）。
targets = [(k, LIVE_ACCOUNTS.get(k), os.path.join(dest, "accounts", k))
           for k in safe_keys(m.get("accounts", {}), "帳號")]
# 帳號目錄外的資產（~/.agents 這類）比照同一套比對
targets += [(f"帳號外:{k}", LIVE_EXTRA.get(k), os.path.join(dest, "extra", k))
            for k in safe_keys(m.get("extra", {}), "資產")]

for key, live, backed in targets:
    if live is None:
        # 本機沒有登記這個帳號／資產——沒有可信的現役側可比對。**不退回 manifest 的路徑**。
        print(f"\n[{key}] 本機沒有登記這一項，略過比對")
        continue
    if not os.path.isdir(backed):
        print(f"\n[{key}] 備份包裡沒有這個帳號")
        continue
    if not os.path.isdir(live):
        print(f"\n[{key}] 現役目錄不存在（{live}）——備份包裡的全部都是「只在備份裡有」")
        continue

    b, l = snapshot(backed), snapshot(live)
    only_b = sorted(set(b) - set(l))
    only_l = sorted(k for k in set(l) - set(b)
                    # 現役多出來的，若是我們本來就不收的項目，不算差異
                    if k.split(os.sep)[0] in {x.split(os.sep)[0] for x in b})
    differ = sorted(k for k in set(b) & set(l) if b[k] != l[k])

    print(f"\n[{key}] {live}")     # 印**本機**的位置（被比對的那一個），不是 manifest 的舊路徑
    for label, items, hint in (
        ("只在備份裡有（現役已不見）", only_b, "← 這些是你可能想搬回去的"),
        ("只在現役有（備份後新增）", only_l, ""),
        ("兩邊都有但不同", differ, ""),
    ):
        if not items:
            continue
        print(f"  {label}：{len(items)} 項  {hint}")
        for k in items[:8]:
            print(f"      {k}")
        if len(items) > 8:
            print(f"      …還有 {len(items) - 8} 項")
    total["only_backup"] += len(only_b)
    total["only_live"] += len(only_l)
    total["differ"] += len(differ)
    total["same"] += len(set(b) & set(l)) - len(differ)

print(f"\n合計：只在備份 {total['only_backup']}．只在現役 {total['only_live']}．"
      f"不同 {total['differ']}．相同 {total['same']}")
PY

echo
echo "── 接下來 ──────────────────────────────────────────"
echo "備份內容在 ${DEST}/accounts/<帳號>/"
echo "要搬哪些回去由你決定，例如："
echo "    cp -R \"${DEST}/accounts/work/skills/某個skill\" ~/.claude/skills/"
echo
echo "本腳本不會寫入任何現役目錄。確認搬完後可自行刪除 ${DEST}。"

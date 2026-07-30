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
    # realpath 對既有前綴解 symlink、對不存在的部分做字面正規化；轉小寫是因為 APFS
    # 預設不分大小寫（~/.claude 與 ~/.CLAUDE 是同一個目錄但字串不等）。
    return os.path.realpath(path).lower()


dest_key = key(dest)
if dest_key == key(os.sep):
    fail("不能展開到檔案系統根目錄。")
if dest_key == key(home):
    fail("不能展開到家目錄本身，請選一個專用的資料夾。")
for root in roots():
    # 與 paths.is_within_root 同一個寫法：先 rstrip 再接 os.sep。root 是 "/" 時不 rstrip
    # 會組出 "//"，任何絕對路徑都不以它開頭——整個 root 等於沒守（`config_dir: "/"` 只要
    # 帳號 API 收得下就會出現，那時 sidecar 判 inside_source、腳本卻放行）。
    root_key = key(root)
    base = root_key.rstrip(os.sep)
    if dest_key == root_key or dest_key.startswith(base + os.sep):
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
  mkdir -p "${staging}"

  echo "展開 $(basename "${BUNDLE}") → ${DEST}"
  # tar 自己的錯誤（`gzip: stdin: unexpected end of file` 之類）留著給人看，但要在後面補一句
  # 說得出「這代表什麼」的話——驗收要的是「明確說明」，而系統原文只說了「解壓失敗」。
  if ! tar xzf "${BUNDLE}" -C "${staging}"; then
    echo "備份包解不開，多半是它本身損壞（傳輸中斷、儲存媒介出錯）：${BUNDLE}" >&2
    echo "換一份備份包再試；上面那行是 tar 的原始錯誤。" >&2
    exit 1
  fi

  # 備份包必須自帶 manifest.json：它是差異報告的唯一依據，缺了它比對無從進行。
  # 在**發布前**檢查，不完整的包因此不會留下任何半套目錄。
  [ -f "${staging}/manifest.json" ] || {
    echo "這不是一份完整的備份包（缺 manifest.json）：${BUNDLE}" >&2; exit 1; }

  # DEST 已存在但為空（使用者用系統選擇器挑的位置必然已存在）時，mv 會把 staging 塞進
  # 它底下變成 DEST/<staging名>。先 rmdir 掉——只有真的空才會成功，非空在上面已擋掉。
  if [ -d "${DEST}" ]; then
    rmdir "${DEST}"
  fi
  mv "${staging}" "${DEST}"
fi

MANIFEST="${DEST}/manifest.json"
[ -f "${MANIFEST}" ] || { echo "展開目錄裡沒有 manifest.json：${DEST}" >&2; exit 1; }

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
python3 - "${DEST}" "${MANIFEST}" <<'PY'
import json, os, sys

dest, manifest_path = sys.argv[1], sys.argv[2]
m = json.load(open(manifest_path))

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
targets = [(k, v, os.path.join(dest, "accounts", k)) for k, v in m.get("accounts", {}).items()]
# 帳號目錄外的資產（~/.agents 這類）比照同一套比對
targets += [(f"帳號外:{k}", v, os.path.join(dest, "extra", k)) for k, v in m.get("extra", {}).items()]

for key, raw, backed in targets:
    live = os.path.expanduser(raw)
    if not os.path.isdir(backed):
        print(f"\n[{key}] 備份包裡沒有這個帳號")
        continue
    if not os.path.isdir(live):
        print(f"\n[{key}] 現役目錄不存在（{raw}）——備份包裡的全部都是「只在備份裡有」")
        continue

    b, l = snapshot(backed), snapshot(live)
    only_b = sorted(set(b) - set(l))
    only_l = sorted(k for k in set(l) - set(b)
                    # 現役多出來的，若是我們本來就不收的項目，不算差異
                    if k.split(os.sep)[0] in {x.split(os.sep)[0] for x in b})
    differ = sorted(k for k in set(b) & set(l) if b[k] != l[k])

    print(f"\n[{key}] {raw}")
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

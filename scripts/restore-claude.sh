#!/usr/bin/env bash
#
# 展開一個備份包並列出它與現役目錄的差異。
#
# 安全不變式：**不寫任何現役目錄**（ADR-0004）。備份包展開到一個獨立位置，差異report
# 給你看，搬什麼回去由你決定。還原是低頻操作，不值得為它承擔「選錯備份包就蓋掉現役
# 資料」的風險。
#
# 用法：
#   scripts/restore-claude.sh                      # 用最新的備份包
#   scripts/restore-claude.sh <備份包.tar.gz>      # 指定備份包
#   scripts/restore-claude.sh -o <展開目錄> ...    # 指定展開位置
#   scripts/restore-claude.sh --diff-only ...      # 只比差異，不展開（用既有的展開目錄）
#
# 環境變數：FLEDGE_BACKUP_DIR 覆寫預設備份目錄。

set -euo pipefail

BACKUP_DIR="${FLEDGE_BACKUP_DIR:-/Users/tc/NAS/work/claude-backups}"
BUNDLE=""
DEST=""
DIFF_ONLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    -o) DEST="$2"; shift 2 ;;
    --diff-only) DIFF_ONLY=true; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) BUNDLE="$1"; shift ;;
  esac
done

if [ -z "${BUNDLE}" ]; then
  BUNDLE=$(ls -1t "${BACKUP_DIR}"/claude-backup-*.tar.gz 2>/dev/null | head -1 || true)
  [ -n "${BUNDLE}" ] || { echo "在 ${BACKUP_DIR} 找不到任何備份包。" >&2; exit 1; }
fi
[ -f "${BUNDLE}" ] || { echo "找不到備份包：${BUNDLE}" >&2; exit 1; }

DEST="${DEST:-${HOME}/.claude-restore-$(basename "${BUNDLE}" .tar.gz | sed 's/^claude-backup-//')}"

expand_home() { case "$1" in "~/"*) echo "${HOME}/${1#\~/}" ;; "~") echo "${HOME}" ;; *) echo "$1" ;; esac; }

# ── 展開 ────────────────────────────────────────────────────────────────────
if [ "${DIFF_ONLY}" = false ]; then
  # 展開目標必須是空的或不存在——絕不往既有內容上疊
  if [ -e "${DEST}" ] && [ -n "$(ls -A "${DEST}" 2>/dev/null)" ]; then
    echo "拒絕執行：${DEST} 已存在且非空。" >&2
    echo "換一個位置：$0 -o <別的目錄> ${BUNDLE}" >&2
    exit 1
  fi
  mkdir -p "${DEST}"
  echo "展開 $(basename "${BUNDLE}") → ${DEST}"
  tar xzf "${BUNDLE}" -C "${DEST}"
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

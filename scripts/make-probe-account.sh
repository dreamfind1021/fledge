#!/usr/bin/env bash
#
# 共通設置卡（B-4 票 26／29）驗收用：造一個拋棄式帳號目錄，一次湊齊各種項目狀態。
#
# 為什麼需要它：精靈的套用一律送空 overwrite、不會蓋掉任何東西，但要看到「將重新指向」
# 「保留不動」這些狀態，得先有對應的檔案佈局。拿真實帳號目錄去造這些狀態，等於拿自己的
# 設定去冒險——「保留不動」的前提就是那裡有你的東西。
#
# 安全不變式：**本腳本只刪自己建立的目錄**。判準是目錄裡有哨兵檔 .fledge-probe；
# 目錄已存在卻沒有哨兵，一律拒絕執行，不論路徑看起來多像拋棄式目錄。
# （此腳本的第一版沒有這條，用真實帳號目錄測防呆時把 ~/.claude-tc 的內容 rm -rf 掉了。）
#
# 用法：
#   scripts/make-probe-account.sh            # 混合狀態（預設）
#   scripts/make-probe-account.sh --fresh    # 全新空目錄：每一項都待建立
#   scripts/make-probe-account.sh --clean    # 刪掉這個拋棄式目錄
#
# 造完後到設定頁把它加成一個帳號（config_dir 填印出的路徑），回引導頁的共通設置頁就看得到
# 對應狀態。驗完跑 --clean，再到設定頁移除該帳號。
#
# 目錄可用 FLEDGE_PROBE_DIR 覆寫，預設 ~/.claude-probe。

set -euo pipefail

PROBE_DIR="${FLEDGE_PROBE_DIR:-${HOME}/.claude-probe}"
SOURCE_DIR="${HOME}/.claude"
CONFIG_JSON="${HOME}/.fledge/config.json"
SENTINEL=".fledge-probe"
MODE="${1:-mixed}"

# 目錄是本腳本建立的嗎？這是唯一授權刪除的判準。
is_probe_dir() { [ -f "${PROBE_DIR}/${SENTINEL}" ]; }

# 目錄已存在卻不是我們建的 → 停手。這條擋在所有 rm 之前，且不依賴任何外部檔案存在與否。
assert_deletable() {
  if [ -e "${PROBE_DIR}" ] && ! is_probe_dir; then
    echo "拒絕執行：${PROBE_DIR} 已存在，且不是本腳本建立的" >&2
    echo "（沒有 ${SENTINEL} 哨兵檔。本腳本只刪自己造的目錄。）" >&2
    echo "換一個路徑：FLEDGE_PROBE_DIR=~/.claude-probe2 $0" >&2
    exit 1
  fi
}

# 第二道（輔助）：提醒使用者這個路徑是不是已登記的帳號目錄。讀不到設定檔不阻擋——
# 哨兵已經保證不會刪到別人的東西，而 first-run 狀態下本來就沒有設定檔。
warn_if_registered() {
  [ -f "${CONFIG_JSON}" ] || {
    echo "提醒：讀不到 ${CONFIG_JSON}（Fledge 尚未落檔），略過「已登記帳號」比對。"
    return 0
  }
  local hit
  hit=$(PROBE="${PROBE_DIR}" CONFIG="${CONFIG_JSON}" python3 - <<'PY' 2>/dev/null || true
import json, os
probe = os.path.realpath(os.environ["PROBE"])
try:
    cfg = json.load(open(os.environ["CONFIG"]))
except Exception:
    raise SystemExit(0)
for key, acc in cfg.get("accounts", {}).items():
    raw = (acc.get("config_dir") or "").strip()
    if not raw:
        continue
    # realpath 後比對：APFS 預設不分大小寫，~/.claude 與 ~/.CLAUDE 字串不同卻是同一個目錄
    if os.path.realpath(os.path.expanduser(raw)) == probe:
        print(key)
PY
  )
  if [ -n "${hit}" ]; then
    echo "拒絕執行：${PROBE_DIR} 是已登記帳號「${hit}」的設定目錄" >&2
    exit 1
  fi
}

assert_deletable
warn_if_registered

if [ "${MODE}" = "--clean" ]; then
  if [ ! -e "${PROBE_DIR}" ]; then
    echo "${PROBE_DIR} 不存在，無事可做。"
    exit 0
  fi
  rm -rf "${PROBE_DIR}"
  echo "已刪除 ${PROBE_DIR}"
  echo "記得到設定頁把這個帳號一併移除。"
  exit 0
fi

rm -rf "${PROBE_DIR}"
mkdir -p "${PROBE_DIR}"
printf '本目錄由 scripts/make-probe-account.sh 建立，供共通設置卡驗收用，可安全刪除。\n' \
  > "${PROBE_DIR}/${SENTINEL}"

if [ "${MODE}" = "--fresh" ]; then
  # 空目錄：symlink 項全部「將建立連結」、copy 項（CLAUDE.md）「將複製一份」
  echo "已建立 ${PROBE_DIR} （全新空目錄）"
  echo
  echo "預期畫面："
  printf '  %-14s %s\n' "commands"      "尚未建立 → 將建立連結"
  printf '  %-14s %s\n' "plugins"       "尚未建立 → 將建立連結"
  printf '  %-14s %s\n' "skills"        "尚未建立 → 將建立連結"
  printf '  %-14s %s\n' "settings.json" "尚未建立 → 將建立連結"
  printf '  %-14s %s\n' "CLAUDE.md"     "尚未建立 → 將複製一份"
  echo
  echo "按「套用共通設置」後每一列都該轉成「已建立連結」／「已複製一份」，清單並重新偵測。"
else
  # 混合狀態：一次看齊四種 chip。每一項對應後端 common_config.probe_entry 的一種 state。
  mkdir -p "${PROBE_DIR}/commands"                        # real_dir（非空）→ 需授權
  printf '# probe\n' > "${PROBE_DIR}/commands/probe.md"

  # plugins 不建立 → missing

  # wrong_link：連到別處、目標存在。用相對路徑，整個目錄改名搬走後這條連結仍然成立
  # （絕對路徑會在搬家後變成 broken_link，那是另一種狀態）
  mkdir -p "${PROBE_DIR}/.elsewhere/skills"
  ln -s ".elsewhere/skills" "${PROBE_DIR}/skills"

  ln -s "${SOURCE_DIR}/settings.json" "${PROBE_DIR}/settings.json"   # ok：已正確連到 source

  printf '# probe（內容刻意與 work 不同）\n' > "${PROBE_DIR}/CLAUDE.md"   # content_differs → 需授權

  echo "已建立 ${PROBE_DIR} （混合狀態）"
  echo
  echo "預期畫面："
  printf '  %-14s %s\n' "commands"      "你有自己的目錄，且不是空的 → 保留不動（琥珀）"
  printf '  %-14s %s\n' "plugins"       "尚未建立 → 將建立連結"
  printf '  %-14s %s\n' "skills"        "連結指向其他位置 → 將重新指向（琥珀）"
  printf '  %-14s %s\n' "settings.json" "已與 work 同步 → 已就緒"
  printf '  %-14s %s\n' "CLAUDE.md"     "你有自己的版本，內容不同 → 保留不動（琥珀）"
  echo
  if [ ! -e "${SOURCE_DIR}/settings.json" ]; then
    echo "注意：${SOURCE_DIR}/settings.json 不存在，settings.json 那列會是"
    echo "「work 沒有這一項 → 無法處理」。"
    echo
  fi
  echo "卡片底部應出現一段琥珀說明，講「保留不動」的項目要去設定頁逐項授權。"
  echo "按「套用共通設置」後：plugins 轉「已建立連結」、skills 轉「已重新指向」，"
  echo "commands 與 CLAUDE.md 維持「保留不動（需授權）」——精靈送空 overwrite，不蓋你的東西。"
fi

echo
echo "下一步：設定頁 → 新增帳號 → config_dir 填 ${PROBE_DIR} → 回引導頁的共通設置。"
echo "驗完：scripts/make-probe-account.sh --clean，並到設定頁移除該帳號。"

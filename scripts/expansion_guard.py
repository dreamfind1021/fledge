"""備份包展開量的判準——備份端與還原端**共用這一份**（xz 改版 spec §6.5）。

用法：python3 expansion_guard.py <展開後的目錄> <備份包檔>
放行回 0；會被擋回 1，原因印在 stderr（只有數字，不含任何檔案內容）。

兩支腳本都在**發布前**呼叫：`restore-claude.sh` 量解開後的 staging，`backup-claude.sh` 量即將
打包的 staging——兩棵樹內容相同，同一套判準得到同一個結論。規則只能有一份：抄兩份一定會
漂移，而漂移的樣子正好是「備份說可以、還原說不行」——還原時會被擋的包照樣顯示「備份成功」，
要等到需要還原那天才發現。

tar bomb：壓縮後幾 KB、展開後爆量。判準用**壓縮比**而不是絕對大小——後者會誤擋「真的有很多
資產」的誠實大包，而壓縮比正是 tar bomb 的特徵。

**宣稱等級**：這不是「防止磁碟耗盡」，也不是「防止 inode 耗盡」。還原端在解壓之後才量，那時
空間與 inode 都已經被佔掉了（磁碟真的滿的話是 tar 自己失敗，由既有的 cleanup 處理）。這一層擋
的是**不讓一個離譜的展開目錄留在磁碟上**——大得離譜或項目多得離譜都算。它擋得住「宣告小、
實際大」（量的是實際落地的東西，不看 header 宣告值），擋不住「解壓過程中就把磁碟塞爆」
（那需要 streaming 計量）。
"""
import os
import stat
import sys

# 8 MiB 以下不看比例：小包的壓縮固定開銷會讓比例失真。
EXPANSION_MIN_BYTES = 8 << 20
# 用真實資料實測（xz 等級 1，2026-11-16）：整份備份包 8.6 倍、全部對話紀錄 10 倍、最好壓的專案
# 19 倍、最好壓的單一對話檔 30 倍；gzip 更低（整份約 4 倍）。100 倍給整份包約 11 倍、給最極端的
# 單一檔約 3 倍的餘裕。人造的極端資料（大量重複文字）仍可能超過——所以備份端也用這一份判準
# 先擋，誤擋一定在備份當下現形，不會等到還原。
EXPANSION_MAX_RATIO = 100
# **大小配額擋不住「多」**：symlink、目錄與零大小檔案的 st_size 全是 0，幾十萬個這種成員可以讓
# 總量停在 0 而完全繞過比例判準，留下的正是一個離譜的展開目錄（inode 耗用、清理極慢）。
# 上限依實測定：2026-11-15 本機真實的兩個帳號打包後共 2.5 萬個項目，留 8 倍餘裕。
# `FLEDGE_MAX_ENTRIES` 只是**測試接縫**（比照 FLEDGE_BACKUP_SCRIPTS_DIR）——造 20 萬個成員的
# 測試會慢到不可接受。能設環境變數的人本來就能執行任意命令，它不是安全邊界。
MAX_ENTRIES = int(os.environ.get("FLEDGE_MAX_ENTRIES", "200000"))


def measure(tree):
    """回 (一般檔總大小, 項目數)。"""
    # 只加總**一般檔**的大小：目錄項本身的 st_size 在 APFS 有幾百 bytes，算進去會讓「很多
    # 空目錄」的包被誤判。symlink 不跟隨（lstat），它的 size 是目標字串長度。
    total = 0
    entries = 0
    seen = set()
    for dirpath, dirnames, filenames in os.walk(tree, followlinks=False):
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
    return total, entries


def main(argv):
    tree, bundle = argv[1], argv[2]
    total, entries = measure(tree)
    # **項目數的上限與大小無關**：零大小的成員不貢獻 total，只有這一道擋得住「多」。
    if entries > MAX_ENTRIES:
        print(f"這份備份包展開後有 {entries} 個項目，超過 {MAX_ENTRIES} 個的上限。", file=sys.stderr)
        return 1
    if total <= EXPANSION_MIN_BYTES:
        return 0
    try:
        packed = os.stat(bundle).st_size
    except OSError:
        return 0                 # 量不到來源就不做這個判斷，不擋合法的還原
    # 不用整數截斷比較——`total // packed > 100` 會讓實際 100.9 倍的包通過。
    if packed > 0 and total > packed * EXPANSION_MAX_RATIO:
        print(
            f"這份備份包展開後是它本身的 {total // packed} 倍"
            f"（{total // (1 << 20)} MiB ← {packed // 1024} KiB），超過 {EXPANSION_MAX_RATIO} 倍的上限。",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

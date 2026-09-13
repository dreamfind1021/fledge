---
source-id: example-source-2026    # 全域唯一 slug；更新用 -v2 後綴，不覆寫原檔
title: 來源標題
type: paper                        # paper | web | own | data
date: 2026-01-01                   # 來源自身日期
ingested: YYYY-MM-DD               # 餵入日（供 library last-active 衍生）
status: raw                        # raw | extracted | integrated | deferred | ignored
origin: <url 或路徑>
---

# 來源標題

<!--
  證據層：原檔/快照 + 抽取文字（不可變）。per-type 儲存：
    paper/PDF/報告 → 原檔另存同目錄 + 此處放抽取文字
    web → fetch 快照 markdown + 原 URL 填 origin + 抓取日
    own → 原樣（會議記錄/逐字稿/內部文件）
    data(CSV) → CSV 檔另存 + 此處放「資料註記」（欄位、來源、如何被綜合）
-->

---
name: handoff
description: 使用者要把手上的工作換到新對話繼續時觸發——說「要在新對話中…」「準備在新對話…」「新的對話」「上下文要滿了」「先做事前準備」「提供貼上的指令」「用 subagent 驅動開工」「SDD 開工」「在新對話用 Subagent 逐 task」，或 spec／plan 寫完要換對話實作、實作到一半要換對話續作、實作完要換對話驗收。只在「要換對話」時用；一般收工只留接續點的是 resume-note，不是這裡。使用者要的是工作日誌、週報——不觸發。
---

# handoff — 換對話的交接

## 定位

**一個指令跑完換對話前的準備，最後給一段可以直接貼進新對話的文字。**

與 `resume-note` 的關係：

| | `resume-note` | `handoff` |
|---|---|---|
| 做什麼 | 只寫 `.fledge/state.md` | 呼叫 `resume-note`，再做其餘準備，最後產貼上指令 |
| 什麼時候叫 | 任何收工 | 只在「要換對話繼續」時 |

**handoff 不重寫 `state.md` 的邏輯**——用 Skill 工具呼叫 `resume-note`。它是**覆寫**：舊的 `state.md`
整份會被換掉，包括末尾上一次的「貼進新對話的指令」段——那是對的。

## 流程（固定五步，順序不換）

### 1. 判情境

**先讀兩樣東西，再對表**：

- `.fledge/state.md` 現有的「下一步」——上次 handoff 留的。它指名的 plan 就是這次的 plan，**除非**那一刀已經結束（ledger 全部 `complete` 且分支已合併），那就忽略它、改找 mtime 最新的 plan
- `git status -sb`——工作區髒的話，把改動檔的 mtime 對照 **ledger 檔案的 mtime**（`.superpowers/sdd/<名>/progress.md`；它的內文沒有時間戳）：**晚於 ledger 就是 ledger 沒記的事**

ledger 裡的完成標記是 **`Task N: complete`**。`implementer DONE`／`DONE_WITH_CONCERNS` 是交回、審查還沒過，**不算完成**。

| 情境 | 判斷依據 | 貼上指令第一句 |
|---|---|---|
| **plan → 實作** | plan 檔存在（`docs/planning/plan-*.md` 或 `docs/superpowers/plans/*.md`）；沒有對應 ledger，或 ledger 沒有任何 `complete` | 執行 `<plan 路徑>` |
| **實作中斷 → 續作** | ledger 有 `complete` 也有未完成的 task | 接續 `<plan 路徑>`，Task 1–N 已完成，從 Task N+1 開始 |
| **實作完 → 驗收／合併** | ledger 全部 `complete`；`git branch --merged main` 沒有這條分支；工作區乾淨，**或髒的部分 ledger 已記載**（例如「docs 已改、刻意不 commit」）| 驗收分支 `<名稱>`，照 `state.md` 第 3 節走 |
| **完成後修法進行中** | ledger 全部 `complete`，但工作區有**晚於 ledger 且 ledger 沒記**的改動 | 收尾分支 `<名稱>`：工作區有 ledger 之後的未 commit 修法，先確認它做完了沒 |
| **多張票／開案** | 沒有單一 plan；使用者指了票號 | 問：哪張先、要不要先寫 spec |
| **其他** | 以上都對不上 | 問一句 |

plan 有多個時以 `state.md`「下一步」為準；沒指名就取 mtime 最新的，並在第 5 步標明「我選了 X，因為它最新」。
不要把所有沒 ledger 的舊 plan 都當「未執行」——ledger 制度比很多 plan 晚。

### 2. 推薦執行方式

按情境，不問，寫進指令；使用者在第 5 步可推翻。

| 情境 | 推薦 |
|---|---|
| plan → 實作、續作 | task ≥ 3 **且**每個 task 有自己的測試碼區塊 → `superpowers:subagent-driven-development`；否則 `superpowers:executing-plans` |
| 驗收／合併 | `superpowers:finishing-a-development-branch` |
| 完成後修法進行中 | 不掛 skill——新對話先收工作區，再回到驗收 |

### 3. 準備（四件，都做）

**(a) 接續點**：用 Skill 工具呼叫 `resume-note`，寫**完整版**。第 5 節「這一刀特有的陷阱」從這些來源掃，**每個都看**：

| 來源 | 找什麼 |
|---|---|
| spec 的附錄／known limitations | 被推翻的做法、「不要加回來」的東西 |
| plan 的 Global Constraints 與審查紀錄 | 每輪 finding 的處置、教訓 |
| ledger 裡標 `Ruling`／`USER DECISION`／`CORRECTION`／`deferred` 的段落 | 執行中的裁定、使用者的選擇、被修正的判斷、留給收官的清單 |
| 舊 `state.md` 第 5 節 | 上次留的，還成立的帶過來 |
| 未 commit 改動裡的程式碼註解 | 修法做到一半時理由常只在那裡。**沒有註解**（例外那條觸發）就寫「來源不明，待使用者說明」 |

「完成後修法進行中」情境：收工作區的細節（補測試、跑基準對數字、明列路徑 commit）寫進 **`state.md` 第 3 節**，不放貼上指令。

**(b) 測試基準**：指令來源依序找——`state.md` 第 4 節、plan 末尾「完成後」段、`CLAUDE.md`。**跑一次**，數字寫進 `state.md` 第 2 節：

```
測試基準（YYYY-MM-DD 實測，<工作區乾淨／含 N 個未 commit 改動>）：<指令> → N passed；…
```

工作區髒時標明基準含那些改動——跟 ledger 記的乾淨基準意義不同。跑不了就寫「未實測，開工前先跑」，ledger 有最近實測數字就抄來當參考。

**(c) 分支狀態**：寫進 `state.md` 第 2 節——分支名、對 `origin/main` 的未 push 數（`git rev-list --count origin/main..HEAD`；feature branch 通常沒 upstream，別用 `@{u}`）、工作區乾不乾淨、plan 第一個 task 會不會自己開分支。**不自己開分支。**

**(d) 記憶候選**：三類——使用者的指正、環境事實、踩到的坑。來源：這個 session 的對話、ledger 裡 `USER DECISION`／`CORRECTION` 段、程式碼註解裡「同一形狀第 N 次」這類句子。每條一句話加「為什麼值得記」。第 5 步讓使用者勾，勾了才寫。

### 4. 貼上指令（固定三句）

```
<第一句：情境表那句>（spec 在 <spec 路徑>；docs/ 被 .git/info/exclude 排除就加「兩份都在 docs/ 底下、不進 git，直接用路徑讀」）。接續點在 .fledge/state.md，先讀它的第 1、2、5 節。

<第二句，按情境>
  實作／續作：用 <執行 skill 全名>，從 Task <N> 開始<要跳過的加「（Task X 已併入 Y，跳過）」>。每個 task 回來先看它貼的測試輸出對不對 plan 的 Expected，再派下一個。
  驗收：不派 subagent——<N> 個 task 都完成了（ledger：<路徑>）。照 plan「完成後」段做真機驗收，通過後 <合併指令>、票 <NN> 改 done。
  完成後修法進行中：先照 state.md 第 3 節收工作區，再接驗收版那句。

<第三句：審查怎麼跑，從 state.md 第 4 節抄一句>
```

第三句的 `--base`：實作中途審單一 task 用前一個 commit，驗收與收尾用 `main`。
續作時只列**還沒跑過**的審查點（ledger 有記哪些跑過了）。

**就三句。** 這一刀特有的東西在 `state.md` 第 5 節，指令不重複。指令同時寫進 `state.md` 末尾的
`## 貼進新對話的指令` 段。

### 5. 一次確認

`AskUserQuestion` 一次問完，題目按狀況增減：

1. 執行方式（第 2 步的推薦放第一個並標推薦）——一定問
2. 記憶候選（`multiSelect`）——有候選才問
3. plan 有多個時：「我選了 X，對嗎」——有多個才問
4. 工作區髒且 ledger 沒記時——**不是 yes/no**：「這 N 個改動是什麼、做完了嗎？」選項：現在補測試 commit／留給新對話（寫進 `state.md` 第 3 節）／先讓我看 diff

確認後：勾到的記憶寫檔＋更新 `MEMORY.md` 索引；要 commit 就 commit（`git add` 明列路徑）；最後把三句指令**單獨放一個 code block**。

## 例外——這些情況要停下來問

- 情境表判不出來
- 測試指令三個來源都沒有
- 工作區改動晚於 ledger、diff 裡又沒有註解說明來源

## 常見錯誤

| 錯誤 | 為什麼錯 |
|---|---|
| 沒呼叫 `resume-note`，自己寫一份 `handoff.md` | 2026-08-28 發生過——觸發句沒「離場筆記」字眼，`resume-note` 沒被想起來。兩份接續機制會漂移 |
| 貼上指令塞進「不要照單全收的 N 點」 | 2026-08-22 指令變 20 行。那些屬於 `state.md` 第 5 節；指令只說「去讀」 |
| 測試基準只寫「跑過了」不寫數字 | 新對話分不出「掉下來的是它弄壞的」還是「本來就壞的」 |
| 記憶自動寫、不讓使用者勾 | 2026-08-15 一口氣改了四個記憶檔。判斷「值不值得記」的是使用者 |
| 2026-09-08 dry-run 的三個誤判：不看 `git status`、不讀「下一步」、驗收情境還寫「從 Task N 開始」 | 三條都是「只看 plan 與 ledger 就下判斷」。第 1 步的兩個「先讀」與第 4 步的按情境版本就是為它們加的 |
| 順便寫工作日誌 | 那是另一個決定，使用者自己叫 `writing-work-log-v2` |

## 一個例子（情境：plan → 實作）

觸發：「要在新的對話中用 Subagent 逐 task，先做準備工作，並提供貼上的指令給我」

判情境：`state.md`「下一步」指的是上一刀（已合併）→ 忽略；`git status` 乾淨；mtime 最新的 plan 是
`docs/planning/plan-tasks-inline-edit.md`、沒有對應 ledger → **plan → 實作**。12 個 task、每個有測試碼 → `subagent-driven-development`。

準備：`resume-note` 完整版（第 5 節從 spec 附錄 A 抓「四樣審查砍掉的不要加回來」、從 plan 審查紀錄抓「每輪 high 打在修法上」）；跑 `sidecar/.venv/bin/pytest sidecar/tests/ -q` 與 `npx vitest run` 記數字；`git rev-list --count origin/main..HEAD` = 1；記憶候選兩條。

貼上指令：

```
執行票 3 的實作計畫：docs/planning/plan-tasks-inline-edit.md（spec 在 docs/planning/tasks-inline-edit-design.md，兩份都在 docs/ 底下、被 .git/info/exclude 排除，直接用路徑讀）。接續點在 .fledge/state.md，先讀它的第 1、2、5 節。

用 superpowers:subagent-driven-development，從 Task 1 開始逐 task 派 subagent（Task 4 已併入 Task 3，跳過）。每個 task 回來先看它貼的測試輸出對不對 plan 的 Expected，再派下一個。

Task 5 與 Task 11 完成後依 plan 指示跑 Codex 對抗式審查——直接 Bash 背景跑 codex-companion.mjs，不要用 Skill 工具、不要 TaskStop。
```

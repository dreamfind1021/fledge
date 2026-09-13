# Fledge 附的 Claude Code skills

這裡的 skill **不會被 Fledge 自動安裝**。Fledge 不碰 `~/.claude/settings.json`、不碰
`CLAUDE.md`、不碰 `~/.claude/skills/`——要不要裝、裝哪一支，由使用者決定。

| skill | 做什麼 | 沒裝會怎樣 |
|---|---|---|
| `fledge-tasks` | 讓 Claude Code 讀寫專案的 `.fledge/tasks/`——「開一張票」「待辦有哪些」 | 待辦面板照用，只是 AI 開不了票 |
| `resume-note` | 收工時寫 `.fledge/state.md`——「寫離場筆記」 | 待辦面板的「下一步」欄永遠是空的 |
| `handoff` | 上下文快滿、要換新對話繼續時，寫完整版離場筆記並產一段貼進新對話的指令 | 不影響 |

三支怎麼串起來、檔案長什麼樣，見 [`guides/tasks-and-resume-note.md`](../guides/tasks-and-resume-note.md)。

## 安裝

三支一起：

```bash
cp -R skills/fledge-tasks skills/resume-note skills/handoff ~/.claude/skills/
```

或各裝各的：

```bash
cp -R skills/fledge-tasks ~/.claude/skills/    # 待辦
cp -R skills/resume-note  ~/.claude/skills/    # 離場筆記
cp -R skills/handoff      ~/.claude/skills/    # 換對話交接
```

多帳號（多個設定目錄）的話，讓其他帳號的 `skills/` 指向同一個目錄，往後裝任何 skill 都只要裝一次：

```bash
ln -s ~/.claude/skills ~/.claude-other/skills
```

引導精靈的「共通設置」那一步做的就是這件事（外加 settings、plugins）。不想用 symlink 就每個目錄各複製一份。

`handoff` 綁作者自己的開發流程（superpowers 的 spec → plan → 逐 task 執行、ledger 記進度、Codex 對抗式審查），照抄不一定合用，當參考。

## 你可能想自己加的一行

待辦與離場筆記都放在專案的 `.fledge/` 底下，**Fledge 不會替你改 `.gitignore`**。
不想讓它進版控的話，自己在專案的 `.gitignore` 加一行：

```
.fledge/
```

## 換機器就沒了

`.fledge/` 不進 git、Fledge 的備份功能也不收它（備份收的是 Claude 生態：帳號設定目錄與 `~/.agents`）。
換機器、誤刪都救不回。這是已知取捨，不是漏做。

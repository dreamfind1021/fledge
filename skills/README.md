# Fledge 附的 Claude Code skills

這裡的 skill **不會被 Fledge 自動安裝**。Fledge 不碰 `~/.claude/settings.json`、不碰你的
`CLAUDE.md`、不碰 `~/.claude/skills/`——要不要裝、裝哪一支，由你決定。

## fledge-tasks — 待辦面板的 AI 那條線

Fledge 的待辦面板讀寫每個專案底下的 `.fledge/tasks/*.md`。畫面上你可以自己建票、
改狀態、刪票；這支 skill 讓 **Claude Code 也能讀寫同一份檔案**——你在終端機裡說
「這個記一下」，切回面板就看得到。

### 安裝

```bash
cp -R skills/fledge-tasks ~/.claude/skills/
```

多帳號（多個設定目錄）的話，比較省事的做法是讓其他帳號的 `skills/` 指向同一個目錄：

```bash
ln -s ~/.claude/skills ~/.claude-other/skills
```

這樣往後裝任何 skill 都只要裝一次。不想用 symlink 就每個目錄各複製一份。

### 不裝會怎樣

面板完整可用——總覽、清單、建票、改狀態、刪除、用編輯器打開，一項都不少。
少掉的只有 AI 那條線：Claude 不知道檔案格式，開不了票也讀不到清單。

### 你可能想自己加的一行

待辦資料放在專案的 `.fledge/` 底下，**Fledge 不會替你改 `.gitignore`**。
不想讓它進版控的話，自己在專案的 `.gitignore` 加一行：

```
.fledge/
```

### 換機器就沒了

`.fledge/` 不進 git、Fledge 目前也不備份它。換機器、誤刪都救不回來。
這是已知取捨，不是漏做。

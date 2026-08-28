"""單一票檔的讀與寫（design §2.2、§6.1）。

**契約（design §6.1，parser 與 scanner 共同遵守）**：

1. 對任何檔案內容都不拋例外——讀不懂就回一張帶異常標記的票，永遠不是錯誤
2. 逐檔隔離：任一檔案的問題只影響該檔案那一列，絕不讓整個專案的掃描失敗
3. 「異常」不是「隱藏」：標記異常的票照常出現在清單裡

T1 只做 effective status（總覽的計數依賴它）。`source`／`created`／標題／內文／異常標記
留待 T2，見 `docs/planning/plan-tasks-panel.md` §4 的對照表。

**刻意不用 PyYAML**：它在 `sidecar/pyproject.toml` 只列在 `[project.optional-dependencies].dev`，
正式執行環境（打包後的 binary）沒有它。frontmatter 改用與 `memory/parser.py` 相同的
YAML-lite 逐行解析——同一個 repo 裡同一件事只有一種寫法。
"""
from __future__ import annotations

# 檔案裡的欄位名與值一律英文（design §2.2）；畫面顯示走 i18n 翻譯
VALID_STATUS = ("todo", "doing", "done")
DEFAULT_STATUS = "todo"


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """取第一段 `---` 圍籬之間的 YAML-lite ＋ 其後的內文。no-raise。

    做法比照 `memory/parser.py:_split_frontmatter`：只認 `key: value` 純量行，
    其餘（巢狀、list、註解）一律忽略。解不開就回空 dict，交由呼叫端用預設值。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    block = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    meta: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, _, val = line.partition(":")
        meta[key.strip().lower()] = val.strip()
    return meta, body


def effective_status(text: str) -> str:
    """票的 effective status（design §6.1 的唯一規則）。

    **只有 `status` 這個欄位本身判不出來時，才 fallback 成 `todo`。其他任何欄位的異常
    都不影響 status。** 否則 `status: done` 而 `source` 欄位壞掉的票會被無聲重開——
    那是 2026-08-27 第二輪 spec 審查抓到的缺陷。"""
    meta, _ = split_frontmatter(text)
    value = meta.get("status", "").strip().lower()
    return value if value in VALID_STATUS else DEFAULT_STATUS

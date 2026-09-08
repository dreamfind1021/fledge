"""單一票檔的讀與寫（design §2.2、§6）。

**契約（design §6.1，parser 與 scanner 共同遵守）**：

1. 對任何檔案內容都不拋例外——讀不懂就回一張帶異常標記的票，永遠不是錯誤
2. 逐檔隔離：任一檔案的問題只影響該檔案那一列，絕不讓整個專案的掃描失敗
3. 「異常」不是「隱藏」：標記異常的票照常出現在清單裡，依其 effective status 計數與分區

**絕對不做**：讀不懂就不顯示那張票。票會靜默消失，而這個功能存在的理由就是「不要忘記」。

**刻意不用 PyYAML**：它在 `sidecar/pyproject.toml` 只列在 `[project.optional-dependencies].dev`，
正式執行環境（打包後的 binary）沒有它。frontmatter 改用與 `memory/parser.py` 相同的
YAML-lite 逐行解析——同一個 repo 裡同一件事只有一種寫法。

**異常代碼一律英文**：它是回給前端的 error code，由前端的 i18n 映射成畫面文字
（`CLAUDE.md` §4.6.13：sidecar 不回 user-facing 中文 prose）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# 檔案裡的欄位名與值一律英文（design §2.2）；畫面顯示走 i18n 翻譯
VALID_STATUS = ("todo", "doing", "done")
DEFAULT_STATUS = "todo"
VALID_SOURCE = ("me", "ai")

# 異常代碼（design §6.2 的個案表；該表是契約的示例、不是窮舉）
ANOMALY_FRONTMATTER_MISSING = "frontmatter_missing"
ANOMALY_STATUS_INVALID = "status_invalid"
ANOMALY_SOURCE_INVALID = "source_invalid"
ANOMALY_CREATED_INVALID = "created_invalid"
ANOMALY_TITLE_MISSING = "title_missing"
ANOMALY_NUMBER_MISSING = "number_missing"
ANOMALY_NUMBER_DUPLICATE = "number_duplicate"  # 由 scanner 加（要看過整個資料夾才知道）
ANOMALY_UNREADABLE = "unreadable"              # 由 scanner 加（檔案根本讀不到）

_NUMBER_PREFIX = re.compile(r"^(\d+)")
_CREATED = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True)
class Task:
    """一張票。任何欄位判不出來都用預設值 ＋ 一個異常代碼，不拋例外、不隱藏。"""

    name: str                  # basename，例如 07-匯出檔名要能自訂.md
    number: int | None         # 檔名前綴的編號，**唯一真相源**（design §2.4）
    title: str
    body: str
    status: str                # effective status
    source: str                # me / ai；判不出來為空字串
    created: str               # YYYY-MM-DD；判不出來為空字串
    anomalies: tuple[str, ...]


def split_frontmatter(text: str) -> tuple[dict[str, str] | None, str]:
    """取第一段 `---` 圍籬之間的 YAML-lite ＋ 其後的內文。no-raise。

    做法比照 `memory/parser.py:_split_frontmatter`：只認 `key: value` 純量行。
    **沒有圍籬時回 `None` 而不是空 dict**——呼叫端要分得開「整段缺」與「有但欄位缺」，
    兩者的異常代碼不同（design §6.2）。"""
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end == -1:
        return None, text
    block = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    meta: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, _, val = line.partition(":")
        meta[key.strip().lower()] = val.strip()
    return meta, body


def parse_number(name: str) -> int | None:
    """檔名 `NN-<短名>.md` 的編號。沒有數字前綴回 None（design §6.2：顯示、編號欄空白）。"""
    m = _NUMBER_PREFIX.match(name)
    return int(m.group(1)) if m else None


def short_name(name: str) -> str:
    """檔名去掉編號前綴與副檔名，給「沒有 `# ` 標題行」時當標題用（design §6.2）。"""
    stem = name[:-3] if name.endswith(".md") else name
    return _NUMBER_PREFIX.sub("", stem).lstrip("-_ ") or stem


def _split_title(body: str) -> tuple[str, str]:
    """取第一個 `# ` 行當標題，其餘為內文。找不到回 ("", 原文)。"""
    lines = body.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("# "):
            return line[2:].strip(), "\n".join(lines[i + 1:]).strip("\n")
    return "", body


def effective_status(text: str) -> str:
    """票的 effective status（design §6.1 的唯一規則）。

    **只有 `status` 這個欄位本身判不出來時，才 fallback 成 `todo`。其他任何欄位的異常
    都不影響 status。** 否則 `status: done` 而 `source` 欄位壞掉的票會被無聲重開——
    那是 2026-08-27 第二輪 spec 審查抓到的缺陷。"""
    meta, _ = split_frontmatter(text)
    value = (meta or {}).get("status", "").strip().lower()
    return value if value in VALID_STATUS else DEFAULT_STATUS


def parse_task(name: str, text: str) -> Task:
    """把一個票檔解析成 Task。**對任何內容都不拋例外**（契約 1）。"""
    anomalies: list[str] = []

    number = parse_number(name)
    if number is None:
        anomalies.append(ANOMALY_NUMBER_MISSING)

    meta, rest = split_frontmatter(text)
    if meta is None:
        # 整段缺或圍籬不完整：缺的一律用預設值，只記一條——欄位層的異常在這裡是必然結果，
        # 逐欄再記一次只會讓畫面上的記號變成雜訊
        anomalies.append(ANOMALY_FRONTMATTER_MISSING)
        status, source, created = DEFAULT_STATUS, "", ""
    else:
        raw_status = meta.get("status", "").strip().lower()
        if raw_status in VALID_STATUS:
            status = raw_status
        else:
            status = DEFAULT_STATUS
            anomalies.append(ANOMALY_STATUS_INVALID)

        raw_source = meta.get("source", "").strip().lower()
        if raw_source in VALID_SOURCE:
            source = raw_source
        else:
            source = ""
            anomalies.append(ANOMALY_SOURCE_INVALID)

        raw_created = meta.get("created", "").strip()
        if _CREATED.match(raw_created):
            created = raw_created
        else:
            created = ""
            anomalies.append(ANOMALY_CREATED_INVALID)

    title, body = _split_title(rest)
    if not title:
        title = short_name(name)
        anomalies.append(ANOMALY_TITLE_MISSING)

    return Task(
        name=name, number=number, title=title, body=body,
        status=status, source=source, created=created, anomalies=tuple(anomalies),
    )


# ── 寫：產生一張新票（design §7.1 的短名規則、§2.2 的檔案格式）──────────
#
# 放在 parser.py 而不是 scanner.py：本檔的職責是「單一票檔的讀與寫」（design §10.1 第 1 項），
# scanner.py 管的是資料夾層級的 fd 操作。

# allowlist：只保留中日韓文字、英數字、底線與連字號（design §7.1）。
# 其餘一律換成連字號 → `/`、`.`、`\0` 在來源就不可能出現。
# CJK 用明碼區段而不是 \p{Han}：Python 的 re 不支援 Unicode property。
_SHORT_NAME_DENY = re.compile(
    r"[^0-9A-Za-z_\-"
    r"぀-ゟ"   # 平假名
    r"゠-ヿ"   # 片假名
    r"㐀-䶿"   # CJK 擴充 A
    r"一-鿿"   # CJK 基本區
    r"가-힯"   # 諺文
    r"豈-﫿"   # CJK 相容表意文字
    r"]"
)
SHORT_NAME_MAX = 40          # 字元數。CJK 在 UTF-8 是 3 bytes，40 字 ＝ 120 bytes，遠低於檔名上限
SHORT_NAME_FALLBACK = "untitled"


def make_short_name(title: str) -> str:
    """從標題產生檔名用的短名（design §7.1，allowlist 制）。

    **正規化後為空時用 `untitled`，不拒絕建票**：`title` 是使用者的自由文字，
    `A/B` 這種標題應該被正規化成 `A-B` 而不是被擋下來。"""
    s = _SHORT_NAME_DENY.sub("-", title)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s[:SHORT_NAME_MAX].strip("-") or SHORT_NAME_FALLBACK


def is_plain_name(name: str) -> bool:
    """T1（design §7.1）：必須是純檔名——不含 `/`、不是 `.` 或 `..`。

    **allowlist 與這道檢查是兩道，不是二選一。** `POST` 產生的檔名也必須過這裡：
    短名由 `title` 截取，若只靠 allowlist 而漏了這道，日後改寬 allowlist 就會開一個洞。"""
    return bool(name) and "/" not in name and "\0" not in name and name not in (".", "..")


def render_task(title: str, *, created: str, status: str = DEFAULT_STATUS, source: str = "me") -> str:
    """產生一張新票的檔案內容（design §2.2）。

    標題壓成單行：多行標題會讓 `# ` 之後的內容被 parser 當成內文，
    存回去再讀出來就不是原本那張票了（§9 要求「產生的檔案能被自己讀回」）。"""
    one_line = " ".join(title.split()) or SHORT_NAME_FALLBACK
    return f"---\nstatus: {status}\nsource: {source}\ncreated: {created}\n---\n\n# {one_line}\n"


_STATUS_LINE = re.compile(rb"^([ \t]*status[ \t]*:).*$", re.MULTILINE)


def replace_status(raw: bytes, status: str) -> bytes:
    """把票檔的 `status` 換成新值，**其餘位元組一字不動**（plan T4）。

    **刻意不重新產生整個檔案**：改狀態時把使用者寫在內文的東西弄丟，狀態會顯示正確、
    409 測試也全綠，而 `.fledge/` 不進 git，那些內容不可回復。這是 plan 標為
    「最危險的缺口」的那一條。

    **在位元組上做，不先解碼**：初版收 `str`，呼叫端用 `errors="replace"` 解碼再編碼回去
    ——無效 UTF-8 會被永久換成 U+FFFD。而 §6.1 的契約明說那種檔案要照常顯示，
    「改個狀態就把它毀掉」是實作偷偷違背契約，而且註解上還寫著「一字不動」
    （2026-08-31 Codex 實作階段審查抓到）。frontmatter 的圍籬與欄位名都是 ASCII，
    在位元組上比對不需要解碼。

    只在 frontmatter 圍籬內替換——內文裡若有一行 `status: x` 不該被動到。
    """
    st = status.encode("utf-8")
    if raw.startswith(b"---"):
        end = raw.find(b"\n---", 3)
        if end != -1:
            head, rest = raw[:end], raw[end:]
            new_head, hit = _STATUS_LINE.subn(lambda m: m.group(1) + b" " + st, head, count=1)
            if hit:
                return new_head + rest
            # 有 frontmatter 但沒有 status 行：插在圍籬內最前面，其餘原樣接上
            return b"---\nstatus: " + st + raw[3:]
    # 整段沒有 frontmatter（或圍籬不完整）：補一個，原文一字不動接在後面
    return b"---\nstatus: " + st + b"\n---\n\n" + raw


_FENCE_CLOSE = b"\n---\n"   # closing fence 必須獨占一行（spec §5.1）


def replace_body(raw: bytes, title: str, body: str) -> bytes:
    """把票檔圍籬之後的全部內容換成新的標題與內文，**frontmatter 位元組一字不動**（spec §5.1）。

    **在位元組上定位 closing fence，且要求它獨占一行。** 不可以照抄 `split_frontmatter()`
    的 `find("\\n---", 3)`——那個不要求獨占一行，`---suffix`、`----` 都會 match，
    重寫範圍會落在錯的地方。

    輸出形狀與 `render_task()` **完全相同**：空內文時 `\\n# 標題\\n`，非空時
    `\\n# 標題\\n\\n內文\\n`。這是 `can_round_trip()` 成立的前提——Fledge 自己建的票
    重組回去必須逐位元組相等。

    找不到完整行 fence 或標題壓成單行後為空 → `ValueError`。呼叫端決定怎麼處理：
    `can_round_trip()` 攔下回 False、`update_content()` 轉成 400。
    """
    if not raw.startswith(b"---"):
        raise ValueError("no_frontmatter")
    end = raw.find(_FENCE_CLOSE, 3)
    if end == -1:
        raise ValueError("no_closing_fence")
    head = raw[: end + len(_FENCE_CLOSE)]
    one_line = " ".join(title.split())
    if not one_line:
        raise ValueError("empty_title")
    tail = f"\n# {one_line}\n" + (f"\n{body}\n" if body else "")
    return head + tail.encode("utf-8")

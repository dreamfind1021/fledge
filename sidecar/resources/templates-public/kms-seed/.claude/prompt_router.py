#!/usr/bin/env python3
# Phase 2-A：UserPromptSubmit 輕量附錄指針（型1 routing）。
# advisory／fail-open：任何情況 exit 0、永不 block；偵測 library 操作硬詞 → 注入一行指針。
import sys, os, json, re, hashlib

# keyword 表（可調）：英文用詞邊界 regex（避免 splint/ingestion 誤中）、中文用子字串
EN_RE = re.compile(r'(?<![A-Za-z0-9_-])(ingest|lint|source-id)(?![A-Za-z0-9_-])', re.IGNORECASE)
ZH_KEYWORDS = ("餵來源", "餵入", "知識綜合", "問 library", "查 library")
POINTER = ("偵測到 library 操作 → 動手前先讀 .claude/library-workflow.md"
           "（Ingest／Query／Lint 細則、引用紀律）。")

def _matches(prompt):
    if EN_RE.search(prompt):
        return True
    return any(k in prompt for k in ZH_KEYWORDS)

def _sid_hash(data):
    # 挑第一個「非空字串」欄位（避免數字 session_id 先被 or 選中、又退成 unknown→多個壞 sid 共用 marker）
    sid = next((v for v in (data.get("session_id"), data.get("transcript_path"),
                            data.get("cwd")) if isinstance(v, str) and v), "unknown")
    return hashlib.sha256(sid.encode("utf-8", "replace")).hexdigest()[:32]

def _marker_path(h):
    tmpdir = os.environ.get("PROMPT_ROUTER_TMPDIR") or "/tmp"   # env 僅供測試覆寫；空字串也 fallback /tmp（不污染 vault）
    return os.path.join(tmpdir, f"claude-prompt-router-{h}-library.marker")

def emit(o):
    print(json.dumps(o, ensure_ascii=False))                 # 唯一 stdout；JSON 絕不含 decision

def main():
    data = json.load(sys.stdin)                              # 非 JSON → 例外 → fail-open
    prompt = data.get("prompt", "")
    if not isinstance(prompt, str) or not _matches(prompt):
        return
    marker = _marker_path(_sid_hash(data))
    try:
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)   # 搶建；race-free
        os.close(fd)
    except FileExistsError:
        return                                              # 已發過 → no-op
    # 其他 OSError（如 /tmp 不可寫）會往上拋 → 被 __main__ except 接 → fail-open no-op
    emit({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": POINTER}})

if __name__ == "__main__":
    try:
        main()
    except BaseException:                                    # fail-open：任何例外都吞
        pass
    sys.exit(0)                                              # 恆 exit 0、永不 block

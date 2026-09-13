#!/usr/bin/env python3
# vault 型2 dirty-state SSoT（spec v3 §5/§11 + Phase 2-D spec §2-5）
# need_type: session_card + derivation；偵測=piggyback、清除=顯式 derive-done（全域）
# per-session retry/override、carded path-sticky(X)、flock 防並發、深化 schema 驗證＋全面 fail-closed
import sys, json, os, tempfile, fcntl

VAULT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))   # 由腳本位置推導 vault root（<vault>/.claude/vault_dirty.py）；hook／手動呼叫皆正確、可移植
STATE = os.path.join(VAULT, ".vault-dirty.json")
LOCK  = STATE + ".lock"
RETRY_MAX = 2
DERIV_PATH = "(衍生 pass)"
NEED_TYPES = ("session_card", "derivation")

def _default():
    return {"items": [], "retry_by_session": {}, "override_by_session": {}, "carded_by_session": {}}

def _valid(d):                                   # AC-1（plan review 再深化）：容器＋metadata value 型別＋每筆 item
    if not isinstance(d, dict) or not isinstance(d.get("items"), list): return False
    rb, ob, cb = d.get("retry_by_session"), d.get("override_by_session"), d.get("carded_by_session")
    # retry value 須 int（排除 bool：bool 是 int 子類，True 不算合法 retry）；否則 n>=RETRY_MAX 會 TypeError
    if not isinstance(rb, dict) or not all(isinstance(k,str) and isinstance(v,int) and not isinstance(v,bool) for k,v in rb.items()): return False
    # override value 須 bool（字串 "false" 會 truthy 誤放）
    if not isinstance(ob, dict) or not all(isinstance(k,str) and isinstance(v,bool) for k,v in ob.items()): return False
    if not isinstance(cb, dict) or not all(isinstance(k,str) and isinstance(v,list) and all(isinstance(p,str) for p in v) for k,v in cb.items()): return False
    for it in d["items"]:
        if not isinstance(it, dict): return False
        if not all(isinstance(it.get(k), str) for k in ("path","need_type","session_id")): return False
        if it["need_type"] not in NEED_TYPES: return False
    return True

def load():
    # 不存在→乾淨；parse 壞 OR schema 壞→回 err（呼叫端 fail-closed；mutating 不可覆寫）
    if not os.path.exists(STATE): return _default(), None
    try:
        with open(STATE) as f: d = json.load(f)
    except Exception as e:
        return _default(), f"parse:{e}"
    if isinstance(d, dict) and "carded_by_session" not in d:
        d["carded_by_session"] = {}              # 向後相容：Phase 1 在途 state 補鍵後再驗
    if not _valid(d): return _default(), "schema-invalid"
    return d, None

def save(state):
    d = os.path.dirname(STATE)
    fd, tmp = tempfile.mkstemp(dir=d)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, STATE)
        dfd = os.open(d, os.O_DIRECTORY)          # fsync parent dir（crash durability）
        try: os.fsync(dfd)
        finally: os.close(dfd)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise

def with_lock(fn):
    with open(LOCK, "w") as lk:                  # flock 包 load-modify-save，防並發 lost update
        fcntl.flock(lk, fcntl.LOCK_EX)
        try: return fn()
        finally: fcntl.flock(lk, fcntl.LOCK_UN)

def emit(o):                                      # hook 輸出：中文不 escape（Claude／人都好讀、測試可驗）
    print(json.dumps(o, ensure_ascii=False))

def rel(path):
    if not path: return None
    p = os.path.realpath(path)                    # 安全相對路徑；越界回 None
    try:
        if os.path.commonpath([VAULT, p]) != VAULT: return None
    except ValueError: return None
    return os.path.relpath(p, VAULT)

def is_content_file(r):
    if r is None: return False
    if not (r.startswith("topics/") or r.startswith("library/")): return False
    if "_TEMPLATE" in r.split("/"): return False
    if not r.endswith(".md"): return False
    return os.path.basename(r) not in ("_INDEX.md","_CONNECTIONS.md","_TAGS.md","_LINT.md","_manifest.md")

def topic_of(r):
    return "/".join(r.split("/")[:2]) + "/"       # topics/foo/、library/bar/

def is_derivation_source(r):                      # 已通過 is_content_file；卡片在 cmd_mark 另分支
    base = os.path.basename(r)
    if base == "CONTEXT.md": return True          # frontmatter→_INDEX/_TAGS、[[]]→_CONNECTIONS
    if r.startswith("library/"):
        if base in ("overview.md","queries.md"): return True   # [[]]→_CONNECTIONS
        parts = r.split("/")
        if "concepts" in parts or "source-notes" in parts: return True
        if "/sources/" in r: return True          # frontmatter→_manifest
    return False

def _has_deriv(state, sid):
    return any(it["need_type"]=="derivation" and it["session_id"]==sid for it in state["items"])

def _deriv_item(sid):
    return {"path": DERIV_PATH, "need_type": "derivation", "session_id": sid}

def stdin_json():
    try: return json.load(sys.stdin)
    except Exception: return {}

def cmd_mark():
    h = stdin_json(); sid = h.get("session_id","")
    r = rel(h.get("tool_input",{}).get("file_path",""))
    if not is_content_file(r): return             # 寫衍生產物/索引/範本/非內容 → no-op
    def mut():
        state,err = load()
        if err:                                   # 壞 state→no-op，絕不覆寫證據
            sys.stderr.write(f"vault_dirty mark skip: {err}\n"); return
        topic = topic_of(r); changed = False; added = False   # added＝有新增 dirty item（→ pop override）
        if "/sessions/" in r:                     # (a) 寫卡片＝收尾（僅 topics 有 sessions/）
            cleared = [it["path"] for it in state["items"]
                       if it["need_type"]=="session_card" and it["session_id"]==sid
                       and it["path"].startswith(topic)]
            if cleared:
                state["items"] = [it for it in state["items"]
                                  if not (it["need_type"]=="session_card" and it["session_id"]==sid
                                          and it["path"].startswith(topic))]
                changed = True
            carded = state["carded_by_session"].setdefault(sid, [])
            for p in cleared:                     # X：卡片涵蓋的 path 記下（path 級）
                if p not in carded: carded.append(p)
            if not _has_deriv(state, sid):        # 卡片日期動到 _INDEX last-active → 標 derivation
                state["items"].append(_deriv_item(sid)); changed = True; added = True
        else:
            # (b) 一般內容編輯
            if r.startswith("topics/"):           # L1-a：只有 topics 有卡片機制；library 無 sessions/ 故不標 session_card
                carded = state["carded_by_session"].get(sid, [])
                if r not in carded:               # X path 級：卡片已涵蓋的 path 不重標
                    key = (r,"session_card",sid)
                    if key not in {(it["path"],it["need_type"],it["session_id"]) for it in state["items"]}:
                        state["items"].append({"path":r,"need_type":"session_card","session_id":sid}); changed = True; added = True
            if is_derivation_source(r) and not _has_deriv(state, sid):   # topics CONTEXT + 全部 library 來源
                state["items"].append(_deriv_item(sid)); changed = True; added = True
        if added:                                 # L1-b：新增 dirty → 作廢舊 override（新工作重啟 gate，防 stale override 靜默放行）
            state["override_by_session"].pop(sid, None)
        if changed:
            state["retry_by_session"].pop(sid, None); save(state)
    with_lock(mut)

def cmd_derive_done():                            # 用法：vault_dirty.py derive-done（無參數、全域清）
    def mut():
        state,err = load()
        if err:                                   # 壞 state→no-op
            sys.stderr.write(f"vault_dirty derive-done skip: {err}\n"); return
        n = len(state["items"])
        state["items"] = [it for it in state["items"] if it["need_type"]!="derivation"]
        if len(state["items"]) != n: save(state)  # retry/override/carded 不在此 prune（留 restore）
    with_lock(mut)

def cmd_gate():
    h = stdin_json()
    if h.get("stop_hook_active"): return          # 防迴圈
    sid = h.get("session_id","")
    def chk():
        state,err = load()
        if err:                                   # fail-closed（block，不靜默放行）
            emit({"decision":"block",
                "reason":f"dirty-state 異常（{err}）；為安全暫不放行，請檢查 .vault-dirty.json 或移除 Stop gate。"}); return
        mine = [it for it in state["items"] if it["session_id"]==sid]
        if not mine: return
        if state["override_by_session"].get(sid): return
        n = state["retry_by_session"].get(sid,0)
        if n >= RETRY_MAX: return                 # 降級放行：留 dirty 給下次 SessionStart
        state["retry_by_session"][sid] = n+1; save(state)
        cards = sorted(it["path"] for it in mine if it["need_type"]=="session_card")
        lines = []
        if cards: lines.append("待建/補卡片：" + "、".join(cards))
        if any(it["need_type"]=="derivation" for it in mine):
            lines.append("待跑衍生 pass（重建 _INDEX/_CONNECTIONS/_TAGS/_manifest **四檔全部完成後**）→ 執行 `python3 .claude/vault_dirty.py derive-done`")
        emit({"decision":"block",
            "reason":"本 session 有未完成收尾：\n" + "\n".join("・"+l for l in lines)
                     + f"\n請依 CLAUDE.md 收尾再停（卡片先、衍生 pass 最後）；使用者說『不用收尾』則跑 `python3 .claude/vault_dirty.py override {sid}`。"})
    with_lock(chk)

def cmd_restore():
    def mut():
        state,err = load()
        if err:
            emit({"hookSpecificOutput":{"hookEventName":"SessionStart",
                "additionalContext":f"⚠️ dirty-state 異常（{err}），請檢查 .vault-dirty.json。"}}); return
        live = {it["session_id"] for it in state["items"]}     # 只在此 prune（不在 mutation，避免破壞當前 session X 黏著）
        pruned = False
        for k in ("override_by_session","retry_by_session","carded_by_session"):
            nv = {s:v for s,v in state[k].items() if s in live}
            if nv != state[k]: state[k] = nv; pruned = True
        if pruned: save(state)
        if not state["items"]: return
        cards = sorted({it["path"] for it in state["items"] if it["need_type"]=="session_card"})
        lines = []
        if cards: lines.append("待建卡片：" + "、".join(cards))
        if any(it["need_type"]=="derivation" for it in state["items"]):
            lines.append("待跑衍生 pass（重建 _INDEX/_CONNECTIONS/_TAGS/_manifest 後 `derive-done`）")
        emit({"hookSpecificOutput":{"hookEventName":"SessionStart",
            "additionalContext":"【上次未完成收尾】\n" + "\n".join("・"+l for l in lines) + "\n請確認是否補收尾。"}})
    with_lock(mut)

def cmd_override():                               # 用法：vault_dirty.py override <session_id>
    sid = sys.argv[2] if len(sys.argv)>2 else ""
    if not sid: return
    def mut():
        state,err = load()
        if err:                                   # 壞 state→no-op
            sys.stderr.write(f"vault_dirty override skip: {err}\n"); return
        state["override_by_session"][sid]=True; save(state)
    with_lock(mut)

CMDS = {"mark":cmd_mark,"gate":cmd_gate,"restore":cmd_restore,"override":cmd_override,"derive-done":cmd_derive_done}
if __name__=="__main__":
    a = sys.argv
    if len(a)>1 and a[1] in CMDS:
        if a[1]=="derive-done" and len(a)>2:      # AC-2：嚴格 arity（全域清、不收參數）
            sys.stderr.write("derive-done 不收參數（全域清，清所有 session 的 derivation 債）\n"); sys.exit(2)
        CMDS[a[1]]()

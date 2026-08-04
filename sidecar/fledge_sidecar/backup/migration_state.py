"""移機的「進行中」簿記與狀態判定（票 07，增補 spec §3）。

**與 provenance journal 分工**：journal 管 provenance（哪個 node 是本次 transaction 裝的，
symlink 授權與跨輪隔離的判準），這裡管「使用者剛才在精靈裡填了什麼」——展開位置與專案路徑
對應。兩者都在 `~/.fledge/`，但職責不重疊，也**不共用判準**。

**為什麼不寫進 journal**：journal 的解析路徑是票 09 R2 硬化過的安全關鍵程式碼（任何不完整
的行即全體 fail-closed），為了帶 metadata 開一個 header 例外，是在已硬化的防線上動刀。

**內容完全不被信任**（§3.4）：`source_root` 與 `mapping` 只拿來**預填** install 頁的表單，
使用者仍要看預覽、按下安裝，而真正的驗證全在 `install.plan()` 既有的那一套（bundle 形狀、
身分綁定、mapping 三態驗證、落點重疊、containment）。竄改它得不到任何 install 端點本來就
不允許的東西。所以讀取一律 **fail-safe**：讀不出、JSON 壞掉、形狀不對 → 一律當作沒有。

**寫入則相反，必須 fail-closed**：這份簿記是「可續作」這個保證的前提。寫不進去卻照樣安裝，
硬中斷之後就只剩 journal → 沒有續作資訊 → 而 config 早已落檔、重走精靈會撞 `adopt-config`
的 409，正好重現這張票要消除的死路。所以寫入失敗一律往上拋，由 route 擋在 `install()` 之前。
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from fledge_sidecar.backup import install

logger = logging.getLogger(__name__)

MARKER_NAME = "migration-in-progress.json"


def marker_path() -> Path:
    """放 `~/.fledge/`：不放 staging（唯讀不變式），不放現役目錄（使用者的，不該被
    我們的簿記污染）。與 journal 同一個目錄，兩者一起被下一次安裝覆蓋或清除。"""
    return Path.home() / ".fledge" / MARKER_NAME


def write_marker(transaction_id: str, source_root: str,
                 mapping: list[tuple[str, str]]) -> None:
    """記下這一輪的續作資訊。**atomic write**：寫暫存 → fsync 檔案 → rename → fsync 父目錄。

    任何一步失敗都讓 `OSError` 往上拋——呼叫端必須在 `install()` **之前**擋下來（§3.2）。
    比 `app_config.save()` 多兩道 fsync，因為這份簿記正是為了「硬中斷之後還能接回去」而
    存在，而硬中斷包含斷電：少了檔案 fsync，rename 出現了但內容還在 page cache＝等於沒寫；
    少了目錄 fsync，rename 這個**目錄項**本身不保證落盤（Codex 票 07 R1 F3）。目錄 fsync
    不受支援時降級——那是「這個檔案系統做不到」不是「寫入失敗」。"""
    path = marker_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "transaction_id": transaction_id,
        "source_root": source_root,
        "mapping": [{"old": old, "new": new} for old, new in mapping],
        "created": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    }
    tmp = path.with_name(path.name + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        # **目錄項的持久性**（Codex 票 07 R1 F3）：`os.replace` 之後不 fsync 父目錄的話，
        # 斷電時 rename 本身不保證落盤——marker 可能整個消失（→ 沒有續作資訊）或舊的那份
        # 存活（→ 指向別輪）。這份簿記的存在理由就是「硬中斷之後接得回去」，而硬中斷包含
        # 斷電：**宣稱與實際保證等級要逐字對齊**，少了這一步 docstring 就是在承諾做不到的事。
        # 不受支援時降級（部分網路磁碟／exFAT 的目錄 fsync 回 EINVAL）——那是「這個檔案
        # 系統做不到」不是「寫入失敗」，比照 `install.py` 對每個目錄 fsync 的同一立場。
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        except OSError:
            logger.warning("移機續作簿記的目錄 fsync 不受支援，降級", exc_info=True)
        finally:
            os.close(dir_fd)
    except BaseException:
        # 失敗時不留半寫的暫存檔——下一次查詢看到形狀不對的東西只會多一次誤判
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _valid(data: object) -> bool:
    """形狀檢查。**逐欄驗**——這份資料可被手編，少一道就會讓 `.strip()`／索引在
    別的地方炸成非合約 500。"""
    if not isinstance(data, dict):
        return False
    if not isinstance(data.get("transaction_id"), str) or not data["transaction_id"]:
        return False
    if not isinstance(data.get("source_root"), str) or not data["source_root"]:
        return False
    mapping = data.get("mapping")
    if not isinstance(mapping, list):
        return False
    return all(isinstance(m, dict) and isinstance(m.get("old"), str)
               and isinstance(m.get("new"), str) for m in mapping)


def read_marker() -> dict | None:
    """fail-safe 讀取：不存在、讀不出、JSON 壞掉、形狀不對 → `None`（＝沒有進行中的移機）。

    `~/.fledge` 整個不可讀也走這條——唯讀的狀態查詢不該讓還原卡壞掉（§3.3.2）。"""
    try:
        data = json.loads(marker_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, UnicodeError):
        logger.warning("移機續作簿記讀不出來，視同沒有", exc_info=True)
        return None
    return data if _valid(data) else None


def clear_marker() -> None:
    """刪除。**冪等**：不存在不算錯（重跑、續作都可能走到已經沒有 marker 的狀態）。"""
    try:
        marker_path().unlink()
    except FileNotFoundError:
        pass
    except OSError:
        # 刪不掉只會留下一個殘骸，下一次 install 的 atomic write 會覆蓋它；
        # 為此讓一次成功的安裝變成 500 不划算（§3.2 的殘餘窗口，表現是良性的）
        logger.warning("移機續作簿記刪不掉，留給下一次安裝覆蓋", exc_info=True)


def status() -> dict:
    """§3.3.1 的狀態機。**唯讀**：不寫、不清、不改任何東西。

    判定順序即下表順序。任何 I/O 失敗都降級成某個 state，**絕不拋**——這是還原卡每次
    開啟都會打的唯讀查詢，它掛掉不該讓整張卡壞掉。

    | state | 條件 |
    |---|---|
    | `unfinished_unknown` | 沒有可用的 marker、或 marker 指的 journal 不在，但有**任何**未清除的 journal |
    | `none` | 沒有可用的 marker，也沒有任何 journal |
    | `stale_marker` | marker 可用、它指的 journal 不在，而且**沒有任何**未清除的 journal |
    | `source_missing` | matching journal 在，但 `source_root` 已經不是有效的 bundle |
    | `journal_unreadable` | matching journal 在但解不出（判準同續作時實際會走的路徑） |
    | `resumable` | 三者都成立，附上預填用的 `source_root` 與 `mapping` |

    **判準一律是 matching journal**（§3.3）：由 marker 的 `transaction_id` 精確定位。
    ⚠ 不可以拿 `has_unfinished_journal()` 判續作——那支的粒度是「有沒有**任何**一輪沒
    收尾」，刻意放寬、只服務暫存殘骸掃描的 gating。拿它判續作，marker 指向 A 而磁碟上
    只有 B 的 journal 時會誤報可續作，而續作重算出來的還是 A、讀不到 B。
    """
    marker = read_marker()
    if marker is None:
        return {"state": "unfinished_unknown" if install.has_unfinished_journal()
                else "none"}
    tid = marker["transaction_id"]
    if not install.journal_path(tid).exists():
        # marker 在、它指的 journal 不在，有**兩種**來源（Codex 票 07 R1 F1）：
        #   ① 那一輪完整成功了（journal 被清），殘留的 marker 是刪除失敗的殘骸
        #   ② 它**根本還沒建起來**——`write_marker()` 跑在 `install()` 之前，而 journal 是
        #      `install()` 內部才開的；安裝正要開始、或 install 在開 journal 前就失敗
        #      （來源身分在 plan→install 之間變了），都落在這個形狀
        # 兩者都不該說「可續作」，但**不能一律判成「視同完成」**：②發生在第二輪時，新
        # marker 已經蓋掉第一輪的，一律不顯示就把第一輪那個沒收尾的 journal 整個遮蔽了。
        # 所以退一步看「**還有沒有任何**一輪沒收尾」——有就照實說（雖然給不出續作資訊）。
        # **不在這裡清除 marker**：唯讀端點就該是唯讀的，而它無害，下一次 install 會覆蓋。
        return {"state": "unfinished_unknown" if install.has_unfinished_journal()
                else "stale_marker"}
    try:
        install.read_manifest(marker["source_root"])
    except (ValueError, OSError):
        # 展開的備份包被刪／被換／不是 bundle 形狀 → 續作會立刻撞 source_not_a_bundle，
        # 不如現在就說清楚並引導重新選包
        return {"state": "source_missing"}
    if not install.journal_readable(tid):
        return {"state": "journal_unreadable"}
    return {
        "state": "resumable",
        "source_root": marker["source_root"],
        # 續作資訊**只在這個 state 出現**（§3.3.2）：其餘狀態帶著它們，前端就可能拿一份
        # 不該用的預填值去填表單
        "mapping": marker["mapping"],
    }

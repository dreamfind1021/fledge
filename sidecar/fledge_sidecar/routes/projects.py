import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.dir_tree import list_dir_entries
from fledge_sidecar.paths import expand_and_validate, is_within_any_root, probe_dir, resolve_best_effort
from fledge_sidecar.project_scanner import scan_all, scan_root

router = APIRouter()


class PreviewBody(BaseModel):
    path: str


@router.get("/api/projects")
def list_projects():
    config = AppConfig.load()
    projects, permission_error = scan_all(config)
    return {"projects": projects, "permission_error": permission_error}


@router.post("/api/projects/scan-preview")
def scan_preview(body: PreviewBody):
    """試掃單一路徑回專案數（不落檔）。回 status 判別碼，讓 onboarding 在加入 draft 前
    就知道路徑能不能用（與 add 驗證對齊；onboard 原子、一個 typo 整批失敗）。
    status ∈ ok|denied|missing|not_dir|invalid。"""
    try:
        abs_ = expand_and_validate(body.path)
    except ValueError:
        return {"path": "", "count": 0, "status": "invalid"}  # 空/相對
    st = probe_dir(abs_)  # 先分類（與 paths.py 原則一致：probe 在 resolve 前）
    canonical = resolve_best_effort(abs_)  # 永不 raise
    if st in ("missing", "not_dir"):
        return {"path": canonical, "count": 0, "status": st}
    if st == "denied":
        return {"path": canonical, "count": 0, "status": "denied"}
    try:  # st == "dir" → 實際試掃
        count = len(scan_root(Path(abs_), ""))
        return {"path": canonical, "count": count, "status": "ok"}
    except PermissionError:  # stat 過但 iterdir 不可讀
        return {"path": canonical, "count": 0, "status": "denied"}
    except OSError:
        return {"path": canonical, "count": 0, "status": "missing"}


class TreeBody(BaseModel):
    path: str


@router.post("/api/projects/tree")
def project_tree(body: TreeBody):
    """列單層目錄（lazy 檔案樹）。containment 順序固定：expand → realpath → 限 allowed roots。
    回 status：ok（200）/ invalid（400）/ forbidden（403）/ denied|missing|not_dir（200）。
    設計見 docs/planning/sidebar-tree-and-tab-dnd-design.md §7.1。"""
    try:
        abs_ = expand_and_validate(body.path)
    except ValueError:
        raise HTTPException(status_code=400, detail={"status": "invalid"})

    real = resolve_best_effort(abs_)  # 永不 raise；支援不存在 leaf（§7.1 R3-F2）
    config = AppConfig.load()

    # allowed roots = roots ∪ manual（config 已 canonical，再 resolve 一次保險）。
    # 不特別 deny kms_root：它可同時是 sidebar 專案（如「創意發想」既是 KMS vault 又是工作專案），
    # 使用者有權瀏覽其檔案樹。containment（限 allowed roots＝使用者自己的 roots/manual）是唯一且
    # 足夠的安全邊界——撤銷 PR review F1 的 kms deny（基於「kms 與專案互斥」的錯誤假設，見 spec §15）。
    roots = [resolve_best_effort(r["path"]) for r in config.roots]
    roots += [resolve_best_effort(m["path"]) for m in config.manual_projects]
    if not is_within_any_root(real, roots):
        raise HTTPException(status_code=403, detail={"status": "forbidden"})

    # probe + 列出（內容層錯誤回 200 帶 status，§7.1 L2）
    st = probe_dir(abs_)
    if st in ("missing", "not_dir", "denied"):
        return {"path": real, "entries": [], "status": st}
    try:
        return {"path": real, "entries": list_dir_entries(Path(abs_)), "status": "ok"}
    except PermissionError:
        return {"path": real, "entries": [], "status": "denied"}
    except OSError:
        return {"path": real, "entries": [], "status": "missing"}


class OpenBody(BaseModel):
    path: str


def _run_open(argv: list[str]) -> subprocess.CompletedProcess:
    """實際 exec。獨立成函式是為了讓測試能攔下來斷言「擋掉的路徑真的沒有 exec」——
    只斷言 HTTP 回 403 證明不了那件事。"""
    return subprocess.run(argv, check=False)


@router.post("/api/open")
def open_file(body: OpenBody):
    """用系統預設程式打開一個檔案。**這是「用編輯器打開」的唯一入口**（票 01）。

    為什麼在 sidecar 而不是前端直接呼叫 Tauri 的 opener：capability 只能寫靜態 glob，
    寫出來的邊界與真正的邊界兩個方向都對不上——`$HOME/**` 放行整個家目錄（太寬），
    又讓家目錄以外的 root 完全用不了（太窄）。containment 的真相住在 config，
    只有 sidecar 讀得到，所以判斷要在這裡做。

    邊界與檔案樹**共用同一套** `is_within_any_root`（見 `project_tree`）：
    使用者自己的 roots ∪ manual。規則寫兩份必然漂移。

    順序固定：expand → realpath → 限 allowed roots。**resolve 一定要在 containment 之前**——
    反過來的話，root 裡的一條 symlink 就能指到外面而檢查照樣過。

    ## 已知的殘餘風險：TOCTOU（2026-09-03 Codex 審查 high，知情接受）

    我們驗的是**路徑字串**，然後把同一個字串交給 `open`，由它自己重新解析一次。
    驗完到 exec 之間，能寫入該目錄的人可以把目標換成指向 roots 外的 symlink，
    `open` 會跟著走。**這個窗口關不掉**：`open` 只吃路徑、不吃 fd，
    釘住的 fd 交不出去（`/dev/fd/N` 沒有副檔名，選不到正確的預設程式）。

    為什麼接受：
    1. **不是本次引入的**。改之前是 Tauri capability 的 scope 檢查，同樣是比對路徑字串
       之後由 OS 開啟同一個路徑，同一個窗口一直都在。這次是把邊界搬到讀得到 config 的
       地方，不是把它變差。
    2. 前提是攻擊者**已經能寫入使用者自己的 roots**。到那個位置的人本來就能直接放一個
       `.command` 在專案裡等使用者點——繞過 containment 換不到新的能力。

    **不要在別處把這裡描述成「已擋住 symlink」**。擋住的是「檢查當下就是 symlink」那種，
    擋不住「檢查之後才被換掉」那種。兩者的保證等級不同。
    """
    try:
        abs_ = expand_and_validate(body.path)
    except ValueError:
        raise HTTPException(status_code=400, detail={"status": "invalid"})

    real = resolve_best_effort(abs_)
    config = AppConfig.load()
    roots = [resolve_best_effort(r["path"]) for r in config.roots]
    roots += [resolve_best_effort(m["path"]) for m in config.manual_projects]
    if not is_within_any_root(real, roots):
        raise HTTPException(status_code=403, detail={"status": "forbidden"})

    target = Path(real)
    if not target.exists():
        return {"path": real, "status": "missing"}
    # 只開一般檔案。目錄、fifo、device 都不是這個功能的用途，
    # 而 `open` 對它們的行為各不相同（目錄會開 Finder）
    if not target.is_file():
        return {"path": real, "status": "not_file"}

    if sys.platform != "darwin":
        # 目前只出貨 macOS。不猜其他平台的指令——猜錯會是靜默的錯誤行為
        return {"path": real, "status": "unsupported_platform"}
    # `--` 一定要在路徑前面：以 `-` 開頭的檔名否則會被 open 當成旗標。
    # list 形式、不經 shell，路徑裡有空白或引號都不會被重新解析
    proc = _run_open(["open", "--", real])
    if proc.returncode != 0:
        return {"path": real, "status": "failed"}
    return {"path": real, "status": "ok"}

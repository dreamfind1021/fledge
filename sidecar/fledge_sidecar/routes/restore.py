"""還原路由：備份包與展開位置的唯讀預覽，以及移機的 install 端點（票 03 起）。

**位置問題不是錯誤**（沿用 `routes/backup.py` 的取向）：一律 200 用 `dest_status` 旗標表達，
錯誤碼只留給請求本身壞掉（未知的備份包名、不是絕對路徑的展開位置）。塞進 HTTP 錯誤碼就只
剩「壞了」一個資訊，卡片沒辦法分辨「那個位置非空」與「選到現役資料裡面」。

實際的展開不在此處，走 `POST /api/sessions` 的 kind=restore（PTY 跑
`scripts/restore-claude.sh`）：那是長時間工作，而它的輸出本身就是使用者要看的差異報告。

寫入能力的邊界：`/api/restore/install` 是本檔唯一會寫現役目錄的端點，而它的全部寫入能力
與安全不變式都在 `backup/install.py` 模組內——route 只轉譯 HTTP，不做任何路徑判斷。
`backup/restore.py` 模組維持零寫入能力（票 09 的結構性不變式，未被本檔改變）。
"""
from __future__ import annotations

import logging
from dataclasses import asdict

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from fledge_sidecar import app_config
from fledge_sidecar.app_config import AppConfig
from fledge_sidecar.backup import install, migration_state, restore
from fledge_sidecar.backup.containment import source_roots
from fledge_sidecar.backup.script import scripts_root
from fledge_sidecar.paths import expand_and_validate, probe_dir, resolve_best_effort
from fledge_sidecar.routes.config import _config_lock
from fledge_sidecar.routes.setup import setup_lock

logger = logging.getLogger(__name__)
router = APIRouter()


# 讀 config 時代表「這份設定檔讀不出來」的例外，本檔三支端點共用：
#   `ValueError`                  壞 JSON／缺 accounts（`JSONDecodeError` 是它的子類）
#   `TypeError`／`AttributeError` 頂層容器欄位形狀畸形（手編出 `roots: 1`、
#                                 `project_overrides: []`），`_from_data` 對容器不驗形狀
#   `OSError`                     讀檔就失敗（config path 是目錄、權限被收走、I/O 錯）
#
# **刻意只包住 `AppConfig.load*()` 那一行**，不包業務邏輯——包大了會把模組自己的
# TypeError 也吞成「設定檔壞掉」，掩蓋真 bug。
#
# ⚠ `FileNotFoundError` 是 `OSError` 子類：`install_route` 的 `except FileNotFoundError`
# 必須排在這個 tuple 之前，否則「還沒初始化」（引導精靈該接手）會被吞成「設定檔壞掉」
# （叫使用者去修一個不存在的檔案）。有測試釘住那個順序。
#
# 這裡只保證**端點合約**（讀不出來就回穩定判別碼）。「畸形 config 該由哪一層、用什麼
# 標準處理」是另一張票的主題（`.scratch/config-resilience/issues/01`）：在 `load()` 丟棄
# 或改寫畸形資料會造成不可逆遺失（所有寫入端點都是 load→改一欄→save 整份覆蓋），那張票
# 的四輪 PR-gate 正是栽在這個範圍問題上，不在這裡順手修。
_CONFIG_UNREADABLE = (ValueError, TypeError, AttributeError, OSError)


class RestorePlanBody(BaseModel):
    model_config = ConfigDict(extra="forbid")  # 未知欄位（如注入 "command"）→ 422
    # 二擇一（`restore.resolve_source_and_dest`）：名字走 `list_bundles` 的 allowlist；
    # 路徑是使用者用系統檔案選擇器挑的，移機情境下備份包不可能在備份輸出目錄裡（票 11）。
    bundle: str | None = None
    bundle_path: str | None = None
    dest: str | None = None                    # 未給＝用後端算的預設位置


@router.post("/api/restore/plan")
def restore_plan(body: RestorePlanBody):
    """回「這份備份包會解到哪裡、那個位置能不能用」。唯讀，不動檔案系統。"""
    try:
        config = AppConfig.load()
    except _CONFIG_UNREADABLE:
        # 與兩支 install 端點同一份合約（Codex 階段 10 守門 R3：同一份畸形 config 不該
        # 在這裡卡死在框架 500）。剖析訊息不可當 error code 外洩（CLAUDE.md §4.6.13），
        # 完整例外只進 log。
        logger.error("還原預覽讀不出 config", exc_info=True)
        return JSONResponse(status_code=500, content={"error": "config_unreadable"})
    try:
        _, dest_abs = restore.resolve_source_and_dest(
            config, name=body.bundle, path=body.bundle_path, dest_raw=body.dest)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return {
        # 使用者送什麼就回什麼——這是「這份 plan 是為哪一個來源算的」的識別，前端拿它比對
        # 「換了包之後舊 plan 還在 state 裡」（RestoreCard 的既有不變式）。名字模式回名字
        # （既有行為不變），路徑模式回絕對路徑。
        "bundle": body.bundle or body.bundle_path,
        "dest": dest_abs,
        "dest_status": restore.check_dest(dest_abs, source_roots(config, scripts_root())),
    }


class MappingEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    old: str
    new: str


class DestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")  # ADR-0002：client 塞 plan 之類的欄位 → 422
    dest: str
    # 專案路徑對應（票 06）：舊絕對路徑 → 使用者確認的新絕對路徑。驗證全在模組內
    # （絕對路徑／確實存在的專案／編碼碰撞），route 只轉譯。
    mapping: list[MappingEntry] = []


# 模組保證 ValueError 內容是英文判別碼；不在此集合的 ValueError 只剩 AppConfig.load()
# 的剖析失敗（JSONDecodeError 是 ValueError 子類，訊息不可外洩當判別碼）。
_INSTALL_CLIENT_ERRORS = frozenset({
    "source_not_a_bundle", "invalid_config_dir", "unsafe_config_dir", "source_root_moved",
    "invalid_account_key", "invalid_account_entry", "overlapping_config_dirs",
    "mapping_not_absolute", "mapping_collision", "mapping_unknown_project",
    "mapping_ambiguous",
})


def _module_error(exc: ValueError) -> JSONResponse:
    """`backup/install.py` 拋的 ValueError → HTTP 回應。

    模組只拋**穩定判別碼**，所以照實回傳：清單內的是使用者能修的輸入問題（400），
    其餘是環境問題（500，如 `journal_unavailable`）。**不冒充 `config_unreadable`**
    ——把來源不見了、journal 開不起來都說成「設定檔壞了」，會讓使用者去修一個沒壞的
    檔案，也讓前端分不出該重新展開來源、修權限、還是修設定（Codex 階段 10 守門）。
    設定檔本身的 ValueError 在 `AppConfig.load*()` 那一層就攔掉，不會走到這裡。"""
    code = str(exc)
    if code in _INSTALL_CLIENT_ERRORS:
        return JSONResponse(status_code=400, content={"error": code})
    return JSONResponse(status_code=500, content={"error": code})


class AdoptAccount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str
    config_dir: str


class AdoptExtra(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    path: str


class AdoptRoot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    default_account: str


class AdoptConfigBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dest: str
    accounts: list[AdoptAccount] = Field(min_length=1)   # 落點是使用者的授權，必填
    roots: list[AdoptRoot] = []
    extra: list[AdoptExtra] = []
    # 這一次確認的識別碼（票 15）。**必填**：冪等契約沒有它就不成立，而「沒帶就退回舊
    # 行為」會讓同一支端點有兩套語意，呼叫端分不出自己拿到的 409 是哪一種。內容不透明
    # ——後端只拿它比對「是不是同一次」，不解讀也不顯示（顯示的是 `dest`）。
    request_id: str = Field(min_length=1, max_length=200)


_ADOPT_CLIENT_ERRORS = frozenset({
    "source_not_a_bundle", "invalid_config_dir", "unsafe_config_dir",
    "invalid_account_key", "overlapping_config_dirs",
})


def _bundle_config(dest: str) -> dict:
    """讀備份包裡的 `fledge/config.json`（`backup-claude.sh:267` 打進去的整份）。

    讀不出／JSON 壞掉／頂層不是物件 → 回空 dict，**移機不因此失敗**：舊版備份腳本產的包
    根本沒有這一份，而它帶回的三個欄位全是「有就帶回、沒有就留空」的便利性資料，不參與
    任何授權決策（落點的授權只認使用者在 targets 頁確認的那一份，spec §4.2.2）。

    讀取走 `install.read_bundle_json`（票 10）——包裡的 config.json 與 manifest 同為展開
    目錄裡的不可信輸入，**同一套標準**（逐層 `O_NOFOLLOW`、`fstat` 判一般檔、大小上限）。"""
    try:
        return install.read_bundle_json(resolve_best_effort(dest), "fledge", "config.json")
    except ValueError:
        return {}


def _adopted_subscriptions(bundle_config: dict) -> list[dict]:
    """**兩層容錯**：頂層不是 list → 整欄捨棄；list 內逐項走共用的 `normalize_subscription`，
    壞項丟棄、好項保留、**不連坐**。

    判準與 `PUT /api/config/subscriptions` 是同一份，只有處置不同（那邊 400、這邊丟棄）——
    備份包是不可信輸入，一筆壞資料不該讓整個移機失敗。**不去重**：那支對同名項目不去重，
    這裡也不，同一份資料兩條規則必然漂移。"""
    raw = bundle_config.get("subscriptions")
    if not isinstance(raw, list):
        return []
    adopted: list[dict] = []
    for item in raw:
        try:
            adopted.append(app_config.normalize_subscription(item))
        except ValueError:
            continue
    return adopted


def _usable_dir(raw: str) -> str | None:
    """這個路徑在這台機器上是不是一個用得了的目錄。回絕對路徑；不可用回 None。
    `denied` 放行（比照 onboard：探不到不等於不存在）。

    **例外不是只有 `ValueError` 一種**（Codex 票 09 R1 F1，三種都實測過）：
    `~不存在的使用者/x` 讓 `Path.expanduser()` 拋 `RuntimeError`；含 NUL 的路徑通得過
    `expand_and_validate`，要到 `probe_dir` 的 `os.stat` 才拋 `ValueError`。兩者都能由
    不可信的備份包**或使用者的輸入**構造出來。

    三個呼叫端共用這一支（`body.roots`／包裡的 roots／`kms_root`）：處置不同（400 vs
    丟棄），但「什麼算可用的目錄」只能有一份判準——`body.roots` 原本自己接
    `ValueError`，那正是「一邊有一邊沒有」的形狀。"""
    try:
        abs_ = expand_and_validate(raw)
        if probe_dir(abs_) in ("missing", "not_dir"):
            return None
    except (ValueError, RuntimeError, OSError):
        return None
    return abs_


def _adopted_kms_root(bundle_config: dict) -> str:
    """包裡的 `kms_root` 是**舊機的路徑**，走與 `roots` 相同的驗證（`expand_and_validate`
    ＋ `probe_dir`，`denied` 放行比照 roots）；`missing`／`not_dir` 就不帶回。

    帶回一個指不到東西的路徑比留空更糟——使用者會以為知識庫已經設好了，而記憶頁永遠是
    空的。存 raw（比照 `set_kms_root`：raw 含 `~`，掃描時才展開）。"""
    raw = bundle_config.get("kms_root")
    if not isinstance(raw, str) or not raw.strip():
        return ""
    return raw.strip() if _usable_dir(raw) is not None else ""


def _adopted_roots(bundle_config: dict, account_keys: set[str]) -> list[tuple[str, str]]:
    """包裡的 roots：頂層不是 list → 整欄捨棄；逐項驗，壞項丟棄、不連坐、**不失敗**。

    形狀判準複用 `app_config.usable_entry`（`load()` 與 `project_scanner` 的同一條）。
    `default_account` 指向本次沒確認的帳號時**只丟棄那一項**——與 `body.roots` 回
    `unknown_account` 400 的處置不同：那是使用者送的、錯了要說，這裡是不可信輸入，而
    使用者在 targets 頁只確認部分帳號本來就是正常情況（增補 spec §2.8.3）。"""
    raw = bundle_config.get("roots")
    if not isinstance(raw, list):
        return []
    adopted: list[tuple[str, str]] = []
    for r in raw:
        if not app_config.usable_entry(r, "path", "default_account"):
            continue
        if r["default_account"] not in account_keys:
            continue
        abs_ = _usable_dir(r["path"])
        if abs_ is None:
            continue
        adopted.append((resolve_best_effort(abs_), r["default_account"]))
    return adopted


@router.post("/api/restore/adopt-config")
def adopt_config(body: AdoptConfigBody):
    """用備份包重建 config.json（票 07）。**落點由使用者逐項確認後送回**，server 全部
    重驗（spec §4.2.2：manifest 只能描述來源與建議值，不能授權目的地——限制前端送的
    欄位並不會讓不可信的資料源變可信）。

    不擴充 onboard：它的 first-run 語意是審查後刻意加的，且「採用備份包」與「手動
    onboard」是兩種語意。兩支共用 `create_if_absent` 原語與同一把 `_config_lock`
    （spec §4.3.1——各寫一份 first-run 判定必然漂移）。"""
    account_keys = [a.key for a in body.accounts]
    extra_names = [e.name for e in body.extra]
    # 同名重複＝「後蓋前」的授權歧義，直接拒——不讓 dict 建構默默挑一個
    if len(set(account_keys)) != len(account_keys):
        return JSONResponse(status_code=400, content={"error": "duplicate_account_key"})
    if len(set(extra_names)) != len(extra_names):
        return JSONResponse(status_code=400, content={"error": "duplicate_extra_name"})
    try:
        manifest = install.read_manifest(resolve_best_effort(body.dest))
        # 只採用備份包宣稱的成員——這是確認流的**輸入 hygiene**，不是把授權綁定到這份
        # bundle：config 落點授權的是「目的地」，install 對任意 bundle 一視同仁地靠
        # no-clobber／containment／provenance 防護（票 03 起的模型，正常 onboard 的
        # 使用者本來就能對任意 bundle 呼叫 install）。

        if not set(account_keys) <= set(manifest["accounts"]):
            return JSONResponse(status_code=400, content={"error": "unknown_account_key"})
        if not set(extra_names) <= set(manifest.get("extra", {})):
            return JSONResponse(status_code=400, content={"error": "unknown_extra_name"})
        install.validate_landing_spots(
            {**{a.key: a.config_dir for a in body.accounts},
             **{f"extra:{e.name}": e.path for e in body.extra}})
    except ValueError as exc:
        if str(exc) in _ADOPT_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        raise                               # read_manifest／validate 只拋判別碼，其餘不吞
    roots: list[tuple[str, str]] = []
    for r in body.roots:
        if r.default_account not in set(account_keys):
            return JSONResponse(status_code=400, content={"error": "unknown_account"})
        abs_ = _usable_dir(r.path)      # 判準與包裡的 roots／kms_root 同一份，處置不同
        if abs_ is None:
            return JSONResponse(status_code=400, content={"error": "invalid_root"})
        roots.append((resolve_best_effort(abs_), r.default_account))

    # Fledge 自己的設定（票 09／增補 spec 缺口 5）：這三個值本來就在備份包裡，只是移機
    # 路徑從來不讀它，於是移機完的新機訂閱、知識庫根目錄、工作根目錄全是空的，而且沒有
    # 任何一頁讓使用者發現。**入口只能是這裡**——`install()` 把包裡的 config.json 裝回
    # `~/.fledge/` 會覆蓋掉使用者剛在 targets 頁確認的落點（明令不做，見票 09）。
    bundle_config = _bundle_config(body.dest)
    if not roots:
        # `body.roots` 非空 → 完全以它為準，包裡的不摻進來：使用者送出的是授權，包裡的
        # 只是「沒有更好來源時的替代」。移機分支目前一律送空陣列（前端此時還沒有工作根
        # 目錄的資料來源，增補 spec §2.8.3），所以實務上走的是包裡那條。
        roots = _adopted_roots(bundle_config, set(account_keys))

    def _build(config: AppConfig) -> None:
        config.accounts = {}                # 不留 DEFAULT_CONFIG 的 default 帳號
        for a in body.accounts:
            config.add_account(a.key, a.config_dir.strip(), "")   # 存 raw，比照帳號慣例
        for path, acct in roots:
            config.add_root(path, acct)
        config.extra = {e.name: e.path.strip() for e in body.extra}
        config.subscriptions = _adopted_subscriptions(bundle_config)
        config.set_kms_root(_adopted_kms_root(bundle_config))
        # 純記帳、不參與任何授權決策（票 15）。`dest` 存 resolved 的展開位置——衝突時
        # 前端要能說「這份設定檔是從**哪一包**建的」，那是使用者唯一分得出來的線索。
        config.set_created_by({"source": "adopt-config", "request_id": body.request_id,
                               "dest": resolve_best_effort(body.dest)})

    try:
        with _config_lock:
            # **冪等契約**（票 15）：同一個 `request_id` 重送 → 回既有結果（200）。這一格
            # 對應「這次 POST 其實成功了，只是回應沒回到前端」——請求途中卡片被卸載、連線
            # 中斷、回應在傳輸中遺失。前端原本只能靠元件內的 `adopted` 旗標推測，而那個
            # 旗標卸載就沒了（票 03 R3 連續三輪的根因）。
            config = app_config.create_if_absent(
                _build, matches=lambda existing: (
                    existing.created_by.get("source") == "adopt-config"
                    and existing.created_by.get("request_id") == body.request_id))
    except app_config.ConfigAlreadyExists as exc:
        # **說得出那份設定檔是誰建的**：409 原本只證明「有一份 config」，前端因此分不出
        # 「重跑引導」與「另一個來源剛建了一份」。`created_by` 是本機資訊，回給本機前端。
        return JSONResponse(status_code=409, content={
            "error": "config_already_initialized", "created_by": exc.created_by})
    return config.to_dict()


@router.get("/api/restore/bundle-info")
def bundle_info_route(dest: str):
    """唯讀（票 02，增補 spec 缺口 1）：展開目錄的摘要——來源機器、備份時間、帳號與
    extra 清單、專案數。`bundle` 頁靠它讓使用者確認「這是不是我要的那一包」。

    **刻意不讀 config**：移機的常態是設定檔還沒落檔（`adopt-config` 在下一頁），
    摘要只解讀展開目錄本身。"""
    try:
        return install.bundle_info(dest)
    except ValueError as exc:
        if str(exc) in _INSTALL_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        raise                               # 模組只拋判別碼，其餘不吞


@router.get("/api/restore/landing-suggestions")
def landing_suggestions_route(dest: str):
    """唯讀（票 03，增補 spec 缺口 7）：每個帳號與 extra 的落點建議值與存在性。

    `targets` 頁靠它預填。**manifest 只產生建議值**——授權是使用者送回 `adopt-config`
    的那一份（spec §4.2.2 第 2 點）。與 `bundle-info` 同樣不讀 config（落檔在下一步）。"""
    try:
        return install.landing_suggestions(dest)
    except ValueError as exc:
        if str(exc) in _INSTALL_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        raise                               # 模組只拋判別碼，其餘不吞


@router.get("/api/restore/migration-status")
def migration_status_route():
    """唯讀（票 07，增補 spec §3.3.2）：上一輪移機收尾了沒、能不能一鍵續作。

    **前端不得自己讀 `~/.fledge/`**：判定牽涉 journal 定位、bundle 形狀驗證與損壞容錯，
    全是後端已經有的能力。任何 I/O 失敗在模組內降級成某個 state，**不回 5xx**——還原卡
    每次開啟都會打這支，它掛掉不該讓整張卡壞掉。

    **不做任何寫入**：殘留的 marker 無害（每次都正確判成 `stale_marker`），下一次 install
    的 atomic write 會覆蓋它。在唯讀查詢裡偷做清除，會讓「唯讀」的宣稱失真。"""
    return migration_state.status()


@router.get("/api/restore/project-paths")
def project_paths_route(dest: str):
    """唯讀（票 06）：備份包裡有哪些專案、各自的舊路徑（讀歷史檔 cwd——編碼不可逆，
    無法從目錄名反推）、建議的新路徑與其存在性。不動檔案系統。"""
    try:
        return {"projects": install.project_paths(dest)}
    except ValueError as exc:
        if str(exc) in _INSTALL_CLIENT_ERRORS:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        raise                               # 模組只拋判別碼，其餘不吞


@router.post("/api/restore/install-plan")
def install_plan(body: DestBody):
    """唯讀預覽：會裝幾項、跳過哪些、刻意不處理哪些。不動檔案系統。

    落點從 config.json 讀，不由前端送（spec §4.2.2：manifest 只能描述來源，不能授權
    目的地）。預覽沿用會 fallback 的 `AppConfig.load()`——與 common-config 的預覽同一
    慣例（精靈 pre-onboard 要能看狀態），fallback 下的探測全是唯讀 lstat。"""
    try:
        # 設定檔本身壞掉只有這一層會拋（JSON 剖析訊息不可當判別碼外洩，故不透傳）
        config = AppConfig.load()
    except _CONFIG_UNREADABLE:
        logger.error("移機預覽讀不出 config", exc_info=True)
        return JSONResponse(status_code=500, content={"error": "config_unreadable"})
    try:
        # extra 落點同樣只來自 config（adopt-config 確認後寫入），不由前端送（票 07）
        plan = install.plan(body.dest, config.accounts, extra=config.extra,
                            mapping=[(m.old, m.new) for m in body.mapping])
    except ValueError as exc:
        return _module_error(exc)
    return asdict(plan)


@router.post("/api/restore/install")
def install_route(body: DestBody):
    """實際寫入。server 以相同輸入**重算 plan**（ADR-0002，不吃 client 送來的 plan）。

    與共通設置／範本部署共用同一把 `setup_lock`：三者可能改寫同一批目錄，各自持鎖
    等於併發互踩。

    落點只能來自**使用者確認過的 config.json**，所以走 `load_existing`（單次讀取、
    永不 fallback）而非 exists→load 兩段式閘——後者在等鎖期間 config 被刪時仍會退回
    DEFAULT_CONFIG（default=~/.claude），把備份內容寫進現役 Claude 目錄（Codex 票 03
    R3／R4）。讀取放在鎖內，與寫入同一臨界區。唯讀預覽不設此限。

    回應多一個 `stale_temps`（票 06）：前一輪硬中斷留在落點裡的暫存殘骸，絕對路徑。
    **這個參數不是可選的**——模組層只負責「傳了才收集」，忘了傳的話安裝照樣成功、log
    照樣有、既有斷言照樣綠，而 API 永遠回空清單。守住它的是端到端測試。"""
    stale: list[str] = []
    try:
        with setup_lock:
            try:
                config = AppConfig.load_existing()
            except FileNotFoundError:
                return JSONResponse(status_code=400,
                                    content={"error": "config_not_initialized"})
            except _CONFIG_UNREADABLE:
                # 設定檔本身壞掉**只有這一層**會拋——模組的 ValueError 一律是判別碼，
                # 把兩者混在同一個 except 會讓「來源不見了」「journal 開不起來」全被
                # 誤報成設定檔損壞（Codex 階段 10 守門 R1）。
                logger.error("移機安裝讀不出 config", exc_info=True)
                return JSONResponse(status_code=500,
                                    content={"error": "config_unreadable"})
            plan = install.plan(body.dest, config.accounts, extra=config.extra,
                                mapping=[(m.old, m.new) for m in body.mapping])
            tid = install.transaction_id(plan)
            # **續作簿記寫不進去就不准開始**（票 07，增補 spec §3.2）：照樣安裝的話，硬
            # 中斷之後只剩 journal → 沒有續作資訊 → 而 config 早已落檔、重走精靈會撞
            # `adopt-config` 的 409，正好重現票 07 要消除的那條死路。與 `journal_unavailable`
            # 同立場：簿記開不起來就不該動使用者的目錄。
            #
            # **由 route 寫而不是 `install()`**：模組層拿不到原始 mapping（`InstallPlan` 存的
            # 是改名後的 `project_renames`），而且 in-progress 是精靈流程的便利性資料——
            # `backup/install.py` 應該繼續不知道 UI 有幾頁、走什麼順序。
            try:
                migration_state.write_marker(
                    tid, plan.source_root, [(m.old, m.new) for m in body.mapping])
            except OSError:
                logger.error("移機續作簿記寫入失敗，安裝未開始", exc_info=True)
                return JSONResponse(
                    status_code=500,
                    content={"error": "migration_marker_unavailable"})
            results = install.install(plan, stale_out=stale)
            # **刪除 gate 不能只看「無 failed」**（Codex spec review R3）：`install()` 清
            # journal 用的是 `suppress(OSError)`，清除失敗不影響回傳。只憑無 failed 就刪
            # marker 會留下「journal 還在、marker 沒了」＝ `unfinished_unknown`——安裝其實
            # 已經成功，使用者卻看到「未完成」而且不能續作。journal 還在就保留 marker：
            # 狀態是 `resumable`，使用者頂多多按一次繼續（續作冪等、全部 skipped）。
            if (not any(r.outcome == "failed" for r in results)
                    and not install.journal_path(tid).exists()):
                migration_state.clear_marker()
    except ValueError as exc:
        return _module_error(exc)
    return {"results": [asdict(r) for r in results], "stale_temps": stale}

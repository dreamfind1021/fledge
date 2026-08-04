import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings as SettingsIcon, X, Folder, FolderPlus, Users, Trash2, ChartColumn, Brain } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { pickDirectory } from "../lib/dialog";
import { putKmsRoot, DEFAULT_ACCOUNT_KEY } from "../lib/sidecar";
import { AccountsEditor } from "./AccountsEditor";
import { BackupCard } from "./BackupCard";
import { DevEnvSection } from "./DevEnvSection";
import { LangSwitch } from "./LangSwitch";
import { RestoreCard, type MigrationResume } from "./RestoreCard";
import { validateSubscriptions } from "../lib/subscriptionsForm";
import "./Settings.css";

interface SettingsProps {
  onClose: () => void;
  /** 重開全屏精靈（票 29 的「重跑引導」）。modal 狀態在 App，這裡只往上通知。 */
  onRerunOnboarding: () => void;
  /** 接續上次沒完成的移機（票 07）：同樣開精靈，但直接落在安裝頁並預填。 */
  onResumeMigration: (resume: MigrationResume) => void;
}

export function Settings({ onClose, onRerunOnboarding, onResumeMigration }: SettingsProps) {
  const { t } = useTranslation("dashboard");
  const { t: tMem } = useTranslation("memory");
  const config = useAppStore((s) => s.config);
  const port = useAppStore((s) => s.port);
  const loadConfig = useAppStore((s) => s.loadConfig);
  const addRoot = useAppStore((s) => s.addRoot);
  const removeRoot = useAppStore((s) => s.removeRoot);
  const setRootAccount = useAppStore((s) => s.setRootAccount);
  const addManual = useAppStore((s) => s.addManual);
  const removeManual = useAppStore((s) => s.removeManual);
  const saveSubscriptions = useAppStore((s) => s.saveSubscriptions);

  const [newRootPath, setNewRootPath] = useState("");
  const [newRootAccount, setNewRootAccount] = useState(DEFAULT_ACCOUNT_KEY);
  const [newManualPath, setNewManualPath] = useState("");
  const [newManualAccount, setNewManualAccount] = useState(DEFAULT_ACCOUNT_KEY);
  const [error, setError] = useState<string | null>(null);

  // 訂閱費編輯 state（以字串保留輸入中的值，存檔時才 parse；?? [] 兼容後端未回傳舊快取）
  const [subsRows, setSubsRows] = useState<{ name: string; monthly_cost: string }[]>(() =>
    (config?.subscriptions ?? []).map((s) => ({ name: s.name, monthly_cost: String(s.monthly_cost) })),
  );
  const [subsError, setSubsError] = useState<string | null>(null);

  // KMS 根目錄編輯 state（字串輸入，存檔時才送；初值在 config 載入後同步）
  const [kmsRoot, setKmsRoot] = useState("");
  const [kmsError, setKmsError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // config 初次載入後同步 subsRows / kmsRoot（Settings 打開時 config 可能尚未就緒）
  const [subsInitialized, setSubsInitialized] = useState(false);
  useEffect(() => {
    if (!subsInitialized && config != null) {
      setSubsRows((config.subscriptions ?? []).map((s) => ({ name: s.name, monthly_cost: String(s.monthly_cost) })));
      setKmsRoot(config.kms_root ?? "");
      setSubsInitialized(true);
    }
  }, [config, subsInitialized]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 帳號被刪/改後，若加根/加 manual 的 select 仍指向已不存在的帳號，重設為第一個（避免送出 _require_account 400）
  useEffect(() => {
    if (!config) return;
    const keys = Object.keys(config.accounts);
    if (keys.length && !keys.includes(newRootAccount)) setNewRootAccount(keys[0]);
    if (keys.length && !keys.includes(newManualAccount)) setNewManualAccount(keys[0]);
  }, [config, newRootAccount, newManualAccount]);

  const accountKeys = config ? Object.keys(config.accounts) : [DEFAULT_ACCOUNT_KEY];

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>

        {/* ── header：gear 圖示 + 標題 + X 關閉 ── */}
        <div className="settings-head">
          <span className="settings-head-ico">
            <SettingsIcon size={19} strokeWidth={1.75} />
          </span>
          <span className="settings-head-title">設定</span>
          <LangSwitch />
          <button className="settings-head-close" onClick={onClose} aria-label="關閉設定">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* ── 捲動主體 ── */}
        <div className="settings-body">

          {error && (
            <div className="settings-error">{error}</div>
          )}

          {/* 根目錄 */}
          <div className="settings-sec-title settings-sec-title--first">
            <Folder size={14} strokeWidth={2} />
            根目錄
          </div>
          {config?.roots.map((r) => (
            <div key={r.path} className="settings-rrow">
              <span className="settings-rrow-path">{r.path}</span>
              <select
                value={r.default_account}
                onChange={(e) => setRootAccount(r.path, e.target.value)}
                className="settings-rrow-select"
              >
                {accountKeys.map((a) => (<option key={a} value={a}>{a}</option>))}
              </select>
              <button
                onClick={() => removeRoot(r.path)}
                className="settings-del"
                aria-label={`刪除根目錄 ${r.path}`}
              >
                <Trash2 size={15} strokeWidth={1.75} />
              </button>
            </div>
          ))}
          <div className="settings-add-row">
            <input
              autoFocus
              placeholder="/絕對路徑/到/工作根目錄"
              value={newRootPath}
              onChange={(e) => setNewRootPath(e.target.value)}
              className="settings-input"
            />
            <button
              onClick={async () => {
                const p = await pickDirectory();
                if (p) setNewRootPath(p);
              }}
              className="settings-btn-ghost"
            >瀏覽…</button>
            <select
              value={newRootAccount}
              onChange={(e) => setNewRootAccount(e.target.value)}
              className="settings-add-select"
            >
              {accountKeys.map((a) => (<option key={a} value={a}>{a}</option>))}
            </select>
            <button
              onClick={async () => {
                const path = newRootPath.trim();
                if (!path) return;
                setError(null);
                try {
                  await addRoot(path, newRootAccount);
                  setNewRootPath(""); // 成功才清輸入
                } catch (e) {
                  setError(`加根失敗：${e instanceof Error ? e.message : String(e)}`);
                }
              }}
              className="settings-btn-primary"
            >加根</button>
          </div>

          {/* 手動專案 */}
          <div className="settings-sec-title">
            <FolderPlus size={14} strokeWidth={2} />
            手動專案
          </div>
          {config?.manual_projects.map((m) => (
            <div key={m.path} className="settings-rrow">
              <span className="settings-rrow-path">{m.path}</span>
              <span className="settings-rrow-acct">{m.account}</span>
              <button
                onClick={() => removeManual(m.path)}
                className="settings-del"
                aria-label={`刪除手動專案 ${m.path}`}
              >
                <Trash2 size={15} strokeWidth={1.75} />
              </button>
            </div>
          ))}
          <div className="settings-add-row">
            <input
              placeholder="/絕對路徑/到/單一專案"
              value={newManualPath}
              onChange={(e) => setNewManualPath(e.target.value)}
              className="settings-input"
            />
            <button
              onClick={async () => {
                const p = await pickDirectory();
                if (p) setNewManualPath(p);
              }}
              className="settings-btn-ghost"
            >瀏覽…</button>
            <select
              value={newManualAccount}
              onChange={(e) => setNewManualAccount(e.target.value)}
              className="settings-add-select"
            >
              {accountKeys.map((a) => (<option key={a} value={a}>{a}</option>))}
            </select>
            <button
              onClick={async () => {
                const path = newManualPath.trim();
                if (!path) return;
                setError(null);
                try {
                  await addManual(path, newManualAccount);
                  setNewManualPath(""); // 成功才清輸入
                } catch (e) {
                  setError(`加入失敗：${e instanceof Error ? e.message : String(e)}`);
                }
              }}
              className="settings-btn-primary"
            >加入</button>
          </div>

          {/* 帳號 */}
          <div className="settings-sec-title">
            <Users size={14} strokeWidth={2} />
            帳號
          </div>
          <AccountsEditor />

          {/* 訂閱費用 */}
          <div className="settings-sec-title">
            <ChartColumn size={14} strokeWidth={2} />
            {t("settings.subsTitle")}
          </div>
          <div className="settings-subs-hint">{t("settings.subsHint")}</div>
          {subsRows.map((row, i) => (
            <div key={i} className="settings-rrow">
              <input
                className="settings-input settings-subs-name"
                placeholder={t("settings.name")}
                value={row.name}
                onChange={(e) => {
                  setSubsError(null);
                  setSubsRows((rows) => rows.map((r, j) => j === i ? { ...r, name: e.target.value } : r));
                }}
              />
              <input
                className="settings-input settings-subs-cost"
                type="number"
                min="0"
                step="0.01"
                placeholder={t("settings.monthlyCost")}
                value={row.monthly_cost}
                onChange={(e) => {
                  setSubsError(null);
                  setSubsRows((rows) => rows.map((r, j) => j === i ? { ...r, monthly_cost: e.target.value } : r));
                }}
              />
              <button
                className="settings-del"
                aria-label={t("settings.remove")}
                onClick={() => {
                  setSubsError(null);
                  setSubsRows((rows) => rows.filter((_, j) => j !== i));
                }}
              >
                <Trash2 size={15} strokeWidth={1.75} />
              </button>
            </div>
          ))}
          {subsError && <div className="settings-error">{subsError}</div>}
          <div className="settings-add-row">
            <button
              className="settings-btn-ghost"
              onClick={() => setSubsRows((rows) => [...rows, { name: "", monthly_cost: "" }])}
            >
              {t("settings.add")}
            </button>
            <button
              className="settings-btn-primary"
              onClick={async () => {
                setSubsError(null);
                const result = validateSubscriptions(subsRows);
                if (!result.ok) {
                  setSubsError(result.error === "name" ? t("settings.errName") : t("settings.errCost"));
                  return;
                }
                try {
                  await saveSubscriptions(result.value);
                } catch (e) {
                  setSubsError(t("settings.errSave", { msg: e instanceof Error ? e.message : String(e) }));
                }
              }}
            >
              {t("settings.save")}
            </button>
          </div>

          {/* 記憶層 KMS 根目錄 */}
          <div className="settings-sec-title">
            <Brain size={14} strokeWidth={2} />
            {tMem("settings.kmsRoot")}
          </div>
          <div className="settings-subs-hint">{tMem("settings.kmsRootHint")}</div>
          {kmsError && <div className="settings-error">{kmsError}</div>}
          <div className="settings-add-row">
            <input
              className="settings-input"
              placeholder={tMem("settings.kmsRootPlaceholder")}
              value={kmsRoot}
              onChange={(e) => {
                setKmsError(null);
                setKmsRoot(e.target.value);
              }}
            />
            <button
              onClick={async () => {
                const p = await pickDirectory();
                if (p) {
                  setKmsError(null);
                  setKmsRoot(p);
                }
              }}
              className="settings-btn-ghost"
            >{tMem("settings.browse")}</button>
            <button
              className="settings-btn-primary"
              onClick={async () => {
                if (port == null) return;
                setKmsError(null);
                try {
                  await putKmsRoot(port, kmsRoot.trim());
                  await loadConfig(); // 回讀讓 config.kms_root 與其他面板同步
                } catch (e) {
                  setKmsError(tMem("settings.saveError", { msg: e instanceof Error ? e.message : String(e) }));
                }
              }}
            >
              {tMem("settings.save")}
            </button>
          </div>

          {/* 開發環境（票 29）：共通設置與範本兩張常用卡 + 重跑引導 */}
          <DevEnvSection
            port={port}
            accounts={config?.accounts ?? {}}
            onRerunOnboarding={onRerunOnboarding}
          />

          {/* 備份（票 02）：常駐顯示備份位置與其狀態。刻意不自動備份、不提醒——
              這是「有一個固定的落腳處」而不是「催使用者」。 */}
          <BackupCard port={port} />

          {/* 還原（票 09）：接在備份卡下面——選備份包、展開到獨立位置、看差異報告。
              **不寫現役目錄**是這個功能的核心約束（ADR-0004），不是保守的預設值。 */}
          <RestoreCard port={port} accounts={config?.accounts ?? {}}
                       onResumeMigration={onResumeMigration} />

        </div>

        {/* ── footer：僅「完成」（Settings 自動儲存，無取消）── */}
        <div className="settings-foot">
          <button className="settings-btn-primary" onClick={onClose}>完成</button>
        </div>

      </div>
    </div>
  );
}

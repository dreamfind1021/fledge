import { useEffect, useState } from "react";
import { Settings as SettingsIcon, X, Folder, FolderPlus, Users, Trash2 } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { pickDirectory } from "../lib/dialog";
import { AccountsEditor } from "./AccountsEditor";
import "./Settings.css";

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const config = useAppStore((s) => s.config);
  const loadConfig = useAppStore((s) => s.loadConfig);
  const addRoot = useAppStore((s) => s.addRoot);
  const removeRoot = useAppStore((s) => s.removeRoot);
  const setRootAccount = useAppStore((s) => s.setRootAccount);
  const addManual = useAppStore((s) => s.addManual);
  const removeManual = useAppStore((s) => s.removeManual);

  const [newRootPath, setNewRootPath] = useState("");
  const [newRootAccount, setNewRootAccount] = useState("work");
  const [newManualPath, setNewManualPath] = useState("");
  const [newManualAccount, setNewManualAccount] = useState("work");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

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

  const accountKeys = config ? Object.keys(config.accounts) : ["work", "personal"];

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>

        {/* ── header：gear 圖示 + 標題 + X 關閉 ── */}
        <div className="settings-head">
          <span className="settings-head-ico">
            <SettingsIcon size={19} strokeWidth={1.75} />
          </span>
          <span className="settings-head-title">設定</span>
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

        </div>

        {/* ── footer：僅「完成」（Settings 自動儲存，無取消）── */}
        <div className="settings-foot">
          <button className="settings-btn-primary" onClick={onClose}>完成</button>
        </div>

      </div>
    </div>
  );
}

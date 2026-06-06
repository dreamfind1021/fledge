import { useEffect, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { checkDir, type DirStatus } from "../lib/sidecar";
import { pickDirectory } from "../lib/dialog";
import { accountColor } from "../lib/accountColor";
import "./AccountsEditor.css";

export function AccountsEditor() {
  const port = useAppStore((s) => s.port);
  const config = useAppStore((s) => s.config);
  const addAccount = useAppStore((s) => s.addAccount);
  const setAccountConfigDir = useAppStore((s) => s.setAccountConfigDir);
  const setAccountLabel = useAppStore((s) => s.setAccountLabel);
  const removeAccount = useAppStore((s) => s.removeAccount);

  const accounts = config?.accounts ?? {};
  const keys = Object.keys(accounts);

  const [newKey, setNewKey] = useState("");
  const [newDir, setNewDir] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [dirExists, setDirExists] = useState<Record<string, DirStatus>>({});
  const [deleting, setDeleting] = useState<{ key: string; refCount: number; reassignTo: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (port == null || !config) return;
    let cancelled = false;
    (async () => {
      // dirExists 以 account key 為索引（Codex C6）；查每個 config_dir 是否為既存目錄
      const entries = await Promise.all(
        Object.entries(config.accounts).map(
          async ([k, a]) => [k, await checkDir(port, a.config_dir).catch(() => "dir" as DirStatus)] as const,
        ),
      );
      if (!cancelled) setDirExists(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [port, config]);

  const refsOf = (key: string): number => {
    if (!config) return 0;
    return (
      config.roots.filter((x) => x.default_account === key).length +
      config.manual_projects.filter((x) => x.account === key).length +
      Object.values(config.project_overrides).filter((x) => x.account === key).length
    );
  };

  const startDelete = async (key: string) => {
    if (keys.length <= 1) return; // 至少留 1
    const refCount = refsOf(key);
    if (refCount > 0) {
      const other = keys.find((k) => k !== key)!;
      setDeleting({ key, refCount, reassignTo: other });
      return;
    }
    // 無引用直接刪；async 失敗要可見（Codex C4）
    setBusy(true);
    setError(null);
    try {
      await removeAccount(key);
    } catch (e) {
      setError(`刪除失敗：${e}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await removeAccount(deleting.key, deleting.reassignTo);
      setDeleting(null); // 成功才關面板（Codex C4）
    } catch (e) {
      setError(`刪除失敗：${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doAdd = async () => {
    const k = newKey.trim();
    if (!k || !newDir.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addAccount(k, newDir.trim(), newLabel.trim());
      setNewKey(""); // 成功才清欄位（Codex C4）
      setNewDir("");
      setNewLabel("");
    } catch (e) {
      setError(`新增失敗：${e}`);
    } finally {
      setBusy(false);
    }
  };

  // config_dir/label 的 inline 編輯也要 await + 可見錯誤 + busy（Codex round 2 F1/F5-b）
  const saveConfigDir = async (key: string, value: string) => {
    const v = value.trim();
    if (!v || v === accounts[key]?.config_dir) return; // 空或沒變就不送
    setBusy(true);
    setError(null);
    try {
      await setAccountConfigDir(key, v);
    } catch (e) {
      setError(`更新 config_dir 失敗：${e}`);
    } finally {
      setBusy(false);
    }
  };

  const saveLabel = async (key: string, value: string) => {
    const v = value.trim();
    if (v === accounts[key]?.label) return; // 沒變就不送
    setBusy(true);
    setError(null);
    try {
      await setAccountLabel(key, v);
    } catch (e) {
      setError(`更新顯示名失敗：${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="ae-desc">
        帳號 = 獨立 config 目錄（隔離 settings／skills／MCP／權限）。切帳號不會自動切 Claude 登入帳號；要綁不同登入帳號，請在該帳號的 session 裡用 /login。
      </div>

      {keys.map((key) => {
        const acc = accounts[key];
        const status = dirExists[key] ?? "dir"; // 查完才會標非 dir；預設不顯警告
        const warn =
          status === "missing" ? "此目錄目前不存在（claude 首次啟動時會用到，可先建立或讓 claude 自建）"
          : status === "denied" ? "無法讀取此目錄（權限不足，請到系統設定 → 隱私權與安全性授權）"
          : status === "not_dir" ? "這不是資料夾"
          : null;
        return (
          <div key={key} className="ae-account-block">
            <div className="ae-row">
              {/* 帳號色點：background 由 accountColor(key) 動態注入 */}
              <span className="ae-dot" style={{ background: accountColor(key) }} />
              <span className="ae-key">{key}</span>
              <input
                key={`dir-${key}-${acc.config_dir}`}
                defaultValue={acc.config_dir}
                onBlur={(e) => saveConfigDir(key, e.target.value)}
                disabled={busy}
                placeholder="~/.claude"
                className="ae-input"
              />
              <button
                onClick={async () => { const p = await pickDirectory(); if (p) saveConfigDir(key, p); }}
                disabled={busy}
                className="ae-btn-ghost"
              >瀏覽…</button>
              <input
                key={`label-${key}-${acc.label}`}
                defaultValue={acc.label}
                onBlur={(e) => saveLabel(key, e.target.value)}
                disabled={busy}
                placeholder="顯示名"
                className="ae-input ae-input-label"
              />
              <button
                onClick={() => startDelete(key)}
                disabled={keys.length <= 1 || busy}
                className="ae-del"
                aria-label={`刪除帳號 ${key}`}
              >
                <Trash2 size={15} strokeWidth={1.75} />
              </button>
            </div>
            {warn && (
              <div className="ae-warn">
                <span className="ae-warn-ico">
                  <AlertTriangle size={12} strokeWidth={2} />
                </span>
                {warn}
              </div>
            )}
          </div>
        );
      })}

      {deleting && (
        <div className="ae-reassign">
          <span className="ae-reassign-text">帳號「<b>{deleting.key}</b>」被 {deleting.refCount} 處引用，刪除前轉移到：</span>
          <select
            value={deleting.reassignTo}
            onChange={(e) => setDeleting({ ...deleting, reassignTo: e.target.value })}
            disabled={busy}
            className="ae-reassign-select"
          >
            {keys.filter((k) => k !== deleting.key).map((k) => (<option key={k} value={k}>{k}</option>))}
          </select>
          <button onClick={confirmDelete} disabled={busy} className="ae-btn-confirm-del">確認刪除並轉移</button>
          <button onClick={() => setDeleting(null)} disabled={busy} className="ae-btn-ghost">取消</button>
        </div>
      )}

      <div className="ae-add-row">
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          disabled={busy}
          placeholder="代號（如 team）"
          className="ae-input ae-input-key"
        />
        <input
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          disabled={busy}
          placeholder="~/.claude-team"
          className="ae-input"
        />
        <button
          onClick={async () => { const p = await pickDirectory(); if (p) setNewDir(p); }}
          disabled={busy}
          className="ae-btn-ghost"
        >瀏覽…</button>
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          disabled={busy}
          placeholder="顯示名"
          className="ae-input ae-input-label"
        />
        <button onClick={doAdd} disabled={busy} className="ae-btn-primary">加帳號</button>
      </div>
      {error && <div className="ae-error">{error}</div>}
    </div>
  );
}

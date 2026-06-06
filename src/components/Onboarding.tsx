import { useState } from "react";
import { Check } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { scanPreview } from "../lib/sidecar";
import { pickDirectory } from "../lib/dialog";
import { FeatherMark } from "./Logo";
import "./Onboarding.css";

interface OnboardingProps {
  onClose: () => void;
}

interface DraftRoot {
  path: string;
  account: string;
  count: number;
}

const TOTAL_STEPS = 3;

export function Onboarding({ onClose }: OnboardingProps) {
  const port = useAppStore((s) => s.port);
  const config = useAppStore((s) => s.config);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  // 首次時 config 為 in-memory DEFAULT（accounts = work/personal）
  const accountKeys = config ? Object.keys(config.accounts) : ["work", "personal"];

  const [step, setStep] = useState(1);
  const [draftRoots, setDraftRoots] = useState<DraftRoot[]>([]);
  const [newPath, setNewPath] = useState("");
  const [newAccount, setNewAccount] = useState(accountKeys[0] ?? "work");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const browse = async () => {
    const p = await pickDirectory();
    if (p) setNewPath(p);
  };

  const addDraftRoot = async () => {
    const raw = newPath.trim();
    if (!raw || port == null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await scanPreview(port, raw);
      // invalid/missing/not_dir：路徑不可用 → 不加 draft、即時回饋（onboard 原子，
      // 預先擋掉才不會在 finish 時整批 400）
      if (res.status === "invalid" || res.status === "missing" || res.status === "not_dir") {
        setError(
          res.status === "invalid" ? "請輸入有效的絕對路徑"
          : res.status === "missing" ? "找不到此資料夾"
          : "這不是資料夾",
        );
        return;
      }
      // denied：路徑有效但當下不可讀（count 可能為 0）→ 仍加入，用 amber notice 而非紅色
      // error（紅 banner 會讓「其實加成功」看起來像失敗）
      if (res.status === "denied") setNotice("部分資料夾無法讀取，請到系統設定授權");
      // dedup 放進 functional updater 內讀最新 state（避免快速連點看到舊 draftRoots）
      setDraftRoots((rs) =>
        rs.some((r) => r.path === res.path) ? rs : [...rs, { path: res.path, account: newAccount, count: res.count }],
      );
      setNewPath("");
    } catch (e) {
      setError(`掃描失敗：${e}`); // 連線/後端錯誤要可見
    } finally {
      setBusy(false);
    }
  };

  const setDraftAccount = (path: string, account: string) =>
    setDraftRoots((rs) => rs.map((r) => (r.path === path ? { ...r, account } : r)));
  const removeDraft = (path: string) => {
    setDraftRoots((rs) => rs.filter((r) => r.path !== path));
    setNotice(null); // denied 提示是 add 動作的暫態回饋，移除 draft 後該清掉、免殘留誤導
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await completeOnboarding(
        draftRoots.map((r) => ({ path: r.path, default_account: r.account })),
      );
      onClose();
    } catch (e) {
      setError(`設定寫入失敗：${e}`); // onboard 409/400/連線錯誤要可見（Codex final review L2）
    } finally {
      setBusy(false);
    }
  };

  const totalProjects = draftRoots.reduce((s, r) => s + r.count, 0);
  const distinctAccounts = new Set(draftRoots.map((r) => r.account)).size;

  return (
    <div className="ob-overlay">
      {/* 裝飾光暈：pointer-events none，不影響互動 */}
      <div className="ob-glow" aria-hidden="true" />
      <div className="ob-glow-two" aria-hidden="true" />

      <div className="ob-inner">
        {/* 品牌 header：三步都顯示 */}
        <div className="ob-logo">
          <FeatherMark size={46} />
          <span className="ob-logo-name">Fledge</span>
        </div>
        <div className="ob-tag">Where your AI projects take off.</div>
        <div className="ob-built">Built for Claude Code</div>

        {/* 卡片主體 */}
        <div className="ob-card">
          {/* 進度條：三條橫槓，n <= step 為填色 */}
          <div className="ob-steps" role="progressbar" aria-label="設定步驟" aria-valuenow={step} aria-valuemin={1} aria-valuemax={TOTAL_STEPS}>
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <div
                key={i}
                className={`ob-step-bar${i + 1 <= step ? " is-on" : ""}`}
              />
            ))}
          </div>

          {/* 錯誤 / 注意訊息 */}
          {error && <div className="ob-error" role="alert">{error}</div>}
          {notice && <div className="ob-notice" role="status">{notice}</div>}

          {/* ── 步驟 1：歡迎 ── */}
          {step === 1 && (
            <div className="ob-step-center">
              <h2 className="ob-h">歡迎使用 Fledge</h2>
              <p className="ob-sub">
                Fledge 為你的 Claude Code 套上圖形化工作台：管理多個專案、分隔工作／私人帳號、同時開多個 session。
                <br />
                接下來 3 步設定好工作根目錄就能開始。
              </p>
              <div className="ob-actions-center">
                <button onClick={() => setStep(2)} className="ob-btn">開始設定</button>
              </div>
            </div>
          )}

          {/* ── 步驟 2：根目錄 ── */}
          {step === 2 && (
            <div>
              <h2 className="ob-h">設定工作根目錄</h2>
              <p className="ob-sub">每個根資料夾會掃描第一層子資料夾作為專案。</p>

              {/* 已加入的根目錄列表 */}
              {draftRoots.map((r) => (
                <div key={r.path} className="ob-row">
                  <span className="ob-row-path">{r.path}</span>
                  <select
                    value={r.account}
                    onChange={(e) => setDraftAccount(r.path, e.target.value)}
                    className="ob-sel"
                  >
                    {accountKeys.map((a) => (<option key={a} value={a}>{a}</option>))}
                  </select>
                  <span className="ob-row-count">
                    <Check size={12} strokeWidth={2} />{r.count}
                  </span>
                  <button onClick={() => removeDraft(r.path)} className="ob-btn-del">刪</button>
                </div>
              ))}

              {/* 新增根目錄輸入列 */}
              <div className="ob-add-row">
                <input
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="/絕對路徑/到/工作根目錄"
                  className="ob-input"
                />
                <button onClick={browse} className="ob-btn-ghost">瀏覽…</button>
                <select
                  value={newAccount}
                  onChange={(e) => setNewAccount(e.target.value)}
                  className="ob-sel"
                >
                  {accountKeys.map((a) => (<option key={a} value={a}>{a}</option>))}
                </select>
                <button onClick={addDraftRoot} disabled={busy} className="ob-btn">+ 加根</button>
              </div>

              <div className="ob-actions">
                <button onClick={() => setStep(1)} className="ob-btn-ghost">上一步</button>
                <button
                  onClick={() => setStep(3)}
                  disabled={draftRoots.length === 0}
                  className="ob-btn"
                >下一步</button>
              </div>
            </div>
          )}

          {/* ── 步驟 3：完成 ── */}
          {step === 3 && (
            <div className="ob-step-center">
              <h2 className="ob-h">設定完成</h2>
              <p className="ob-summary">
                掃描到 <b>{totalProjects}</b> 個專案
                <br />
                來自 <b>{draftRoots.length}</b> 個根目錄、
                <b>{distinctAccounts}</b> 個帳號
              </p>
              <div className="ob-actions-center">
                <button onClick={() => setStep(2)} className="ob-btn-ghost">上一步</button>
                <button onClick={finish} disabled={busy} className="ob-btn">進入主畫面</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

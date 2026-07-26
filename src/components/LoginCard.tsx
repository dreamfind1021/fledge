import type { ReactNode } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useCardSession } from "../lib/useCardSession";
import { CardTerminal } from "./CardTerminal";

interface AccountInfo {
  config_dir: string;
  label: string;
}

interface LoginCardProps {
  port: number | null;
  accounts: Record<string, AccountInfo>;
  onPrev: () => void;
  onNext: () => void;
}

// 一張登入卡要送出的東西。account 為 undefined＝不綁帳號（codex 登入是全域的，
// 後端對 login_target=codex 不驗帳號也不注入 CLAUDE_CONFIG_DIR）。
interface LoginTarget {
  id: string;
  title: string;
  desc: ReactNode;
  account?: string;
  target: "claude" | "codex";
}

/** 精靈的登入頁：每個帳號一張卡（開帶該帳號 `CLAUDE_CONFIG_DIR` 的終端機跑 OAuth），
 *  Codex 另有一張（全域登入、不分帳號）。
 *
 * **刻意不顯示完成狀態**：macOS 的 Claude 憑證存在 Keychain 而非 `config_dir`，前端沒有可靠的
 * 成功訊號（spec-b4 §1）。假裝有綠勾就是騙人——卡片只承諾「開一個環境正確的終端機」。 */
export function LoginCard({ port, accounts, onPrev, onNext }: LoginCardProps) {
  const { t } = useTranslation("onboarding");
  const { running, starting, error, start } = useCardSession<string>(port);

  const cards: LoginTarget[] = [
    // 帳號卡與全域卡走不相交的命名空間："codex" 是合法帳號 key，共用前綴會讓兩張卡撞 id，
    // 進而在兩處各掛一個指向同一 session 的終端機（Codex 票25 R1 Medium-2）
    ...Object.keys(accounts).map((key) => ({
      id: `login-account-${key}`,
      title: key,
      desc: <span className="b4-mono">{accounts[key].config_dir}</span>,
      account: key,
      target: "claude" as const,
    })),
    // Codex 登入本質全域（B-1 收尾票已確認），只給一張、不做成 per-account，也不掛在帳號數上。
    // "Codex" 是品牌名、不進 catalog（比照 Fledge wordmark，§4.6.13 記錄例外）。
    { id: "login-global-codex", title: "Codex", desc: t("login.codexDesc"), target: "codex" as const },
  ];

  const openLogin = (card: LoginTarget) =>
    start({
      cardId: card.id,
      // path 送空字串：登入不屬於任何專案，後端固定跑在 home（與 kind=install 一致）
      options: { path: "", account: card.account, kind: "login", loginTarget: card.target },
      meta: card.title,
      mapError: (code) => (code === "unknown_account" ? t("errors.unknown_account") : null),
      fallbackError: (reason) => t("errors.login_failed", { reason }),
    });

  return (
    <div>
      <h2 className="ob-h">{t("login.h")}</h2>
      <p className="ob-sub">{t("login.sub")}</p>

      {/* 說明「為什麼這頁沒有完成狀態」——本頁最重要的一段文案 */}
      <div className="b4-note"><Trans t={t} i18nKey="login.note" /></div>

      {error && <div className="ob-error" role="alert">{error}</div>}

      {cards.map((card, i) => (
        <div key={card.id} className="b4-card">
          <div className="b4-card-top">
            <div>
              <p className="b4-card-title">{card.title}</p>
              <p className="b4-card-desc">{card.desc}</p>
            </div>
            <span className="b4-card-actions">
              <button
                className={`b4-btn-sm${i === 0 ? " primary" : ""}`}
                onClick={() => openLogin(card)}
                disabled={starting}
              >{t("login.open")}</button>
            </span>
          </div>

          {/* 標頭只放卡片識別、不重述將執行的命令——命令由後端 `_resolve_command` 決定，
              前端自組字串等於多一份會漂移的真值（比照票 24 不顯示「執行中」的理由） */}
          {running?.cardId === card.id && port != null && (
            <CardTerminal
              port={port}
              sessionId={running.sessionId}
              tabId={running.tabId}
              title={running.meta}
            />
          )}
        </div>
      ))}

      {/* 離開這一步會收掉登入終端機（unmount 一律 closeSession）——OAuth 跑到一半按下一步
          就中斷了，而 note 又叫使用者「看終端機輸出」，不講清楚會自相矛盾（票 24 的
          env.installHint 是同一種告知）。只在真的有終端機掛著時才提示。 */}
      {running && <p className="b4-hint b4-hint-warn">{t("login.leaveHint")}</p>}

      <div className="ob-actions">
        <button onClick={onPrev} className="ob-btn-ghost">{t("common.prev")}</button>
        <div className="ob-actions-right">
          <button onClick={onNext} className="b4-skip">{t("login.later")}</button>
          <button onClick={onNext} className="ob-btn">{t("common.next")}</button>
        </div>
      </div>
    </div>
  );
}

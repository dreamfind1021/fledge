import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchUsageDashboard, fetchCodexUsage, UsageDashboard, CodexUsage, CodexUsageWindow } from "../lib/sidecar";
import { shouldPoll, POLL_INTERVAL_MS, CODEX_USAGE_INTERVAL_MS } from "../lib/usagePoll";
import { fmtUSD, fmtPct, fmtDayClock, codexWindowLabel } from "../lib/usageFormat";
import { donutParts } from "../lib/dashboardLogic";
import "./Dashboard.css";

export default function Dashboard({ port, isActive }: { port: number; isActive: boolean }) {
  const { t } = useTranslation("dashboard");
  const [data, setData] = useState<UsageDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codex, setCodex] = useState<CodexUsage | null>(null);
  const timer = useRef<number | null>(null);

  // Codex 實時額度（獨立節奏，不隨 30s 檔案掃描）：開啟即抓、開著每 15 分鐘、
  // 重開（isActive→true 重跑 effect）強制重抓、沒在看不抓。後端 60s floor 防爆量。
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const load = async () => {
      if (document.hidden) return;
      try { const c = await fetchCodexUsage(port); if (!cancelled) setCodex(c); }
      // sidecar 不可達（transport 失敗）→ 切 unavailable，不續顯陳舊 gauge（Codex 審查 finding #3）
      catch { if (!cancelled) setCodex({ source: "unavailable", failure_reason: "network", observed_at: null }); }
    };
    load();
    const id = window.setInterval(load, CODEX_USAGE_INTERVAL_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [port, isActive]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (!shouldPoll({ isActiveTab: isActive, documentHidden: document.hidden })) return;
      try {
        const d = await fetchUsageDashboard(port);
        if (!cancelled && d) { setData(d); setError(null); }
        // d === null（202 首掃中）：保持骨架，下輪再試
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e)); // 保留舊資料（design §14）
      }
    }
    tick();
    timer.current = window.setInterval(tick, data ? POLL_INTERVAL_MS : 2_000); // 首掃較密
    const onVis = () => tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [port, isActive, data === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) {
    // 冷啟中＝骨架；冷啟失敗（fetch 對 error-only 200 會 throw）＝骨架＋錯誤訊息，下輪自動重試
    return (
      <div className="dash-root dash-loading">
        {error ? t("state.error", { msg: error }) : t("state.loading")}
      </div>
    );
  }
  const stale = data.scan_meta.state === "scanning" || error != null;
  return (
    <div className="dash-root">
      <div className="dash-head">
        <span className="dash-title">{t("entry")}</span>
        {stale && <span className="dash-stale">{t("state.stale")}</span>}
      </div>
      {data.scan_meta.state === "error" && (
        <div className="dash-error">{t("state.error", { msg: data.scan_meta.error ?? "" })}</div>
      )}
      {data.scan_meta.missing_pricing.length > 0 && (
        // 列出模型名而非個數：看到名字才知道要 sync 什麼（admin/sync_pricing.py）
        <div className="dash-warn">{t("state.missingPricing", {
          models: data.scan_meta.missing_pricing.join(t("state.listSeparator")),
        })}</div>
      )}
      <KpiBar kpi={data.kpi} t={t} />
      <div className="dash-row dash-row-usage">
        <DailyChart daily={data.daily} t={t} />
        <CodexPanel codex={codex} t={t} />
      </div>
      <div className="dash-row">
        <ModelDonut models={data.models} t={t} />
        <HourlyHeatmap hourly={data.hourly} t={t} />
      </div>
      <ProjectsTable projects={data.projects} t={t} />
    </div>
  );
}

type T = (key: string, opts?: Record<string, unknown>) => string;

function KpiBar({ kpi, t }: { kpi: UsageDashboard["kpi"]; t: T }) {
  // 單值卡共用渲染；cacheHit 因需卡內兩行（分源）另外手寫
  const card = (label: string, value: string, extra?: string, isPos?: boolean) => (
    <div key={label} className="dash-kpi-card">
      <div className={`dash-kpi-value${isPos ? " is-pos" : ""}`}>{value}</div>
      <div className="dash-kpi-label">{label}</div>
      {extra && <div className="dash-kpi-extra">{extra}</div>}
    </div>
  );
  return (
    <div className="dash-kpi">
      {card(t("kpi.month"), fmtUSD(kpi.month_value))}
      {card(t("kpi.week"), fmtUSD(kpi.week_value))}
      {card(t("kpi.today"), fmtUSD(kpi.today_value))}
      <div className="dash-kpi-card">
        <div className="dash-kpi-split">
          <span className="dash-kpi-split-label">Claude</span>
          <span className="dash-kpi-split-value">{fmtPct(kpi.claude_cache_hit_rate)}</span>
        </div>
        <div className="dash-kpi-split">
          <span className="dash-kpi-split-label">Codex</span>
          <span className="dash-kpi-split-value">{fmtPct(kpi.codex_cache_hit_rate)}</span>
        </div>
        <div className="dash-kpi-label">{t("kpi.cacheHit")}</div>
      </div>
      {card(t("kpi.netRoi"), fmtUSD(kpi.net_roi),
            `${t("kpi.subs")} ${fmtUSD(kpi.subscriptions_total)}`, kpi.net_roi > 0)}
    </div>
  );
}

// export 僅供 render test（Dashboard.test.tsx）——app 內只由 Dashboard 使用
export function CodexPanel({ codex, t }: { codex: CodexUsage | null; t: T }) {
  const live = codex?.source === "live" ? codex : null;
  // 失敗不端陳舊數字（會重現原失準 bug）：依 failure_reason 誠實顯示「不可用／需重新登入」
  const reauth = codex?.failure_reason === "unauthorized" || codex?.failure_reason === "no_auth";
  return (
    <div className="dash-windows">
      <div className="dash-win-card">
        <div className="dash-win-title">
          {t("windows.codex")}
          {live?.plan_type ? <span className="dash-badge">{live.plan_type}</span> : null}
        </div>
        {live?.primary ? (<>
          <Gauge label={winLabel(live.primary, "fiveHour", t)} win={live.primary} t={t} />
          {live.secondary &&
            <Gauge label={winLabel(live.secondary, "weekly", t)} win={live.secondary} t={t} />}
        </>) : (
          <div className="dash-win-meta">
            {t(reauth ? "windows.codexReauth" : "windows.codexUnavailable")}
          </div>
        )}
      </div>
    </div>
  );
}

// 標籤依實際 window_minutes 判定（API 曾把週窗改放 primary），位置只當 fallback
function winLabel(win: CodexUsageWindow, fallback: "fiveHour" | "weekly", t: T): string {
  const l = codexWindowLabel(win.window_minutes, fallback);
  return "n" in l ? t(`windows.${l.key}`, { n: l.n }) : t(`windows.${l.key}`);
}

function Gauge({ label, win, t }: { label: string; win: CodexUsageWindow; t: T }) {
  const resets = win.resets_at != null
    ? t("windows.resets", { time: fmtDayClock(win.resets_at, t("time.yesterday")) }) : "";
  return (
    <div className="dash-gauge">
      <span className="dash-gauge-label">{label}</span>
      <div className="dash-bar is-codex"><i style={{ width: `${Math.min(100, win.used_percent)}%` }} /></div>
      <span className="dash-gauge-meta">{Math.round(win.used_percent)}%{resets ? ` · ${resets}` : ""}</span>
    </div>
  );
}

const MODEL_COLORS = ["var(--primary)", "var(--ai)", "var(--session)", "var(--warning)", "var(--faint)"];

function DailyChart({ daily, t }: { daily: UsageDashboard["daily"]; t: T }) {
  const max = Math.max(0.01, ...daily.map((d) => d.total));
  // 模型→顏色：以 30 天總成本排序取前 4，其餘灰（與 donut 同邏輯保持色彩一致）
  const totals = new Map<string, number>();
  daily.forEach((d) => Object.entries(d.by_model).forEach(([m, c]) =>
    totals.set(m, (totals.get(m) ?? 0) + c)));
  const order = [...totals.entries()].sort((x, y) => y[1] - x[1]).map(([m]) => m);
  const colorOf = (m: string) => MODEL_COLORS[Math.min(order.indexOf(m), 4)] ?? "var(--faint)";
  // 全域排序：以 30 天總量 rank 決定每日色段順序，同色段不跨日跳位
  const rank = (m: string) => { const i = order.indexOf(m); return i < 0 ? 999 : i; };
  return (
    <div className="dash-panel">
      <div className="dash-panel-title">{t("daily.title", { days: 30 })}</div>
      <div className="dash-daily">
        {daily.map((d) => (
          <div key={d.date} className="dash-daily-col" title={`${d.date} ${fmtUSD(d.total)}`}
               style={{ height: `${Math.max(2, (d.total / max) * 100)}%` }}>
            {Object.entries(d.by_model).sort((x, y) => rank(x[0]) - rank(y[0])).map(([m, c]) => (
              <i key={m} style={{ flex: c, background: colorOf(m) }} />
            ))}
          </div>
        ))}
      </div>
      <div className="dash-legend">
        {order.slice(0, 4).map((m) => (
          <span key={m}><i style={{ background: colorOf(m) }} />{m}</span>
        ))}
      </div>
    </div>
  );
}

function ModelDonut({ models, t }: { models: UsageDashboard["models"]; t: T }) {
  const parts = donutParts(models);
  const stops = parts.map((p, i) =>
    `${MODEL_COLORS[i % MODEL_COLORS.length]} ${p.fromDeg}deg ${p.toDeg}deg`).join(", ");
  const total = parts.reduce((s, p) => s + p.cost, 0);
  return (
    <div className="dash-panel">
      <div className="dash-panel-title">{t("models.title")}</div>
      {parts.length === 0 ? <div className="dash-win-meta">{t("state.empty")}</div> : (
        <div className="dash-donut-wrap">
          <div className="dash-donut" style={{ background: `conic-gradient(${stops})` }}>
            <div className="dash-donut-center"><b>{fmtUSD(total)}</b></div>
          </div>
          <ul className="dash-donut-legend">
            {parts.map((p, i) => (
              <li key={p.label}><i style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                {p.label} <em>{fmtUSD(p.cost)}</em></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function HourlyHeatmap({ hourly, t }: { hourly: number[][]; t: T }) {
  const max = Math.max(0.0001, ...hourly.flat());
  // dow 標籤從 catalog 讀取（後端 weekday() 0=Monday）
  const dows = t("hourly.dow").split(",");
  return (
    <div className="dash-panel">
      <div className="dash-panel-title">{t("hourly.title")}</div>
      <div className="dash-heatmap">
        {hourly.map((row, d) => (
          <Fragment key={d}>
            <span className="dash-heatmap-dow">{dows[d]}</span>
            {row.map((v, h) => (
              <b key={`${d}-${h}`} style={{ opacity: v === 0 ? 0.06 : 0.25 + 0.75 * (v / max) }} />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="dash-hm-axis"><span /><span>00</span><span>06</span><span>12</span><span>18</span></div>
    </div>
  );
}

function ProjectsTable({ projects, t }: { projects: UsageDashboard["projects"]; t: T }) {
  return (
    <div className="dash-panel">
      <div className="dash-panel-title">{t("projects.title")}</div>
      <table className="dash-table">
        <thead><tr><th>{t("projects.project")}</th><th className="dash-th-num">{t("projects.claude")}</th>
          <th className="dash-th-num">{t("projects.codex")}</th><th className="dash-th-num">{t("projects.total")}</th>
          <th className="dash-th-num">{t("projects.lastActive")}</th></tr></thead>
        <tbody>
          {projects.slice(0, 30).map((p) => (
            <tr key={p.path}>
              <td title={p.path}>
                <span className="dash-proj-name">{p.path.split("/").pop() || p.path}</span>
                <span className="dash-proj-path">{p.path}</span>
              </td>
              <td>{fmtUSD(p.claude_cost)}</td>
              <td>{p.codex_cost > 0 ? fmtUSD(p.codex_cost) : "—"}</td>
              <td className="dash-td-total">{fmtUSD(p.total)}</td>
              <td>{p.last_active ? fmtDayClock(p.last_active, t("time.yesterday")) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

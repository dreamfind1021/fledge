import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchUsageDashboard, UsageDashboard } from "../lib/sidecar";
import { shouldPoll, POLL_INTERVAL_MS } from "../lib/usagePoll";
import { fmtUSD, fmtPct, fmtTokens, fmtClock, fmtDayClock } from "../lib/usageFormat";
import { donutParts, claudeAccountRow } from "../lib/dashboardLogic";
import "./Dashboard.css";

export default function Dashboard({ port, isActive }: { port: number; isActive: boolean }) {
  const { t } = useTranslation("dashboard");
  const [data, setData] = useState<UsageDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

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
        <div className="dash-warn">{t("state.missingPricing", { count: data.scan_meta.missing_pricing.length })}</div>
      )}
      <KpiBar kpi={data.kpi} t={t} />
      <WindowsPanel blocks={data.blocks} t={t} />
      <DailyChart daily={data.daily} t={t} />
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

function WindowsPanel({ blocks, t }: { blocks: UsageDashboard["blocks"]; t: T }) {
  const cx = blocks.codex;
  const now = Date.now() / 1000;
  // 防 schema skew/後端 regression 把 accounts 漏掉時整個 dashboard 白屏（type 雖保證、runtime 防衛）
  const accounts = blocks.claude.accounts ?? [];
  return (
    <div className="dash-windows">
      <div className="dash-win-card">
        <div className="dash-win-title">{t("windows.claude")}</div>
        {accounts.length === 0 && (
          <div className="dash-win-meta">{t("state.empty")}</div>
        )}
        {accounts.map((acc) => {
          const r = claudeAccountRow(acc, now);
          return (
            <div className="dash-win-acct" key={acc.account_key}>
              <div className="dash-win-acct-label">
                {r.label}
                {r.partial && <span className="dash-est-badge">{t("windows.partialEstimate")}</span>}
              </div>
              {r.empty ? (
                <div className="dash-win-meta">{t("state.empty")}</div>
              ) : (<>
                {r.showBar && (
                  <div className="dash-bar"><i style={{ width: `${Math.round((r.pct ?? 0) * 100)}%` }} /></div>
                )}
                <div className="dash-win-meta">
                  <span><b>{fmtTokens(r.used)}</b>{r.limit != null ? ` / ${fmtTokens(r.limit)}` : ""}</span>
                  {r.burnRate != null && <span>{t("windows.burnRate", { rate: fmtTokens(Math.round(r.burnRate)) })}</span>}
                  {r.endTs != null && <span>{t("windows.claudeReset", { time: fmtClock(r.endTs) })}</span>}
                  {!r.showBar && <span>{t("windows.limitSampling")}</span>}
                </div>
              </>)}
            </div>
          );
        })}
      </div>
      <div className="dash-win-card">
        <div className="dash-win-title">{t("windows.codex")}{cx.plan_type ? <span className="dash-badge">{cx.plan_type}</span> : null}</div>
        {cx.primary ? (<>
          <Gauge label={t("windows.fiveHour")} pct={cx.primary.used_percent}
                 resets={t("windows.resets", { time: fmtDayClock(cx.primary.resets_at, t("time.yesterday")) })} />
          {cx.secondary && <Gauge label={t("windows.weekly")} pct={cx.secondary.used_percent}
                 resets={t("windows.resets", { time: fmtDayClock(cx.secondary.resets_at, t("time.yesterday")) })} />}
        </>) : <div className="dash-win-meta">{t("state.empty")}</div>}
      </div>
    </div>
  );
}

function Gauge({ label, pct, resets }: { label: string; pct: number; resets: string }) {
  return (
    <div className="dash-gauge">
      <span className="dash-gauge-label">{label}</span>
      <div className="dash-bar is-codex"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
      <span className="dash-gauge-meta">{Math.round(pct)}% · {resets}</span>
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

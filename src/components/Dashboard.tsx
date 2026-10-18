import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchUsageDashboard, fetchCodexUsage, UsageDashboard, CodexUsage, CodexUsageWindow } from "../lib/sidecar";
import { shouldPoll, POLL_INTERVAL_MS, CODEX_USAGE_INTERVAL_MS } from "../lib/usagePoll";
import { fmtUSD, fmtPct, fmtDayClock, codexWindowLabel } from "../lib/usageFormat";
import { colorIndex, endLabels, isAheadOfPace, labelX, localDateKey, mergeTempProjects, MODEL_COLORS, peakIndex, rankModels,
         windowElapsedPct } from "../lib/dashboardLogic";
import type { ModelRanking } from "../lib/dashboardLogic";
import "./Dashboard.css";

// 期間天數只有這一個來源：請求帶它；標題寫 payload 的 scan_meta.days（掃描中 sidecar 回上一份成功的資料，
// 天數可能跟請求不同——routes/usage.py 的註解寫明以 scan_meta.days 為準），沒有值才退回這個常數（票 46，spec §4.2）
const DASH_DAYS = 30;

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
        const d = await fetchUsageDashboard(port, DASH_DAYS);
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
  const days = data.scan_meta.days ?? DASH_DAYS;
  const ranking = rankModels(data.models);
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
      <KpiBar kpi={data.kpi} days={days} t={t} />
      {/* Codex 額度是數字卡下方一整條、每日成本獨佔一整排（票 46，spec §4.3）：並排時 Codex 卡被拉到跟長條圖一樣高，內容只佔一行 */}
      <CodexPanel codex={codex} t={t} />
      <DailyChart daily={data.daily} ranking={ranking} days={days} t={t} />
      <div className="dash-row">
        <ModelBars ranking={ranking} days={days} t={t} />
        <HourlyHeatmap hourly={data.hourly} days={days} t={t} />
      </div>
      <ProjectsTable projects={data.projects} days={days} t={t} />
    </div>
  );
}

type T = (key: string, opts?: Record<string, unknown>) => string;

function KpiBar({ kpi, days, t }: { kpi: UsageDashboard["kpi"]; days: number; t: T }) {
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
        <div className="dash-kpi-label">{t("kpi.cacheHit", { days })}</div>
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
  // null＝這個分頁還沒抓到第一筆（每次開儀表板都要等 app-server 啟動），不是失敗
  const status = codex == null ? "windows.codexLoading"
    : reauth ? "windows.codexReauth" : "windows.codexUnavailable";
  const wins: { win: CodexUsageWindow; fallback: "fiveHour" | "weekly" }[] = [];
  if (live?.primary) {
    wins.push({ win: live.primary, fallback: "fiveHour" });
    if (live.secondary) wins.push({ win: live.secondary, fallback: "weekly" });
  }
  const nowSec = Date.now() / 1000;
  // 一整條：左邊標題，右邊每個窗口一行「名稱｜進度條｜百分比 · 重置時間」。多個窗口共用 .dash-cx-rows 這一個 grid 的欄寬，
  // 每條進度條一樣長（取代票 35 第 3 題的兩行排法：那是為了窄卡片裡兩條不等長、被擠到 0，佔整排之後兩個理由都不成立）
  return (
    <div className="dash-win-card dash-cx-strip">
      <div className="dash-win-title">
        {t("windows.codex")}
        {live?.plan_type ? <span className="dash-badge">{live.plan_type}</span> : null}
      </div>
      {wins.length > 0 ? (
        <div className="dash-cx-rows">
          {wins.map(({ win, fallback }) => (
            <QuotaRow key={fallback} label={winLabel(win, fallback, t)} win={win} nowSec={nowSec} t={t} />
          ))}
        </div>
      ) : (
        <div className="dash-win-meta">{t(status)}</div>
      )}
    </div>
  );
}

// 標籤依實際 window_minutes 判定（API 曾把週窗改放 primary），位置只當 fallback
function winLabel(win: CodexUsageWindow, fallback: "fiveHour" | "weekly", t: T): string {
  const l = codexWindowLabel(win.window_minutes, fallback);
  return "n" in l ? t(`windows.${l.key}`, { n: l.n }) : t(`windows.${l.key}`);
}

// 一個窗口＝grid 的三格。條上的細直線＝窗口時間過了多少；用量比時間多 10 點以上條變黃（spec §4.3、§8）
function QuotaRow({ label, win, nowSec, t }: { label: string; win: CodexUsageWindow; nowSec: number; t: T }) {
  const resets = win.resets_at != null
    ? t("windows.resets", { time: fmtDayClock(win.resets_at, t("time.yesterday")) }) : "";
  const elapsed = windowElapsedPct(win, nowSec);
  return (
    <>
      <span className="dash-cx-label">{label}</span>
      <div className="dash-cx-bar">
        <div className={`dash-bar is-codex${isAheadOfPace(win.used_percent, elapsed) ? " is-ahead" : ""}`}>
          <i style={{ width: `${Math.min(100, win.used_percent)}%` }} />
        </div>
        {elapsed != null && (
          <b className="dash-pace" style={{ left: `${elapsed}%` }} title={t("windows.pace", { n: Math.round(elapsed) })} />
        )}
      </div>
      <span className="dash-cx-meta">{Math.round(win.used_percent)}%{resets ? ` · ${resets}` : ""}</span>
    </>
  );
}

// export 僅供 render test（Dashboard.test.tsx）
export function DailyChart({ daily, ranking, days, t }: {
  daily: UsageDashboard["daily"]; ranking: ModelRanking; days: number; t: T;
}) {
  const max = Math.max(0.01, ...daily.map((d) => d.total));
  // 顏色、色段順序、圖例都照模型分布那份排名（票 46，spec §4.5）：自己從 daily 排的話，同名模型跨來源時兩張圖對不上
  const colorOf = (m: string) => MODEL_COLORS[colorIndex(ranking, m)];
  // 全域排序：同色段不跨日跳位
  const rank = (m: string) => { const i = ranking.order.indexOf(m); return i < 0 ? 999 : i; };
  // 最高金額與頭尾日期（spec §4.4）：位置都用比例算法，最左那欄靠左、最右那欄靠右，不會超出圖
  const peak = peakIndex(daily.map((d) => d.total));
  const at = (i: number) => { const x = labelX(i, daily.length); return { left: `${x}%`, transform: `translateX(-${x}%)` }; };
  return (
    <div className="dash-panel dash-daily-panel">
      <div className="dash-panel-title">{t("daily.title", { days })}</div>
      <div className="dash-daily-wrap">
        {peak != null && <span className="dash-daily-peak" style={at(peak)}>{fmtUSD(daily[peak].total)}</span>}
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
      </div>
      <div className="dash-daily-axis">
        {endLabels(daily.map((d) => d.date), localDateKey(Date.now())).map((l) => (
          <span key={l.index} className={l.text == null ? "is-today" : undefined} style={at(l.index)}>
            {l.text ?? t("daily.today")}
          </span>
        ))}
      </div>
      <div className="dash-legend">
        {ranking.top.map((p) => (
          <span key={p.model}><i style={{ background: colorOf(p.model) }} />{p.model}</span>
        ))}
        {/* 第 5 名以後的色段是灰的，圖例要說那是什麼 */}
        {ranking.rest.length > 0 && <span><i style={{ background: MODEL_COLORS[4] }} />{t("daily.other")}</span>}
      </div>
    </div>
  );
}

// 排名長條、固定軌道（票 46，spec §4.5，同待辦面板的軌道）：每列一樣長、填充＝佔總額多少、數字在軌道右端。
// 填充是模型色淡化（.dash-mbar-fill.is-r0～4），數字壓在上面才讀得到。export 僅供 render test
export function ModelBars({ ranking, days, t }: { ranking: ModelRanking; days: number; t: T }) {
  const rows = [
    ...ranking.top.map((p) => ({ label: p.model, cost: p.cost, title: undefined as string | undefined })),
    ...(ranking.rest.length > 0 ? [{
      label: t("models.other", { n: ranking.rest.length }),
      cost: ranking.rest.reduce((s, p) => s + p.cost, 0),
      title: ranking.rest.map((p) => `${p.model} ${fmtUSD(p.cost)}`).join("\n"),
    }] : []),
  ];
  return (
    <div className="dash-panel">
      <div className="dash-panel-title">
        {t("models.title", { days })}
        {rows.length > 0 && <span className="dash-panel-total">{fmtUSD(ranking.total)}</span>}
      </div>
      {rows.length === 0 ? <div className="dash-win-meta">{t("state.empty")}</div> : (
        <ul className="dash-mbars">
          {rows.map((r, i) => (
            <li key={i}>
              <span className="dash-mbar-name" title={r.title}><i style={{ background: MODEL_COLORS[i] }} />{r.label}</span>
              <span className="dash-mbar-trk">
                {/* 沒有最小寬度：硬給的話會誇大小額模型的佔比，金額已經寫在軌道右端 */}
                <span className={`dash-mbar-fill is-r${i}`}
                      style={{ width: `${ranking.total > 0 ? (r.cost / ranking.total) * 100 : 0}%` }} />
                <span className="dash-mbar-num">{fmtUSD(r.cost)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HourlyHeatmap({ hourly, days, t }: { hourly: number[][]; days: number; t: T }) {
  const max = Math.max(0.0001, ...hourly.flat());
  // dow 標籤從 catalog 讀取（後端 weekday() 0=Monday）
  const dows = t("hourly.dow").split(",");
  return (
    <div className="dash-panel">
      <div className="dash-panel-title">{t("hourly.title", { days })}</div>
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

// export 僅供 render test（Dashboard.test.tsx）
export function ProjectsTable({ projects, days, t }: { projects: UsageDashboard["projects"]; days: number; t: T }) {
  return (
    <div className="dash-panel">
      <div className="dash-panel-title">{t("projects.title", { days })}</div>
      <table className="dash-table">
        <thead><tr><th>{t("projects.project")}</th><th className="dash-th-num">{t("projects.claude")}</th>
          <th className="dash-th-num">{t("projects.codex")}</th><th className="dash-th-num">{t("projects.total")}</th>
          <th className="dash-th-num">{t("projects.lastActive")}</th></tr></thead>
        <tbody>
          {/* 全部列出，不設上限：只取前 30 名時，暫存資料夾就能把真專案擠出表外（票 46，spec §4.1） */}
          {mergeTempProjects(projects).map((p) => (
            <tr key={p.tempPaths ? "temp" : p.path}>
              <td title={p.tempPaths ? p.tempPaths.join("\n") : p.path}>
                <span className="dash-proj-name">{p.tempPaths ? t("projects.tempName") : p.path.split("/").pop() || p.path}</span>
                <span className="dash-proj-path">{p.tempPaths ? t("projects.tempCount", { n: p.tempPaths.length }) : p.path}</span>
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

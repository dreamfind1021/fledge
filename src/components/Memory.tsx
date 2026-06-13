import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { fetchMemoryOverview, fetchMemoryItem, confirmSuggestion, dismissSuggestion, type MemoryOverview, type MemoryItem } from "../lib/sidecar";
import "./Memory.css";

export function Memory({ port, isActive }: { port: number | null; isActive: boolean }) {
  const { t } = useTranslation("memory");
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => {
    if (port == null) return;
    fetchMemoryOverview(port, q).then(setData).catch(() => {});
  }, [port, q]);
  // 開啟即載 + 輪詢 gating（active + 非隱藏），比照 dashboard
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => clearInterval(id);
  }, [isActive, load]);

  if (!data) return <div className="mem-root"><div className="mem-loading">…</div></div>;
  return (
    <div className="mem-root">
      <div className="mem-head"><h1>{t("tabTitle")}</h1>
        <span className="mem-stat">{data.scan_meta.total} · unknown {data.scan_meta.unknown_count}</span></div>
      <input className="mem-search" placeholder={t("search")} value={q}
        onChange={(e) => setQ(e.target.value)} />
      {data.global.length > 0 && (
        <section className="mem-global">
          <div className="mem-sec-h global">🌐 {t("section.global")}</div>
          {data.global.map((it) => <MemRow key={it.path} it={it} port={port} />)}
        </section>
      )}
      {data.projects.map((p) => (
        <section key={p.project} className="pblock">
          <div className="pb-head">
            <span className="fo">📁</span>
            <span className="pn">{p.project.split("/").pop()}</span>
            <div className="pb-rel">
              {p.related.map((r) => <span key={r} className="relchip">{r.split("/").pop()}</span>)}
              {p.suggestions.map((s) => (
                <span key={s.topic} className="relchip sug">
                  {s.topic_name}<span className="sg">{t("related.suggest")}</span>
                  <button onClick={() => { confirmSuggestion(port!, s.project, s.topic).then(load); }}>✓</button>
                  <button onClick={() => { dismissSuggestion(port!, s.project, s.topic).then(load); }}>✕</button>
                </span>
              ))}
            </div>
          </div>
          <div className="pb-body">{p.items.map((it) => <MemRow key={it.path} it={it} port={port} />)}</div>
        </section>
      ))}
      {data.kb.length > 0 && (
        <section className="mem-kb">
          <div className="mem-sec-h kb">📚 {t("section.kb")}</div>
          {data.kb.map((it) => <MemRow key={it.path} it={it} port={port} />)}
        </section>
      )}
      {data.unattributed.length > 0 && (
        <section className="mem-unattr">
          <div className="mem-sec-h warn">⚠ {t("section.unattributed")}</div>
          {data.unattributed.map((it) => <MemRow key={it.path} it={it} port={port} />)}
        </section>
      )}
      {data.unknown.length > 0 && (
        <section className="mem-unknown">
          <div className="mem-sec-h warn">? {t("section.unknown")}</div>
          {data.unknown.map((it) => <MemRow key={it.path} it={it} port={port} />)}
        </section>
      )}
    </div>
  );
}

// 點開列才呼叫 /memory/item 取全文（overview 只回摘要）
function MemRow({ it, port }: { it: MemoryItem; port: number | null }) {
  const [body, setBody] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const badge = it.source === "native" ? "b-native" : "b-kms";
  const label = it.source === "native" ? `native·${it.type || "?"}` : `KMS·${it.domain || ""}`;
  const toggle = () => {
    if (!open && body === null && port != null) {
      fetchMemoryItem(port, it.path).then((d) => setBody(d.body)).catch(() => setBody(""));
    }
    setOpen((o) => !o);
  };
  return (
    <div className="mrow" onClick={toggle}>
      <span className={`badge ${badge}`}>{label}</span>
      <div className="tx">
        <div className="tt">{it.title}</div>
        <div className="ds">{it.snippet || it.summary}</div>
        {open && <pre className="mrow-body">{body ?? "…"}</pre>}
      </div>
    </div>
  );
}

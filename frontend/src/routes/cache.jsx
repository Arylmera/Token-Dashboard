import React, { useEffect, useState } from "react";
import { D } from "../data-store.js";
import { KPI } from "../components/atoms.jsx";
import { AreaChart } from "../components/charts.jsx";
import { PageNav, SortHeader, usePaginated, useSortable } from "../components/sortable.jsx";
import { displayProject } from "../project-name.js";
import { fmtPct, fmtTokens } from "../format.js";

const pctStyle = (v, max) => ({ "--pct": Math.min(100, Math.round(((v || 0) / (max || 1)) * 100)) });

const SummaryCard = () => {
  const cs = D.cacheStats || { days: [], avg_7d: 0, avg_30d: 0, churn_7d: 0, churn_30d: 0 };
  const days = cs.days || [];
  const lastHit = days.length ? days[days.length - 1].hit_rate : 0;
  const lastChurn = days.length ? days[days.length - 1].churn_rate : 0;
  const totalRead = days.reduce((a, d) => a + (d.cache_read || 0), 0);
  const totalWrite = days.reduce((a, d) => a + (d.cache_create_5m || 0) + (d.cache_create_1h || 0), 0);
  const totalInput = days.reduce((a, d) => a + (d.input || 0), 0);
  const hitSeries = days.map((d) => d.hit_rate || 0);
  const churnSeries = days.map((d) => d.churn_rate || 0);
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Cache mix</h2>
        <span className="a-card-meta">
          last {days.length} days · hit = reuse share · churn = new-entry share
        </span>
      </div>
      <div className="a-kpi-row">
        <KPI label="hit 7d" value={fmtPct(cs.avg_7d)} />
        <KPI label="hit 30d" value={fmtPct(cs.avg_30d)} />
        <KPI label="hit today" value={fmtPct(lastHit)} />
        <KPI label="churn 7d" value={fmtPct(cs.churn_7d || 0)} />
        <KPI label="churn 30d" value={fmtPct(cs.churn_30d || 0)} />
        <KPI label="churn today" value={fmtPct(lastChurn)} />
      </div>
      <div className="a-kpi-row">
        <KPI label="cache reads · total" value={fmtTokens(totalRead)} />
        <KPI label="cache writes · total" value={fmtTokens(totalWrite)} />
        <KPI label="fresh input · total" value={fmtTokens(totalInput)} />
      </div>
      <AreaChart
        data={days.map((d) => ({ date: (d.date || "").slice(5), cost: d.hit_rate || 0 }))}
        overlaySeries={churnSeries}
        height={180}
        accent="var(--accent)"
        overlayAccent="var(--warn)"
        yMax={1}
        yTicks={[0, 0.25, 0.5, 0.75, 1]}
        yFormat={(v) => `${Math.round(v * 100)}%`}
        format={(v) => `${(v * 100).toFixed(1)}%`}
      />
      <div className="a-strip-legend">
        <span className="a-strip-legend-item">
          <span className="a-strip-legend-sw" style={{ background: "var(--accent)" }} /> hit
        </span>
        <span className="a-strip-legend-item">
          <span className="a-strip-legend-sw a-strip-legend-sw-dashed" style={{ borderColor: "var(--warn)" }} /> churn
        </span>
      </div>
    </section>
  );
};

const SessionDrilldown = ({ date }) => {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setError(null);
    fetch(`/api/cache-stats/sessions?date=${encodeURIComponent(date)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then(setRows)
      .catch((e) => setError(e.message || "fetch failed"));
  }, [date]);
  if (error) {
    return <div className="a-hint" style={{ padding: "8px 16px" }}>Failed to load: {error}</div>;
  }
  if (!rows) {
    return <div className="a-hint" style={{ padding: "8px 16px" }}>Loading…</div>;
  }
  if (rows.length === 0) {
    return <div className="a-hint" style={{ padding: "8px 16px" }}>No sessions on {date}.</div>;
  }
  return (
    <table className="a-table" style={{ marginLeft: 32, marginBottom: 8, width: "calc(100% - 32px)" }}>
      <thead><tr>
        <th>session</th>
        <th>project</th>
        <th className="num">turns</th>
        <th className="num">hit %</th>
        <th className="num">churn %</th>
        <th className="num">reads</th>
        <th className="num">writes</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => {
          const tone = r.hit_rate >= 0.9 ? "tone-good" : r.hit_rate >= 0.7 ? "tone-warn" : "tone-bad";
          return (
            <tr key={r.session_id + (r.model || "")}>
              <td className="mono">
                <a
                  className="a-link-button"
                  href={`#/sessions/${encodeURIComponent(r.session_id)}`}
                  title={`open session ${r.session_id}`}
                >
                  {r.session_id.slice(0, 8)}
                </a>
              </td>
              <td className="muted" title={r.project_slug}>{displayProject(r.project_slug)}</td>
              <td className="num">{r.turns}</td>
              <td className={`num ${tone}`}>{(r.hit_rate * 100).toFixed(1)}%</td>
              <td className="num">{(r.churn_rate * 100).toFixed(1)}%</td>
              <td className="num">{fmtTokens(r.cache_read)}</td>
              <td className="num muted">{fmtTokens(r.cache_create_5m + r.cache_create_1h)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

const DailyBreakdownTable = () => {
  const days = (D.cacheStats && D.cacheStats.days) || [];
  const rows = days.map((d) => ({
    date: d.date,
    hit: d.hit_rate || 0,
    churn: d.churn_rate || 0,
    input: d.input || 0,
    cacheRead: d.cache_read || 0,
    cacheCreate: (d.cache_create_5m || 0) + (d.cache_create_1h || 0),
  }));
  const { sorted, sortState, requestSort } = useSortable(rows, "date", "desc", {
    date: (r) => r.date,
    hit: (r) => r.hit,
    churn: (r) => r.churn,
    input: (r) => r.input,
    cacheRead: (r) => r.cacheRead,
    cacheCreate: (r) => r.cacheCreate,
  });
  const headProps = { state: sortState, requestSort };
  const { slice, ...nav } = usePaginated(sorted);
  const maxRead = Math.max(1, ...rows.map((r) => r.cacheRead));
  const [expanded, setExpanded] = useState(null);
  const toggle = (date) => setExpanded(expanded === date ? null : date);
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Daily breakdown</h2>
        <span className="a-card-meta">{rows.length} days · click a row to drill into per-session detail</span>
      </div>
      <div className="a-table-scroll">
        <table className="a-table a-sink-table">
          <thead><tr>
            <SortHeader sortKey="date" {...headProps}>date</SortHeader>
            <SortHeader sortKey="hit" className="num" {...headProps}>hit %</SortHeader>
            <SortHeader sortKey="churn" className="num" {...headProps}>churn %</SortHeader>
            <SortHeader sortKey="input" className="num" {...headProps}>fresh input</SortHeader>
            <SortHeader sortKey="cacheRead" className="num" {...headProps}>cache reads</SortHeader>
            <SortHeader sortKey="cacheCreate" className="num" {...headProps}>cache writes</SortHeader>
          </tr></thead>
          <tbody>
            {slice.map((r) => {
              const hitTone = r.hit >= 0.9 ? "tone-good" : r.hit >= 0.7 ? "tone-warn" : "tone-bad";
              const isOpen = expanded === r.date;
              return (
                <React.Fragment key={r.date}>
                  <tr
                    className="has-bar clickable"
                    style={pctStyle(r.cacheRead, maxRead)}
                    onClick={() => toggle(r.date)}
                  >
                    <td className="mono">{isOpen ? "▼" : "▶"} {r.date}</td>
                    <td className={`num ${hitTone}`}>{(r.hit * 100).toFixed(1)}%</td>
                    <td className="num">{(r.churn * 100).toFixed(1)}%</td>
                    <td className="num muted">{fmtTokens(r.input)}</td>
                    <td className="num">{fmtTokens(r.cacheRead)}</td>
                    <td className="num muted">{fmtTokens(r.cacheCreate)}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan="6" style={{ padding: 0 }}>
                        <SessionDrilldown date={r.date} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        <PageNav {...nav} />
      </div>
    </section>
  );
};

export const Cache = () => (
  <div className="a-route">
    <SummaryCard />
    <DailyBreakdownTable />
  </div>
);

import React from "react";
import { D } from "../data-store.js";
import { KPI } from "../components/atoms.jsx";
import { SortHeader, useSortable } from "../components/sortable.jsx";
import { fmtPct, fmtTokens } from "../format.js";

const pctStyle = (v, max) => ({ "--pct": Math.min(100, Math.round(((v || 0) / (max || 1)) * 100)) });

const CacheMixChart = ({ hit, churn }) => {
  const W = 800;
  const H = 160;
  const PAD_L = 42;
  const PAD_R = 16;
  const PAD_T = 8;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  if (!hit || hit.length === 0) {
    return <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="a-cache-mix-chart" />;
  }
  const n = hit.length;
  const step = n > 1 ? innerW / (n - 1) : innerW;
  const yOf = (v) => PAD_T + innerH - Math.max(0, Math.min(1, v)) * innerH;
  const xOf = (i) => PAD_L + i * step;
  const lineFor = (series) =>
    series.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`).join(" ");
  const areaFor = (series) =>
    `M${xOf(0).toFixed(2)},${(PAD_T + innerH).toFixed(2)} ` +
    series.map((v, i) => `L${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`).join(" ") +
    ` L${xOf(n - 1).toFixed(2)},${(PAD_T + innerH).toFixed(2)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const last = hit[n - 1];
  const gid = `a-cache-fullpage-${Math.random().toString(36).slice(2, 7)}`;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="a-cache-mix-chart">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yOf(t)} y2={yOf(t)} stroke="var(--iron-border)" strokeWidth="0.5" opacity="0.5" />
          <text x={PAD_L - 6} y={yOf(t) + 3} textAnchor="end" fill="var(--gull)" fontSize="10">{Math.round(t * 100)}%</text>
        </g>
      ))}
      <path d={areaFor(hit)} fill={`url(#${gid})`} />
      <path d={lineFor(hit)} fill="none" stroke="var(--accent)" strokeWidth="1.4" />
      {churn && churn.length > 0 && (
        <path d={lineFor(churn)} fill="none" stroke="var(--warn)" strokeWidth="1.1" strokeDasharray="3 2" opacity="0.9" />
      )}
      <circle cx={xOf(n - 1)} cy={yOf(last)} r="2.6" fill="var(--accent)" />
    </svg>
  );
};

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
      <CacheMixChart hit={hitSeries} churn={churnSeries} />
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
  const maxRead = Math.max(1, ...rows.map((r) => r.cacheRead));
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Daily breakdown</h2>
        <span className="a-card-meta">{rows.length} days</span>
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
            {sorted.map((r) => {
              const hitTone = r.hit >= 0.9 ? "tone-good" : r.hit >= 0.7 ? "tone-warn" : "tone-bad";
              return (
                <tr key={r.date} className="has-bar" style={pctStyle(r.cacheRead, maxRead)}>
                  <td className="mono">{r.date}</td>
                  <td className={`num ${hitTone}`}>{(r.hit * 100).toFixed(1)}%</td>
                  <td className="num">{(r.churn * 100).toFixed(1)}%</td>
                  <td className="num muted">{fmtTokens(r.input)}</td>
                  <td className="num">{fmtTokens(r.cacheRead)}</td>
                  <td className="num muted">{fmtTokens(r.cacheCreate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

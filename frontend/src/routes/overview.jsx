import React from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtNum, fmtPct, fmtTokens } from "../format.js";
import { HBar, KPI, ModelBadge } from "../components/atoms.jsx";
import { AreaChart, Donut, StripSpark } from "../components/charts.jsx";

const rangeDaysFromKey = (key) => {
  const k = String(key || "").toLowerCase();
  if (k === "today" || k === "yesterday") return 1;
  const m = k.match(/^(\d+)\s*d/);
  if (m) return parseInt(m[1], 10);
  return 30;
};

const KpiRow = ({ totals }) => {
  const t = totals;
  const windows = [
    {
      key: "range",
      days: rangeDaysFromKey(t.rangeKey),
      label: t.rangeLabel || "range",
      value: fmtCost(t.range || 0),
      sub: `${fmtTokens(t.rangeTokens)} tok · ${t.rangeSessions || 0} sessions`,
    },
    {
      key: "week",
      days: 7,
      label: "7 days",
      value: fmtCost(t.week),
      sub: `${fmtTokens(t.weekTokens)} tok · avg ${fmtCost(t.week / 7)}/day`,
    },
    {
      key: "all",
      days: Infinity,
      label: "all-time",
      value: fmtCost(t.cost),
      sub: `${fmtTokens(t.allTokens)} tok · ${fmtNum(t.turns)} turns`,
    },
  ].sort((a, b) => a.days - b.days);
  return (
    <section className="a-kpi-row">
      {windows.map((w) => <KPI key={w.key} label={w.label} value={w.value} sub={w.sub} />)}
      <KPI label="input" value={fmtTokens(t.inputTokens)} sub="tokens" />
      <KPI label="output" value={fmtTokens(t.outputTokens)} sub="tokens" />
      <KPI label="cache hit" value={fmtPct(t.cacheHitRate)} sub="last 7 days" />
    </section>
  );
};

const ChartAxis = ({ data }) => {
  if (!data || data.length === 0) return null;
  return (
    <div className="a-chart-axis">
      <span>{data[0].date}</span>
      <span>{data[Math.floor(data.length / 2)].date}</span>
      <span>{data[data.length - 1].date}</span>
    </div>
  );
};

const TopStrip = ({ totals, burn }) => (
  <section className="a-strip">
    <div className="a-strip-left">
      <div className="a-label">today · live</div>
      <div className="a-strip-num">{fmtCost(totals.today)}</div>
      <div className="a-strip-sub">
        {fmtTokens(totals.todayTokens)} tok · vs {fmtCost(totals.yesterday)} yesterday · {totals.rangeSessions || 0} sessions·{totals.rangeKey || "30d"}
      </div>
    </div>
    <div className="a-strip-mid">
      <StripSpark data={D.hourly} accent="var(--accent)" height={38} />
      <div className="a-strip-axis">
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>now</span>
      </div>
    </div>
    <div className="a-strip-right">
      <div className="a-label">burn rate</div>
      <div className="a-strip-num">${burn.rate.toFixed(2)}<span className="a-strip-unit">/hr</span></div>
      <div className="a-gauge">
        <div className="a-gauge-track">
          <div className="a-gauge-fill" style={{ width: `${Math.min(burn.multiple / 6, 1) * 100}%` }} />
          <div className="a-gauge-marker" style={{ left: `${(1 / 6) * 100}%` }} title="weekly avg" />
        </div>
        <div className="a-gauge-axis"><span>0×</span><span>1× avg</span><span>6×</span></div>
      </div>
      <div className="a-strip-sub tone-good">▲ {burn.multiple.toFixed(1)}× weekly avg</div>
    </div>
  </section>
);

const DailyCharts = ({ totals }) => (
  <section className="a-card-row">
    <div className="a-card">
      <div className="a-card-head">
        <h2>Daily cost</h2>
        <span className="a-card-meta">last {totals.rangeLabel || "30 days"} · {fmtCost((D.daily || []).reduce((a, b) => a + b.cost, 0))} total</span>
      </div>
      <AreaChart data={D.daily} height={200} accent="var(--accent)" annotate={true} />
      <ChartAxis data={D.daily} />
    </div>
    <div className="a-card">
      <div className="a-card-head">
        <h2>Cache reads</h2>
        <span className="a-card-meta">{fmtPct(totals.cacheHitRate)} hit rate</span>
      </div>
      <AreaChart data={(D.daily || []).map((d) => ({ cost: d.cacheRead / 1000, date: d.date }))} height={200} accent="var(--gull)" />
      <ChartAxis data={D.daily} />
    </div>
  </section>
);

const MODEL_COLORS = ["var(--bone)", "var(--accent)", "var(--gull)"];
const colorFor = (i) => MODEL_COLORS[i] || "var(--gull)";

const ProjectsTable = ({ totals }) => (
  <div className="a-card">
    <div className="a-card-head"><h2>Tokens by project</h2></div>
    <table className="a-table">
      <thead><tr><th>project</th><th className="num">cost</th><th className="num">tokens</th><th className="num">share</th></tr></thead>
      <tbody>
        {(D.projects || []).slice(0, 7).map((p) => (
          <tr key={p.slug}>
            <td className="mono">{p.name}</td>
            <td className="num tone-good">{fmtCost(p.cost)}</td>
            <td className="num">{fmtTokens(p.tokens)}</td>
            <td className="num">
              <div className="a-bar-cell">
                <HBar value={p.cost} max={D.projects[0].cost} />
                <span>{((p.cost / (totals.cost || 1)) * 100).toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const ModelsAndTools = () => (
  <div className="a-card">
    <div className="a-card-head"><h2>By model</h2></div>
    <div className="a-model-block">
      <Donut size={130} thickness={14} segments={(D.models || []).slice(0, 3).map((m, i) => ({
        value: m.share,
        color: colorFor(i),
      }))} />
      <div className="a-model-stack">
        {(D.models || []).map((m, i) => (
          <div key={m.name} className="a-model-legend">
            <span className="a-model-swatch" style={{ background: colorFor(i) }} />
            <span className="a-model-name">{m.short}</span>
            <span className="a-model-pct">{fmtPct(m.share)}</span>
            <span className="a-model-cost">{fmtCost(m.cost)}</span>
          </div>
        ))}
      </div>
    </div>
    <div className="a-card-divider" />
    <div className="a-card-head" style={{ marginTop: 4 }}><h2>Top tools</h2></div>
    <table className="a-table">
      <thead><tr><th>tool</th><th className="num">calls</th><th className="num">tokens</th></tr></thead>
      <tbody>
        {(D.tools || []).slice(0, 5).map((tool) => (
          <tr key={tool.name}>
            <td className="mono">{tool.name}</td>
            <td className="num">{fmtNum(tool.calls)}</td>
            <td className="num">{fmtTokens(tool.tokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const RecentSessions = () => (
  <section className="a-card">
    <div className="a-card-head">
      <h2>Recent sessions</h2>
      <span className="a-card-meta">click a row to drill in</span>
    </div>
    <table className="a-table">
      <thead>
        <tr><th>session</th><th>project</th><th>started</th><th>model</th><th className="num">turns</th><th className="num">tokens</th><th className="num">cost</th></tr>
      </thead>
      <tbody>
        {(D.sessions || []).map((s) => (
          <tr key={s.id} className="clickable">
            <td className="mono">{s.id}</td>
            <td className="mono">{s.project}</td>
            <td>{s.started}</td>
            <td><ModelBadge model={s.model} /></td>
            <td className="num">{s.turns}</td>
            <td className="num">{fmtTokens(s.tokens)}</td>
            <td className="num tone-good">{fmtCost(s.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);

export const Overview = () => {
  const totals = D.totals;
  const burn = D.burn;
  return (
    <div className="a-route">
      <TopStrip totals={totals} burn={burn} />
      <KpiRow totals={totals} />
      <DailyCharts totals={totals} />
      <section className="a-card-row">
        <ProjectsTable totals={totals} />
        <ModelsAndTools />
      </section>
      <RecentSessions />
    </div>
  );
};

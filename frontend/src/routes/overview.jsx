import React from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtCostWhole, fmtNum, fmtPct, fmtTokens } from "../format.js";
import { HBar, KPI, ModelBadge } from "../components/atoms.jsx";
import { AreaChart, Donut, DualAreaChart, StripSpark } from "../components/charts.jsx";

const rangeDaysFromKey = (key) => {
  const k = String(key || "").toLowerCase();
  if (k === "all" || k === "alltime" || k === "all-time") return Infinity;
  if (k === "today" || k === "yesterday") return 1;
  const m = k.match(/^(\d+)\s*d/);
  if (m) return parseInt(m[1], 10);
  return 30;
};

const sparkOf = (daily, days, pick) => {
  const fn = pick || ((d) => Number(d.cost) || 0);
  const arr = (daily || []).map(fn);
  if (!arr.length) return null;
  const slice = Number.isFinite(days) ? arr.slice(-days) : arr;
  if (slice.length < 2) return null;
  return slice;
};

const KpiSpark = ({ daily, days, pick, accent }) => {
  const data = sparkOf(daily, days, pick);
  if (!data) return null;
  return (
    <div className="a-kpi-spark">
      <StripSpark data={data} height={22} accent={accent || "var(--accent)"} />
    </div>
  );
};

const cacheHitOf = (d) => {
  const reads = Number(d.cacheRead) || 0;
  const billed = (Number(d.input) || 0) + (Number(d.output) || 0);
  const total = reads + billed;
  return total > 0 ? reads / total : 0;
};

const KpiRow = ({ totals }) => {
  const t = totals;
  const daily = D.daily || [];
  const rangeDays = rangeDaysFromKey(t.rangeKey);
  const windows = [
    {
      key: "range",
      days: rangeDays,
      label: t.rangeLabel || "range",
      value: fmtCostWhole(t.range || 0),
      sub: `${fmtTokens(t.rangeTokens)} tok · ${t.rangeSessions || 0} sessions`,
      sparkDays: rangeDays,
    },
    {
      key: "week",
      days: 7,
      label: "7 days",
      value: fmtCostWhole(t.week),
      sub: `${fmtTokens(t.weekTokens)} tok · avg ${fmtCost(t.week / 7)}/day`,
      sparkDays: 7,
    },
    {
      key: "all",
      days: Infinity,
      label: "all-time",
      value: fmtCostWhole(t.cost),
      sub: `${fmtTokens(t.allTokens)} tok · ${fmtNum(t.turns)} turns`,
      sparkDays: Infinity,
    },
  ].sort((a, b) => a.days - b.days);
  return (
    <section className="a-kpi-row">
      {windows.map((w) => (
        <KPI
          key={w.key}
          label={w.label}
          value={w.value}
          sub={w.sub}
          spark={<KpiSpark daily={daily} days={w.sparkDays} />}
        />
      ))}
      <KPI
        label="input"
        value={fmtTokens(t.inputTokens)}
        sub={`tokens · ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={daily} days={rangeDays} pick={(d) => Number(d.input) || 0} />}
      />
      <KPI
        label="output"
        value={fmtTokens(t.outputTokens)}
        sub={`tokens · ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={daily} days={rangeDays} pick={(d) => Number(d.output) || 0} />}
      />
      <KPI
        label="cache hit"
        value={fmtPct(t.cacheHitRate)}
        sub={`last ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={daily} days={rangeDays} pick={cacheHitOf} />}
      />
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

const toneFor = (pctUsed) => {
  if (pctUsed == null) return "";
  if (pctUsed >= 0.9) return "tone-bad";
  if (pctUsed >= 0.7) return "tone-warn";
  return "tone-good";
};

const fmtResetIn = (resetsAt) => {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `resets in ${h}h` : `resets in ${h}h ${m}m`;
};

const LimitWindow = ({ label, sub, win, plan }) => {
  if (!win || win.cap == null) {
    const hint = plan === "api"
      ? "no cap on API plan"
      : `no cap configured for "${plan}" — pick a Claude plan in Settings`;
    return (
      <div className="a-limit">
        <div className="a-label">{label}</div>
        <div className="a-limit-num">—</div>
        <div className="a-strip-sub">{sub} · {hint}</div>
      </div>
    );
  }
  const pctRem = (win.pct_remaining || 0) * 100;
  const pctUsed = (win.pct_used || 0) * 100;
  const tone = toneFor(win.pct_used);
  const resetIn = fmtResetIn(win.resets_at);
  const idle = "anchor" in win && win.anchor == null;
  const calBadge = win.calibrated ? " · calibrated" : "";
  const subText = idle
    ? `${sub} · idle — no active session`
    : resetIn
      ? `${fmtTokens(win.used)} / ${fmtTokens(win.cap)} tok · ${resetIn}${calBadge}`
      : `${fmtTokens(win.used)} / ${fmtTokens(win.cap)} tok · ${sub}${calBadge}`;
  return (
    <div className="a-limit">
      <div className="a-label">{label}</div>
      <div className={`a-limit-num ${tone}`}>≈{pctRem.toFixed(0)}%<span className="a-strip-unit">left</span></div>
      <div className="a-gauge">
        <div className="a-gauge-track">
          <div className={`a-gauge-fill ${tone}`} style={{ width: `${Math.min(pctUsed, 100)}%` }} />
        </div>
      </div>
      <div className="a-strip-sub">{subText}</div>
    </div>
  );
};

const BUDGET_LABEL = { daily: "today", weekly: "this week", monthly: "this month" };

const BudgetBanner = ({ budget }) => {
  if (!budget) return null;
  const flagged = ["monthly", "weekly", "daily"]
    .map((k) => ({ key: k, ...(budget[k] || {}) }))
    .filter((w) => w.cap_usd != null && (w.status === "warn" || w.status === "over"));
  if (flagged.length === 0) return null;
  return (
    <section className="a-card" style={{ marginBottom: 12 }}>
      <div className="a-card-head">
        <h2>Budget alert</h2>
        <span className="a-card-meta">{flagged.length} window{flagged.length === 1 ? "" : "s"} flagged</span>
      </div>
      <div className="a-budget-banner-list">
        {flagged.map((w) => {
          const tone = w.status === "over" ? "tone-bad" : "tone-warn";
          const verb = w.status === "over" ? "over" : "trending over";
          return (
            <div key={w.key} className="a-budget-banner-row">
              <div className={`a-budget-banner-amt ${tone}`}>
                {fmtCost(w.used_usd)}<span className="a-strip-unit"> / {fmtCost(w.cap_usd)} {BUDGET_LABEL[w.key]}</span>
              </div>
              <div className="a-strip-sub">
                {verb} cap · projected {fmtCost(w.projected_usd)} by end of period
                · set caps in Settings
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const PHASE_COLORS = {
  plan:    "var(--gull)",
  execute: "var(--accent)",
  other:   "var(--iron-border-2)",
};

const PhaseSplitCard = ({ phase }) => {
  if (!phase) return null;
  const total = (phase.plan?.billable_tokens || 0)
    + (phase.execute?.billable_tokens || 0)
    + (phase.other?.billable_tokens || 0);
  if (total === 0) return null;
  const seg = (k) => ({
    key: k,
    label: k,
    tokens: phase[k]?.billable_tokens || 0,
    cost: phase[k]?.cost_usd || 0,
    turns: phase[k]?.turns || 0,
    share: (phase[k]?.billable_tokens || 0) / total,
  });
  const segs = ["plan", "execute", "other"].map(seg);
  const planExec = (segs[0].tokens && segs[1].tokens)
    ? (segs[1].tokens / segs[0].tokens).toFixed(2)
    : null;
  return (
    <div className="a-card">
      <div className="a-card-head">
        <h2>Plan vs execute</h2>
        <span className="a-card-meta">
          billable tokens by phase{planExec ? ` · 1 : ${planExec} ratio` : ""}
        </span>
      </div>
      <div className="a-split-wrap">
        <div className="a-split-bar" role="img" aria-label="phase split">
          {segs.map((s) => (
            <div
              key={s.key}
              className={`a-split-seg a-split-seg-${s.key}`}
              style={{ flex: s.share || 0.0001, background: PHASE_COLORS[s.key] }}
              title={`${s.label} · ${fmtPct(s.share)}`}
            >
              {s.share >= 0.06 ? fmtPct(s.share) : ""}
            </div>
          ))}
        </div>
        <div className="a-split-meta">
          {segs.map((s) => (
            <div key={s.key} className="a-split-meta-cell">
              <div className={`a-split-meta-k a-split-meta-k-${s.key}`}>
                <span className="a-split-meta-sw" style={{ background: PHASE_COLORS[s.key] }} />
                {s.label}
              </div>
              <div className="a-split-meta-v">{fmtTokens(s.tokens)}</div>
              <div className="a-split-meta-s">{fmtCost(s.cost)} · {fmtNum(s.turns)} turns</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const LimitsCard = ({ limits, enabled }) => {
  if (enabled === false) return null;
  if (!limits || limits.plan === "api") return null;
  const meta = limits.meta || {};
  const verifiedSuffix = meta.last_verified ? ` · verified ${meta.last_verified}` : "";
  const bothCalibrated = limits.five_hour?.calibrated && limits.weekly?.calibrated;
  const anyCalibrated = limits.five_hour?.calibrated || limits.weekly?.calibrated;
  const defaultNote = bothCalibrated
    ? "Caps calibrated from your Anthropic statusbar. Re-calibrate in Settings if your plan changes."
    : anyCalibrated
      ? "One window is calibrated; the other uses a rough community estimate. Calibrate the rest in Settings."
      : "Anthropic doesn't publish exact token caps; defaults are rough community estimates. Calibrate from your statusbar in Settings.";
  const note = meta.source_note || defaultNote;
  return (
    <section className="a-card a-limits">
      <div className="a-card-head">
        <h2>Plan limits remaining</h2>
        <span className="a-card-meta">{limits.plan} plan · sonnet-equiv tokens{verifiedSuffix}</span>
      </div>
      <div className="a-limits-grid">
        <LimitWindow label="5h session" sub="anchored" win={limits.five_hour} plan={limits.plan} />
        <LimitWindow label="weekly window" sub="last 7 days" win={limits.weekly} plan={limits.plan} />
      </div>
      <div className="a-limits-note">⚠ {note}</div>
    </section>
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
    <div className="a-card" style={{ gridColumn: "1 / -1" }}>
      <div className="a-card-head">
        <h2>Cache &times; cost</h2>
        <div className="a-chart-legend">
          <span className="a-chart-legend-item"><span className="a-chart-legend-sw" style={{ background: "var(--accent)" }} /> cache reads · tokens</span>
          <span className="a-chart-legend-item"><span className="a-chart-legend-sw a-chart-legend-sw-dashed" /> cost · USD</span>
          <span className="a-card-meta" style={{ marginLeft: 8 }}>last {totals.rangeLabel || "30 days"} · {fmtCost((D.daily || []).reduce((a, b) => a + b.cost, 0))} total · {fmtPct(totals.cacheHitRate)} hit</span>
        </div>
      </div>
      <DualAreaChart data={D.daily} height={220} accent="var(--accent)" />
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

const ModelsCard = () => (
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
  </div>
);

const TopToolsCard = () => (
  <div className="a-card">
    <div className="a-card-head">
      <h2>Top tools</h2>
      <span className="a-card-meta">most-used tools by call count</span>
    </div>
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

const RecentSessions = () => {
  const sessions = D.sessions || [];
  const scroll = sessions.length > 20;
  const table = (
    <table className="a-table a-sticky-head">
      <thead>
        <tr><th>session</th><th>project</th><th>started</th><th>model</th><th className="num">turns</th><th className="num">tokens</th><th className="num">cost</th></tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id} className="clickable" onClick={() => { window.location.hash = `/sessions/${encodeURIComponent(s.id)}`; }}>
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
  );
  return (
    <section className="a-card a-recent-sessions">
      <div className="a-card-head">
        <h2>Recent sessions</h2>
        <span className="a-card-meta">
          {scroll ? `${sessions.length} sessions · scroll for more` : "click a row to drill in"}
        </span>
      </div>
      {scroll ? <div className="a-recent-scroll">{table}</div> : table}
    </section>
  );
};

export const Overview = () => {
  const totals = D.totals;
  const burn = D.burn;
  return (
    <div className="a-route">
      <TopStrip totals={totals} burn={burn} />
      <BudgetBanner budget={D.budget} />
      <LimitsCard limits={D.limits} enabled={!!(D.prefs && D.prefs.limits_enabled)} />
      <KpiRow totals={totals} />
      <DailyCharts totals={totals} />
      <section className="a-card-row">
        <ProjectsTable totals={totals} />
        <ModelsCard />
      </section>
      <section className="a-card-row">
        <PhaseSplitCard phase={D.phase} />
        <TopToolsCard />
      </section>
      <RecentSessions />
    </div>
  );
};

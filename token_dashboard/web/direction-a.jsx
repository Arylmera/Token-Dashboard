// Direction A — "Quiet Telemetry Bench"
// Refined version of the original DESIGN.md system: dense, instrument-grade,
// 13px body, mono numerics, label tier uppercase, flat surfaces with 1px borders.
// All 6 tabs functional, hash-router, sparkline + bar charts in pure SVG.

(function() {
const { useState, useEffect, useMemo } = React;

// MOCK_DATA may be populated AFTER this IIFE runs (data.js fetches asynchronously),
// so D must read live from window each access — Proxy handles that.
const D = new Proxy({}, { get: (_, k) => (window.MOCK_DATA || {})[k] });

// -------- formatters --------
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;
const fmtNum = (n) => (n || 0).toLocaleString("en-US");
const fmtTokens = (n) => {
  n = n || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
};
const fmtPct = (n) => ((n || 0) * 100).toFixed(1) + "%";

// -------- shared atoms --------
const Label = ({ children, style }) => (
  <div className="a-label" style={style}>{children}</div>
);

const KPI = ({ label, value, sub, tone, delta }) => (
  <div className="a-kpi">
    <Label>{label}</Label>
    <div className={`a-metric ${tone === "good" ? "tone-good" : ""}`}>{value}</div>
    {sub && <div className="a-kpi-sub">{sub}</div>}
    {delta != null && (
      <div className={`a-delta ${delta >= 0 ? "tone-good" : "tone-bad"}`}>
        {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}%
      </div>
    )}
  </div>
);

const ModelBadge = ({ model }) => {
  const m = (model || "").toLowerCase();
  const cls = m.includes("opus") ? "badge-opus"
    : m.includes("sonnet") ? "badge-sonnet"
    : "badge-haiku";
  return <span className={`a-badge ${cls}`}>{model || "—"}</span>;
};

// Area chart — hatched fill + optional peak/trough annotations
const AreaChart = ({ data, height = 200, accent = "var(--accent)", annotate = false, format = (v) => `$${v.toFixed(2)}` }) => {
  if (!data || data.length === 0) return <div className="a-chart-wrap" style={{ height }}><div className="a-chart" style={{ height }} /></div>;
  const max = Math.max(...data.map((d) => d.cost)) || 1;
  const w = 100;
  const topPad = 22;
  const botPad = 14;
  const yOf = (v) => height - (v / max) * (height - topPad - botPad) - botPad;
  const points = data.map((d, i) => `${(i / Math.max(1, data.length - 1)) * w},${yOf(d.cost)}`);
  const area = `M0,${height - botPad} L${points.join(" L")} L${w},${height - botPad} Z`;
  const line = `M${points.join(" L")}`;
  const peakIdx = data.reduce((mi, d, i) => (d.cost > data[mi].cost ? i : mi), 0);
  const troughIdx = data.reduce((mi, d, i) => (d.cost < data[mi].cost ? i : mi), 0);
  const ptAt = (i) => {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = yOf(data[i].cost);
    return { x, y, xPct: (x / w) * 100, yPct: (y / height) * 100 };
  };
  const gradId = `a-area-grad-${Math.random().toString(36).slice(2, 7)}`;
  const hatchId = `a-area-hatch-${Math.random().toString(36).slice(2, 7)}`;
  return (
    <div className="a-chart-wrap" style={{ position: "relative", height }}>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="a-chart" style={{ height: "100%" }}>
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.22" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
          <pattern id={hatchId} width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="2" stroke={accent} strokeWidth="0.4" opacity="0.35" />
          </pattern>
        </defs>
        <path d={area} fill={`url(#${gradId})`} />
        <path d={area} fill={`url(#${hatchId})`} />
        <path d={line} fill="none" stroke={accent} strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        {annotate && data.length > 2 && [peakIdx, troughIdx].map((i, k) => {
          const p = ptAt(i);
          const above = k === 0;
          return (
            <g key={k}>
              <circle cx={p.x} cy={p.y} r="1.2" fill={accent} />
              <line x1={p.x} y1={p.y} x2={p.x} y2={above ? p.y - 6 : p.y + 6} stroke={accent} strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      {annotate && data.length > 2 && [peakIdx, troughIdx].map((i, k) => {
        const p = ptAt(i);
        const above = k === 0;
        const tx = p.xPct > 80 ? "translate(-100%, 0)" : p.xPct < 20 ? "translate(0, 0)" : "translate(-50%, 0)";
        return (
          <div key={k} className="a-chart-annot" style={{
            position: "absolute",
            left: `${p.xPct}%`,
            top: above ? `calc(${p.yPct}% - 16px)` : `calc(${p.yPct}% + 8px)`,
            transform: tx,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            font: '500 10px "JetBrains Mono"',
            color: "var(--gull)",
          }}>
            {data[i].date} · {format(data[i].cost)}
          </div>
        );
      })}
    </div>
  );
};

// Sparkline with cursor — for the 24h "today strip"
const StripSpark = ({ data, accent = "var(--accent)", height = 38 }) => {
  if (!data || data.length === 0) return <div className="a-strip-spark" />;
  const max = Math.max(...data) || 1;
  const range = max || 1;
  const w = 100;
  const denom = Math.max(1, data.length - 1);
  const points = data.map((v, i) => `${(i / denom) * w},${height - (v / range) * (height - 8) - 4}`);
  const area = `M0,${height - 4} L${points.join(" L")} L${w},${height - 4} Z`;
  const line = `M${points.join(" L")}`;
  const cursorX = w;
  const cursorY = height - (data[data.length - 1] / range) * (height - 8) - 4;
  const gid = `a-strip-grad-${Math.random().toString(36).slice(2, 7)}`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="a-strip-spark">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.3" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={accent} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
      <line x1={cursorX} y1="0" x2={cursorX} y2={height} stroke={accent} strokeWidth="0.4" opacity="0.6" />
      <circle cx={cursorX} cy={cursorY} r="1.4" fill={accent}>
        <animate attributeName="r" values="1.4;2.4;1.4" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
};

const Donut = ({ segments, size = 130, thickness = 14 }) => {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="a-donut">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--iron-border)" strokeWidth={thickness} />
      {segments.map((s, i) => {
        const dash = c * s.value;
        const offset = c * (1 - acc);
        acc += s.value;
        return (
          <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={s.color} strokeWidth={thickness}
            strokeDasharray={`${dash} ${c - dash}`}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        );
      })}
    </svg>
  );
};

const HBar = ({ value, max, accent = "var(--accent)" }) => (
  <div className="a-hbar">
    <div className="a-hbar-fill" style={{ width: `${(value / (max || 1)) * 100}%`, background: accent }} />
  </div>
);

// -------- topbar --------
const Topbar = ({ tab, setTab, range, setRange, onRefresh, themeLabel, onCycleTheme }) => (
  <header className="a-topbar">
    <div className="a-brand">
      <span className="a-brand-dot" />
      <span className="a-brand-text">token-dashboard</span>
      <span className="a-brand-sub">v0.4.2</span>
    </div>
    <nav className="a-nav">
      {["overview", "prompts", "sessions", "token sink", "tips", "settings"].map((t) => (
        <button
          key={t}
          className={`a-navlink ${tab === t ? "is-active" : ""}`}
          onClick={() => setTab(t)}
        >
          {t}
        </button>
      ))}
    </nav>
    <div className="a-topbar-actions">
      <div className="a-range">
        {["7d", "30d", "90d", "all"].map((r) => (
          <button
            key={r}
            className={`a-range-tab ${range === r ? "is-active" : ""}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>
      <button className="a-pill-btn" title="Cycle theme" onClick={onCycleTheme}>
        <span style={{ marginRight: 6 }}>◐</span>{themeLabel}
      </button>
      <button className="a-pill-btn" title="Refresh" onClick={onRefresh}>
        <span style={{ marginRight: 6 }}>↻</span>refresh
      </button>
    </div>
  </header>
);

// -------- Overview --------
const Overview = () => {
  const t = D.totals;
  const burn = D.burn;
  return (
    <div className="a-route">
      <section className="a-strip">
        <div className="a-strip-left">
          <div className="a-label">today · live</div>
          <div className="a-strip-num">{fmtCost(t.today)}</div>
          <div className="a-strip-sub">vs {fmtCost(t.yesterday)} yesterday · {t.sessions} sessions·30d</div>
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

      <section className="a-kpi-row" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
        <KPI label="7 days" value={fmtCost(t.week)} sub={`avg ${fmtCost(t.week / 7)}/day`} />
        <KPI label="30 days" value={fmtCost(t.month)} sub={`${t.sessions} sessions`} />
        <KPI label="all-time" value={fmtCost(t.cost)} sub={`${fmtNum(t.turns)} turns`} />
        <KPI label="input" value={fmtTokens(t.inputTokens)} sub="tokens" />
        <KPI label="output" value={fmtTokens(t.outputTokens)} sub="tokens" />
        <KPI label="cache hit" value={fmtPct(t.cacheHitRate)} sub="last 7 days" />
      </section>

      <section className="a-card-row">
        <div className="a-card">
          <div className="a-card-head">
            <h2>Daily cost</h2>
            <span className="a-card-meta">last 30 days · {fmtCost((D.daily || []).reduce((a, b) => a + b.cost, 0))} total</span>
          </div>
          <AreaChart data={D.daily} height={200} accent="var(--accent)" annotate={true} />
          {D.daily && D.daily.length > 0 && (
            <div className="a-chart-axis">
              <span>{D.daily[0].date}</span>
              <span>{D.daily[Math.floor(D.daily.length / 2)].date}</span>
              <span>{D.daily[D.daily.length - 1].date}</span>
            </div>
          )}
        </div>
        <div className="a-card">
          <div className="a-card-head">
            <h2>Cache reads</h2>
            <span className="a-card-meta">{fmtPct(t.cacheHitRate)} hit rate</span>
          </div>
          <AreaChart data={(D.daily || []).map((d) => ({ cost: d.cacheRead / 1000, date: d.date }))} height={200} accent="var(--gull)" />
          {D.daily && D.daily.length > 0 && (
            <div className="a-chart-axis">
              <span>{D.daily[0].date}</span>
              <span>{D.daily[Math.floor(D.daily.length / 2)].date}</span>
              <span>{D.daily[D.daily.length - 1].date}</span>
            </div>
          )}
        </div>
      </section>

      <section className="a-card-row">
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
                      <span>{((p.cost / (t.cost || 1)) * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="a-card">
          <div className="a-card-head"><h2>By model</h2></div>
          <div className="a-model-block">
            <Donut size={130} thickness={14} segments={(D.models || []).slice(0, 3).map((m, i) => ({
              value: m.share,
              color: i === 0 ? "var(--bone)" : i === 1 ? "var(--accent)" : "var(--gull)",
            }))} />
            <div className="a-model-stack">
              {(D.models || []).map((m, i) => {
                const c = i === 0 ? "var(--bone)" : i === 1 ? "var(--accent)" : "var(--gull)";
                return (
                  <div key={m.name} className="a-model-legend">
                    <span className="a-model-swatch" style={{ background: c }} />
                    <span className="a-model-name">{m.short}</span>
                    <span className="a-model-pct">{fmtPct(m.share)}</span>
                    <span className="a-model-cost">{fmtCost(m.cost)}</span>
                  </div>
                );
              })}
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
      </section>

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
    </div>
  );
};

// -------- Prompts --------
const Prompts = () => {
  const [openId, setOpenId] = useState(null);
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head">
          <h2>Most expensive prompts</h2>
          <span className="a-card-meta">ranked by tokens · click to expand</span>
        </div>
        <table className="a-table">
          <thead>
            <tr><th>preview</th><th>project</th><th>session</th><th>model</th><th className="num">tokens</th><th className="num">cost</th><th>when</th></tr>
          </thead>
          <tbody>
            {(D.prompts || []).map((p) => (
              <React.Fragment key={p.id}>
                <tr className="clickable" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                  <td style={{ maxWidth: 380, color: "var(--bone)" }}>
                    <span style={{ marginRight: 6, color: "var(--gull)" }}>{openId === p.id ? "▾" : "▸"}</span>
                    {p.preview}
                  </td>
                  <td className="mono">{p.project}</td>
                  <td className="mono">{p.session}</td>
                  <td><ModelBadge model={p.model} /></td>
                  <td className="num">{fmtTokens(p.tokens)}</td>
                  <td className="num tone-good">{fmtCost(p.cost)}</td>
                  <td>{p.time}</td>
                </tr>
                {openId === p.id && (
                  <tr className="a-drawer-row">
                    <td colSpan={7}>
                      <div className="a-drawer">
                        <div className="a-drawer-head"><Label>prompt · {fmtTokens(p.tokens)} tokens</Label></div>
                        <pre className="a-pre">{p.preview}</pre>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
};

// -------- Sessions --------
const Heatmap = () => {
  const rows = D.heatmap || [];
  const max = Math.max(1, ...rows.flatMap((r) => r.cells));
  return (
    <div className="a-heatmap">
      <div className="a-heatmap-axis-x">
        <span></span>
        {Array.from({ length: 24 }).map((_, h) => (
          <span key={h} className="a-heatmap-hour">{h % 6 === 0 ? `${h.toString().padStart(2,"0")}:00` : ""}</span>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.day} className="a-heatmap-row">
          <span className="a-heatmap-day">{row.day}</span>
          {row.cells.map((v, h) => (
            <div key={h} className="a-heatmap-cell" title={`${row.day} ${h}:00 — ${v} turns`}
              style={{ background: v === 0 ? "var(--panel-2)" : `color-mix(in oklab, var(--accent) ${Math.round((v / max) * 100)}%, transparent)` }} />
          ))}
        </div>
      ))}
      <div className="a-heatmap-legend">
        <span className="a-label">activity</span>
        <span className="a-heatmap-scale">
          {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
            <span key={i} style={{ background: v === 0 ? "var(--panel-2)" : `color-mix(in oklab, var(--accent) ${v * 100}%, transparent)` }} />
          ))}
        </span>
        <span className="a-label">low → high</span>
      </div>
    </div>
  );
};

const Sessions = () => {
  const sessions = D.sessions || [];
  const [selectedId, setSelectedId] = useState(sessions[0] ? sessions[0].id : null);
  const [query, setQuery] = useState("");
  const selected = sessions.find((s) => s.id === selectedId) || sessions[0];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      (s.id || "").toLowerCase().includes(q) ||
      (s.project || "").toLowerCase().includes(q) ||
      (s.started || "").toLowerCase().includes(q)
    );
  }, [sessions, query]);
  const [turns, setTurns] = useState([]);
  useEffect(() => {
    if (!selected || !selected.fullId) { setTurns([]); return; }
    let cancelled = false;
    fetch("/api/sessions/" + encodeURIComponent(selected.fullId))
      .then((r) => r.ok ? r.json() : [])
      .then((rows) => {
        if (cancelled) return;
        const out = [];
        let cur = null;
        let totalBillable = 0;
        for (const m of rows || []) {
          if (m.is_sidechain) continue;
          if (m.type === "user") {
            if (cur) out.push(cur);
            cur = { n: out.length + 1, prompt: m.prompt_text || "", tokens: 0, tools: 0, billable: 0 };
          } else if (cur && m.type === "assistant") {
            const billable = (m.input_tokens || 0) + (m.output_tokens || 0)
              + (m.cache_create_5m_tokens || 0) + (m.cache_create_1h_tokens || 0);
            cur.tokens += billable + (m.cache_read_tokens || 0);
            cur.billable += billable;
            totalBillable += billable;
            try {
              const tc = m.tool_calls_json ? JSON.parse(m.tool_calls_json) : [];
              if (Array.isArray(tc)) cur.tools += tc.length;
            } catch (_) {}
          }
        }
        if (cur) out.push(cur);
        const sessCost = selected.cost || 0;
        for (const t of out) {
          t.cost = totalBillable > 0 ? sessCost * (t.billable / totalBillable) : 0;
        }
        setTurns(out);
      })
      .catch(() => { if (!cancelled) setTurns([]); });
    return () => { cancelled = true; };
  }, [selectedId]);
  if (!selected) {
    return <div className="a-route"><section className="a-card"><div className="muted">No sessions yet.</div></section></div>;
  }
  return (
    <div className="a-route">
      <section className="a-card" style={{ marginBottom: 12 }}>
        <div className="a-card-head">
          <h2>Activity heatmap</h2>
          <span className="a-card-meta">turns per hour · last 7 days · UTC</span>
        </div>
        <Heatmap />
      </section>
      <section className="a-card" style={{ marginBottom: 12 }}>
        <div className="a-card-head">
          <h2>Sessions</h2>
          <span className="a-card-meta" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search sessions…"
              className="a-search"
            />
            <span>{filtered.length}/{sessions.length}</span>
          </span>
        </div>
        <div className="a-scroll-5">
          <table className="a-table a-sticky-head">
            <thead>
              <tr>
                <th>session</th>
                <th>project</th>
                <th>started</th>
                <th className="num">turns</th>
                <th className="num">tokens</th>
                <th className="num">cost</th>
                <th style={{ paddingLeft: 16 }}>first prompt</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className={`clickable ${selectedId === s.id ? "is-active" : ""}`} onClick={() => setSelectedId(s.id)}>
                  <td className="mono" style={{ color: "var(--bone)" }}>{s.id}</td>
                  <td className="muted">{s.project}</td>
                  <td className="muted">{s.started}</td>
                  <td className="num">{s.turns}</td>
                  <td className="num">{fmtTokens(s.tokens)}</td>
                  <td className="num tone-good">{fmtCost(s.cost)}</td>
                  <td className="muted" style={{ paddingLeft: 16, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.firstPrompt || ""}>
                    {s.firstPrompt || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="a-card">
          <div className="a-card-head">
            <h2>{selected.id}</h2>
            <span className="a-card-meta">
              <ModelBadge model={selected.model} />
              <span style={{ marginLeft: 8 }}>{selected.project} · {selected.started} · {selected.turns} turns</span>
            </span>
          </div>
          <div className="a-kpi-row a-kpi-row-tight">
            <KPI label="tokens" value={fmtTokens(selected.tokens)} />
            <KPI label="cost" value={fmtCost(selected.cost)} tone="good" />
            <KPI label="turns" value={(selected.turns || 0).toString()} />
            <KPI label="avg / turn" value={fmtTokens(Math.floor((selected.tokens || 0) / Math.max(1, selected.turns)))} />
          </div>
          <div className="a-card-divider" />
          <Label>turn-by-turn</Label>
          <table className="a-table" style={{ marginTop: 8 }}>
            <thead>
              <tr><th className="num">#</th><th style={{ paddingLeft: 16 }}>prompt</th><th className="num">tokens</th><th className="num">tools</th><th className="num">cost</th><th style={{ paddingLeft: 16, width: 180 }}>distribution</th></tr>
            </thead>
            <tbody>
              {turns.map((t) => (
                <tr key={t.n}>
                  <td className="num mono">{t.n}</td>
                  <td style={{ paddingLeft: 16, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.prompt || ""}>
                    {(t.prompt || "—").replace(/\s+/g, " ").trim()}
                  </td>
                  <td className="num">{fmtTokens(t.tokens)}</td>
                  <td className="num">{t.tools}</td>
                  <td className="num tone-good">{fmtCost(t.cost)}</td>
                  <td style={{ width: 180, paddingLeft: 16 }}><HBar value={t.tokens} max={Math.max(1, ...turns.map(x => x.tokens))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
    </div>
  );
};

// -------- Token Sink (merged Projects + Skills) --------
const Work = () => {
  const [view, setView] = useState("projects");
  const rawRows = view === "projects" ? (D.projects || []) : (D.skills || []);
  const rows = [...rawRows].sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
  const max = Math.max(1, ...rows.map((r) => r.cost || 0));
  const total = rows.reduce((a, b) => a + (b.cost || 0), 0);
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head">
          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <h2>Token sink</h2>
            <div className="a-range" style={{ marginLeft: 4 }}>
              <button className={`a-range-tab ${view === "projects" ? "is-active" : ""}`} onClick={() => setView("projects")}>projects</button>
              <button className={`a-range-tab ${view === "skills" ? "is-active" : ""}`} onClick={() => setView("skills")}>skills</button>
            </div>
          </div>
          <span className="a-card-meta">{rows.length} {view} · {fmtCost(total)} {view === "projects" ? "all-time" : "attributed"}</span>
        </div>
        {view === "projects" ? (
          <table className="a-table">
            <thead><tr><th>project</th><th>last active</th><th className="num">sessions</th><th className="num">tokens</th><th className="num">cost</th><th>distribution</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.slug} className="clickable">
                  <td className="mono" style={{ color: "var(--bone)" }}>{p.name}</td>
                  <td className="muted">{p.lastActive}</td>
                  <td className="num">{p.sessions}</td>
                  <td className="num">{fmtTokens(p.tokens)}</td>
                  <td className="num tone-good">{fmtCost(p.cost)}</td>
                  <td style={{ width: 240 }}><HBar value={p.cost} max={max} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="a-table">
            <thead><tr><th>skill</th><th className="num">invocations</th><th className="num">tokens</th><th className="num">cost</th><th>distribution</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.name}>
                  <td className="mono" style={{ color: "var(--bone)" }}>{s.name}</td>
                  <td className="num">{s.invocations}</td>
                  <td className="num">{fmtTokens(s.tokens)}</td>
                  <td className="num tone-good">{fmtCost(s.cost)}</td>
                  <td style={{ width: 240 }}><HBar value={s.cost} max={max} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};

// -------- Tips --------
const TIP_CATEGORY_LABELS = {
  "cache": "Cache discipline",
  "repeat-file": "Repeated file reads",
  "repeat-bash": "Repeated bash commands",
  "right-size": "Right-sizing",
  "tool-bloat": "Tool-result bloat",
  "subagent-outlier": "Subagent outliers",
};

const TIP_MERGE_BODY = {
  "repeat-file": "These files were re-opened many times in the past 7 days. A summary in CLAUDE.md or one read per session would avoid repeats.",
  "repeat-bash": "These bash commands ran many times in the past 7 days. Consider a watch flag or shell alias.",
};

const buildTipPrompt = (t, projectKey) => {
  const proj = projectKey === "__global__" ? "" : ` (project: ${projectKey})`;
  switch (t.category) {
    case "cache":
      return `In ${projectKey}, our Claude Code cache hit rate is below 40% over the last 7 days, meaning we keep rebuilding context instead of reusing it. Investigate the project for patterns that thrash the prompt cache: frequent /clear, redundant CLAUDE.md edits, large rotating system blocks, or sessions that load big files near the start. Propose concrete changes (CLAUDE.md restructuring, hook adjustments, session habits) that would lift the hit rate. Ask before editing files.`;
    case "right-size":
      return `In ${projectKey}, many short Opus turns (output < 500 tokens) ran in the past 7 days and would have been much cheaper on Sonnet. Audit how Opus is invoked here — slash commands, agents, default model — and propose where to switch to Sonnet without hurting quality. List candidates explicitly. Ask before editing.`;
    case "tool-bloat":
      return `In ${projectKey}, several tool results exceeded 50k tokens in the past 7 days. Find which Bash/Read calls produce huge outputs and propose narrower alternatives (head/tail, ripgrep with file scope, targeted Read offsets, ctx_execute for analysis). Suggest hooks or CLAUDE.md guidance to prevent regressions. Ask before editing.`;
    case "subagent-outlier":
      return `Subagent ${t.title.match(/Subagent (\S+)/)?.[1] || ""}${proj} shows large outlier invocations vs its mean. Investigate what those outlier calls were doing (input size, prompts, tools used) and propose how to bound them — input trimming, tighter prompts, max-tokens, or splitting the work. Ask before editing.`;
    case "repeat-file":
      if (t._merged) {
        const list = t.rows.map((r) => `  - ${r}`).join("\n");
        return `In ${projectKey}, these files were re-opened many times in the past 7 days:\n${list}\n\nFor each, decide: (a) summarise in CLAUDE.md so Claude doesn't need to re-read, (b) split into smaller files, or (c) cache the relevant part inline. Propose a per-file plan, then wait for approval before editing.`;
      }
      return `In ${projectKey}, ${t.target || "this file"} was opened ${t.count} times in the past 7 days across ${t.sessions} sessions. Propose how to avoid the re-reads: a CLAUDE.md summary of the key facts, splitting the file, or caching its essence in a sibling note. Ask before editing.`;
    case "repeat-bash":
      if (t._merged) {
        const list = t.rows.map((r) => `  - ${r}`).join("\n");
        return `In ${projectKey}, these bash commands ran many times in the past 7 days:\n${list}\n\nFor each, propose a faster alternative: shell alias, npm/justfile script, --watch flag, or a hook that runs it automatically. Then suggest the smallest set of changes to set them up. Ask before editing.`;
      }
      return `In ${projectKey}, \`${t.target || ""}\` ran ${t.count} times in the past 7 days. Propose a faster way to invoke it (alias, watch flag, hook, or script) and the change required to set it up. Ask before editing.`;
    default:
      return `${t.title}\n\n${t.body}\n\nPropose a concrete fix${proj}. Ask before making changes.`;
  }
};

const copyToClipboard = async (text) => {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) {}
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) {}
  document.body.removeChild(ta);
  return ok;
};

const TipCard = ({ t, projectKey }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const prompt = buildTipPrompt(t, projectKey);
  return (
    <div className={`a-tip a-tip-${t.type}`}>
      <Label style={{ color: t.type === "warn" ? "var(--warn)" : t.type === "good" ? "var(--good)" : "var(--gull)" }}>
        {t.category ? (TIP_CATEGORY_LABELS[t.category] || t.type) : t.type}
      </Label>
      <h3>{t.title}</h3>
      <p>{t.body}</p>
      {t._merged && (
        <ul className="a-tip-list">
          {t.rows.map((r, j) => <li key={j}>{r}</li>)}
        </ul>
      )}
      <div className="a-tip-actions">
        <button className="a-tip-btn" onClick={() => setOpen(!open)}>{open ? "hide prompt" : "show prompt"}</button>
        <button className="a-tip-btn" onClick={async () => {
          const ok = await copyToClipboard(prompt);
          setCopied(ok); setTimeout(() => setCopied(false), 1500);
        }}>{copied ? "copied" : "copy prompt"}</button>
      </div>
      {open && <pre className="a-tip-prompt">{prompt}</pre>}
    </div>
  );
};

const mergeTipsByCategory = (tips, projectKey) => {
  const out = [];
  const buckets = {};
  tips.forEach((t) => {
    const cat = t.category;
    if (cat === "repeat-file" || cat === "repeat-bash") {
      (buckets[cat] = buckets[cat] || []).push(t);
    } else {
      out.push(t);
    }
  });
  Object.entries(buckets).forEach(([cat, list]) => {
    if (list.length === 1) { out.push(list[0]); return; }
    const slug = projectKey === "__global__" ? "(unknown project)" : projectKey;
    list.sort((a, b) => (b.count || 0) - (a.count || 0));
    out.push({
      _merged: true,
      type: list[0].type || "info",
      category: cat,
      title: cat === "repeat-file"
        ? `${list.length} files read repeatedly in ${slug}`
        : `${list.length} bash commands re-run in ${slug}`,
      body: TIP_MERGE_BODY[cat],
      rows: list.map((t) =>
        cat === "repeat-file"
          ? `${t.target} · ${t.count} reads${t.sessions ? ` across ${t.sessions} sessions` : ""}`
          : `${t.target} · ${t.count} runs`
      ),
    });
  });
  return out;
};

const Tips = () => {
  const groups = {};
  (D.tips || []).forEach((t) => {
    const k = t.project_slug || "__global__";
    (groups[k] = groups[k] || []).push(t);
  });
  const keys = Object.keys(groups).sort((a, b) => {
    if (a === "__global__") return 1;
    if (b === "__global__") return -1;
    return a.localeCompare(b);
  });
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head"><h2>Tips</h2><span className="a-card-meta">rule-based suggestions · no telemetry</span></div>
        {keys.map((k) => {
          const merged = mergeTipsByCategory(groups[k], k);
          return (
            <div key={k} className="a-tips-group">
              <div className="a-tips-group-head">
                <Label>{k === "__global__" ? "global" : k}</Label>
                <span className="a-card-meta">{merged.length} tip{merged.length === 1 ? "" : "s"}</span>
              </div>
              <div className="a-tips">
                {merged.map((t, i) => <TipCard key={i} t={t} projectKey={k} />)}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
};

// -------- Settings --------
const Settings = () => {
  const [plan, setPlan] = useState((D.plan && D.plan.id) || "max");
  const [saving, setSaving] = useState(false);
  const onPick = async (id) => {
    setPlan(id);
    setSaving(true);
    try {
      await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: id }) });
    } catch (_) {}
    setSaving(false);
  };
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head"><h2>Pricing plan</h2><span className="a-card-meta">{saving ? "saving…" : "drives all cost figures"}</span></div>
        <div className="a-plans">
          {[
            { id: "api", label: "API (pay-as-you-go)", note: "exact cost as the Anthropic API would bill" },
            { id: "pro", label: "Pro · $20/mo", note: "5x usage cap, Sonnet only" },
            { id: "max", label: "Max · $100/mo", note: "20x usage cap, Sonnet + Opus" },
            { id: "max20", label: "Max-20x · $200/mo", note: "100x usage cap, all models" },
          ].map((p) => (
            <label key={p.id} className={`a-plan ${plan === p.id ? "is-active" : ""}`}>
              <input type="radio" name="plan" checked={plan === p.id} onChange={() => onPick(p.id)} />
              <div>
                <div className="a-plan-title">{p.label}</div>
                <div className="a-plan-note">{p.note}</div>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="a-card">
        <div className="a-card-head"><h2>Pricing table</h2><span className="a-card-meta">USD per 1M tokens</span></div>
        <table className="a-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Cache 5m</th>
              <th className="num">Cache 1h</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries((D.plan && D.plan.pricing && D.plan.pricing.models) || {}).map(([id, r]) => (
              <tr key={id}>
                <td><span className={`a-badge badge-${r.tier}`}>{id}</span></td>
                <td className="num">${r.input.toFixed(2)}</td>
                <td className="num">${r.output.toFixed(2)}</td>
                <td className="num">${r.cache_read.toFixed(2)}</td>
                <td className="num">${r.cache_create_5m.toFixed(2)}</td>
                <td className="num">${r.cache_create_1h.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="a-card">
        <div className="a-card-head"><h2>Glossary</h2></div>
        <dl className="a-glossary">
          <dt>input tokens</dt>
          <dd>What you sent to the model — your prompt plus the conversation history. Billed at the lowest rate.</dd>
          <dt>output tokens</dt>
          <dd>What the model generated. Billed at roughly 5x the input rate.</dd>
          <dt>cache read</dt>
          <dd>Repeated input the API already has cached. Billed at 1/10th the input rate. Big <code>CLAUDE.md</code> files become almost free on repeat.</dd>
          <dt>cache write</dt>
          <dd>The first time a chunk of context is sent, it's cached for 5 minutes. Billed at 1.25x input.</dd>
        </dl>
      </section>
    </div>
  );
};

// -------- App shell --------
const ROUTES = { overview: Overview, prompts: Prompts, sessions: Sessions, "token sink": Work, tips: Tips, settings: Settings };

const THEMES = [
  { id: "bench",  label: "bench",  cls: "" },
  { id: "forge",  label: "forge",  cls: "theme-forge" },
  { id: "forest", label: "forest", cls: "theme-forest" },
  { id: "paper",  label: "paper",  cls: "theme-light" },
];
const THEME_KEY = "td.theme.v2";
const themeIndexFromStorage = () => {
  try {
    const id = localStorage.getItem(THEME_KEY);
    const i = THEMES.findIndex(t => t.id === id);
    return i >= 0 ? i : 0;
  } catch (_) { return 0; }
};
const applyThemeClass = (idx) => {
  const root = document.querySelector(".dir-a-root");
  if (!root) return;
  THEMES.forEach(t => { if (t.cls) root.classList.remove(t.cls); });
  const cls = THEMES[idx].cls;
  if (cls) root.classList.add(cls);
};

const tabFromHash = () => {
  const h = (window.location.hash || "").replace(/^#\/?/, "").toLowerCase();
  if (h === "tokensink" || h === "token-sink" || h === "work") return "token sink";
  return Object.keys(ROUTES).includes(h) ? h : "overview";
};

window.DirectionA = function DirectionA({ initialTab, lockTab = false }) {
  const [tab, setTab] = useState(initialTab || tabFromHash());
  const [range, setRange] = useState("30d");
  const [_, setNonce] = useState(0);
  useEffect(() => { if (lockTab && initialTab) setTab(initialTab); }, [initialTab, lockTab]);
  useEffect(() => {
    if (lockTab) return;
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [lockTab]);
  useEffect(() => {
    if (lockTab) return;
    const slug = tab === "token sink" ? "token-sink" : tab;
    if (`#/${slug}` !== window.location.hash) window.location.hash = `/${slug}`;
  }, [tab, lockTab]);
  const onRefresh = async () => {
    if (window.RELOAD_DATA) { await window.RELOAD_DATA(); setNonce(n => n + 1); }
  };
  const [themeIdx, setThemeIdx] = useState(themeIndexFromStorage);
  useEffect(() => {
    applyThemeClass(themeIdx);
    try { localStorage.setItem(THEME_KEY, THEMES[themeIdx].id); } catch (_) {}
  }, [themeIdx]);
  const onCycleTheme = () => setThemeIdx(i => (i + 1) % THEMES.length);
  const Route = ROUTES[tab] || Overview;
  return (
    <React.Fragment>
      <Topbar
        tab={tab} setTab={setTab} range={range} setRange={setRange}
        onRefresh={onRefresh}
        themeLabel={THEMES[themeIdx].label}
        onCycleTheme={onCycleTheme}
      />
      <main className="a-main-area">
        <Route />
      </main>
    </React.Fragment>
  );
};
})();

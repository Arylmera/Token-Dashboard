import React, { useEffect, useState } from "react";
import { fmtCost, fmtTokens } from "../format.js";
import { HBar, KPI, Label, ModelBadge } from "../components/atoms.jsx";
import { SortHeader, useSortable } from "../components/sortable.jsx";
import { displayProject } from "../project-name.js";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const todayUtc = () => {
  const n = new Date();
  return { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate() };
};
// Monday-first weekday index (0=Mon..6=Sun) for the 1st of the month.
const firstDowMonday = (y, m) => (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// Fetch the per-day cost series for a given month from /api/daily.
const useMonthSeries = (y, m) => {
  const [byDate, setByDate] = useState({});
  useEffect(() => {
    let cancelled = false;
    const since = new Date(Date.UTC(y, m, 1)).toISOString();
    const until = new Date(Date.UTC(y, m + 1, 1)).toISOString();
    const load = () =>
      fetch(`/api/daily?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows) => {
          if (cancelled) return;
          const map = {};
          for (const row of rows || []) map[row.day] = row;
          setByDate(map);
        })
        .catch(() => { if (!cancelled) setByDate({}); });
    load();
    const bump = () => load();
    window.addEventListener("td:data", bump);
    return () => { cancelled = true; window.removeEventListener("td:data", bump); };
  }, [y, m]);
  return byDate;
};

const MonthGrid = ({ y, m, byDate, selected, onPrev, onNext, onPick }) => {
  const maxCost = Math.max(0.000001, ...Object.values(byDate).map((r) => r.cost_usd || 0));
  const nDays = daysInMonth(y, m);
  const lead = firstDowMonday(y, m);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= nDays; d++) cells.push(d);
  const cellBg = (cost) =>
    cost > 0
      ? `color-mix(in oklab, var(--accent) ${Math.round((cost / maxCost) * 100)}%, transparent)`
      : "var(--panel-2)";
  return (
    <section className="a-card a-cal-card">
      <div className="a-card-head">
        <h2>Calendar</h2>
        <span className="a-cal-nav">
          <button className="a-pill-btn" onClick={onPrev} aria-label="Previous month">‹</button>
          <span className="a-cal-month">{MONTHS[m]} {y}</span>
          <button className="a-pill-btn" onClick={onNext} aria-label="Next month">›</button>
        </span>
      </div>
      <div className="a-cal-dow">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
      <div className="a-cal-grid">
        {cells.map((d, i) => {
          if (d == null) return <span key={`x${i}`} className="a-cal-cell is-empty" />;
          const date = ymd(y, m, d);
          const row = byDate[date];
          const cost = row ? (row.cost_usd || 0) : 0;
          return (
            <button
              key={date}
              className={`a-cal-cell ${selected === date ? "is-active" : ""}`}
              style={{ background: cellBg(cost) }}
              title={`${date} — ${fmtCost(cost)}`}
              onClick={() => onPick(date)}
            >
              <span className="a-cal-daynum">{d}</span>
              {cost > 0 && <span className="a-cal-daycost">{fmtCost(cost)}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
};

const useDayDetail = (date) => {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!date) { setData(null); return; }
    let cancelled = false;
    const load = () =>
      fetch(`/api/day?date=${encodeURIComponent(date)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled) setData(d); })
        .catch(() => { if (!cancelled) setData(null); });
    load();
    const bump = () => load();
    window.addEventListener("td:data", bump);
    return () => { cancelled = true; window.removeEventListener("td:data", bump); };
  }, [date]);
  return data;
};

const HourlyBars = ({ hourly }) => {
  const max = Math.max(0.000001, ...hourly.map((h) => h.cost || 0));
  return (
    <div className="a-cal-hours">
      {hourly.map((h) => (
        <div key={h.hour} className="a-cal-hour" title={`${pad2(h.hour)}:00 — ${fmtCost(h.cost)} · ${fmtTokens(h.tokens)} tok`}>
          <div
            className="a-cal-hour-bar"
            style={{
              height: `${Math.max(2, Math.round((h.cost / max) * 100))}%`,
              background: h.cost > 0
                ? `color-mix(in oklab, var(--accent) ${Math.round((h.cost / max) * 100)}%, transparent)`
                : "var(--panel-2)",
            }}
          />
        </div>
      ))}
      <div className="a-cal-hours-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    </div>
  );
};

const GroupList = ({ title, rows, labelOf, badge }) => {
  const max = Math.max(0.000001, ...rows.map((r) => r.cost || 0));
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>{title}</h2></div>
      <table className="a-table">
        <tbody>
          {rows.length === 0 && <tr><td className="muted">No activity.</td></tr>}
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{badge ? <ModelBadge model={r.key} /> : labelOf(r.key)}</td>
              <td className="num">{fmtTokens(r.tokens)}</td>
              <td className="num tone-good">{fmtCost(r.cost)}</td>
              <td style={{ width: 120 }}><HBar value={r.cost} max={max} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

const DaySessions = ({ sessions }) => {
  const { sorted, sortState, requestSort } = useSortable(sessions, null, "desc", {
    id: (r) => r.id,
    project: (r) => displayProject(r.project),
    started: (r) => r.started,
    turns: (r) => r.turns || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const hp = { state: sortState, requestSort };
  const go = (id) => { window.location.hash = `/sessions/${encodeURIComponent(id)}`; };
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Sessions</h2><span className="a-card-meta">{sessions.length}</span></div>
      <table className="a-table a-sticky-head">
        <thead>
          <tr>
            <SortHeader sortKey="id" {...hp}>session</SortHeader>
            <SortHeader sortKey="project" {...hp}>project</SortHeader>
            <SortHeader sortKey="started" {...hp}>started</SortHeader>
            <SortHeader sortKey="turns" className="num" {...hp}>turns</SortHeader>
            <SortHeader sortKey="tokens" className="num" {...hp}>tokens</SortHeader>
            <SortHeader sortKey="cost" className="num" {...hp}>cost</SortHeader>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.id} className="clickable" onClick={() => go(s.id)}>
              <td className="mono" style={{ color: "var(--bone)" }}>{s.id.slice(0, 8)}</td>
              <td className="muted" title={s.project}>{displayProject(s.project)}</td>
              <td className="muted">{(s.started || "").slice(11, 16)}</td>
              <td className="num">{s.turns}</td>
              <td className="num">{fmtTokens(s.tokens)}</td>
              <td className="num tone-good">{fmtCost(s.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

const DayDetail = ({ date, data }) => {
  if (!data) return <section className="a-card"><div className="muted">No data for {date}.</div></section>;
  const k = data.kpis || {};
  return (
    <>
      <section className="a-card">
        <div className="a-kpi-row a-kpi-row-tight">
          <KPI label="cost" value={fmtCost(k.cost_usd || 0)} tone="good" />
          <KPI label="tokens" value={fmtTokens((k.input_tokens || 0) + (k.output_tokens || 0) + (k.cache_create_tokens || 0))} />
          <KPI label="turns" value={String(k.turns || 0)} />
          <KPI label="sessions" value={String(k.sessions || 0)} />
        </div>
        <div className="a-card-divider" />
        <Label>hourly shape · UTC</Label>
        <HourlyBars hourly={data.hourly || []} />
      </section>
      <div className="a-cal-split">
        <GroupList title="By project" rows={data.by_project || []} labelOf={displayProject} />
        <GroupList title="By model" rows={data.by_model || []} badge />
      </div>
      <DaySessions sessions={data.sessions || []} />
    </>
  );
};

export const Calendar = () => {
  const t0 = todayUtc();
  const [view, setView] = useState({ y: t0.y, m: t0.m });
  const byDate = useMonthSeries(view.y, view.m);
  const [selected, setSelected] = useState(ymd(t0.y, t0.m, t0.d));
  const dayData = useDayDetail(selected);

  // When the month series lands, default-select the most recent day with data
  // (only if the current selection isn't in this month's data).
  useEffect(() => {
    const keys = Object.keys(byDate).sort();
    if (keys.length && !byDate[selected]) setSelected(keys[keys.length - 1]);
  }, [byDate]); // selected intentionally omitted: re-running on selected would loop (setSelected → selected change → effect)

  const prev = () => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
  const next = () => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));

  return (
    <div className="a-route">
      <MonthGrid
        y={view.y}
        m={view.m}
        byDate={byDate}
        selected={selected}
        onPrev={prev}
        onNext={next}
        onPick={setSelected}
      />
      {/* DayStrip added in Task 5 */}
      <DayDetail key={selected} date={selected} data={dayData} />
    </div>
  );
};

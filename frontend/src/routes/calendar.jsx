import React, { useEffect, useState } from "react";
import { fmtCost } from "../format.js";

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

export const Calendar = () => {
  const t0 = todayUtc();
  const [view, setView] = useState({ y: t0.y, m: t0.m });
  const byDate = useMonthSeries(view.y, view.m);
  const [selected, setSelected] = useState(ymd(t0.y, t0.m, t0.d));

  // When the month series lands, default-select the most recent day with data
  // (only if the current selection isn't in this month's data).
  useEffect(() => {
    const keys = Object.keys(byDate).sort();
    if (keys.length && !byDate[selected]) setSelected(keys[keys.length - 1]);
  }, [byDate]); // eslint-disable-line react-hooks/exhaustive-deps

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
      {/* DayStrip + DayDetail added in later tasks, keyed on `selected` */}
    </div>
  );
};

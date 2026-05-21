import React, { useEffect, useMemo, useState } from "react";
import { AreaChart } from "../../components/charts.jsx";
import { KPI } from "../../components/atoms.jsx";
import { fmtCost } from "../../format.js";

const WINDOWS = [7, 30, 60, 90];

function daysInCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

export function BurnRatePanel() {
  const [windowDays, setWindowDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setError(null);
    fetch(`/api/burn-rate?window_days=${windowDays}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then(setData)
      .catch((e) => {
        setError(e.message || "fetch failed");
        setData(null);
      });
  }, [windowDays]);

  const onPace = useMemo(() => {
    if (!data || data.monthly_budget_usd == null || data.monthly_budget_usd <= 0) return null;
    return data.monthly_budget_usd / daysInCurrentMonth();
  }, [data]);

  // Map burn-rate's daily_series to AreaChart's { date, cost } shape so we
  // reuse the exact chart component the Overview uses for Cache×cost — keeps
  // typography, gradient, hatch, and annotation behaviour in one place.
  const series = useMemo(() => {
    if (!data || !Array.isArray(data.daily_series)) return [];
    return data.daily_series.map((d) => ({
      date: (d.date || "").slice(5), // MM-DD for the annotation label
      cost: d.cost_usd || 0,
    }));
  }, [data]);

  if (error) {
    return (
      <section className="a-card">
        <div className="a-card-head"><h2>Burn rate</h2></div>
        <div className="a-hint">Failed to load: {error}</div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="a-card">
        <div className="a-card-head"><h2>Burn rate</h2></div>
        <div className="a-hint">Loading…</div>
      </section>
    );
  }

  const daysLeft = data.days_remaining;
  const tone =
    daysLeft == null ? "" : daysLeft < 3 ? "tone-bad" : daysLeft < 7 ? "tone-warn" : "tone-good";
  const exhaust = data.projected_exhaustion_date || "—";

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Burn rate</h2>
        <div className="a-window-switcher">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={w === windowDays ? "active" : ""}
              onClick={() => setWindowDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      <div className="a-kpi-row">
        <KPI label="avg / day" value={fmtCost(data.avg_daily_cost_usd || 0)} />
        <KPI
          label="days left"
          value={
            <span className={tone}>
              {daysLeft == null ? "—" : daysLeft < 1 ? "<1" : daysLeft.toFixed(1)}
            </span>
          }
        />
        <KPI label="hits zero" value={exhaust} />
        {onPace != null && <KPI label="on-pace" value={`${fmtCost(onPace)}/day`} />}
      </div>
      <AreaChart
        data={series}
        height={200}
        accent="var(--accent)"
        annotate
        guidelineY={onPace}
        guidelineLabel={onPace != null ? `on-pace ${fmtCost(onPace)}/day` : null}
      />
      {onPace == null && (
        <div className="a-hint">Set a monthly budget to see the on-pace guideline.</div>
      )}
    </section>
  );
}

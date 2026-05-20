import React, { useEffect, useMemo, useState } from "react";
import { fmtCost } from "../../format.js";

const WINDOWS = [7, 30, 60, 90];

function daysInCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

function PanelChart({ series, guideline }) {
  const W = 600;
  const H = 160;
  const PAD_L = 36;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  if (!series || series.length === 0) {
    return (
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="a-burn-chart">
        <text x={W / 2} y={H / 2} textAnchor="middle" className="a-chart-empty">
          no data
        </text>
      </svg>
    );
  }

  const max = Math.max(0.0001, guideline ?? 0, ...series.map((d) => d.cost_usd || 0));
  const n = series.length;
  const step = n > 1 ? innerW / (n - 1) : innerW;
  const yFor = (v) => PAD_T + innerH - (v / max) * innerH;
  const xFor = (i) => PAD_L + i * step;

  const linePath = series
    .map((d, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(2)},${yFor(d.cost_usd || 0).toFixed(2)}`)
    .join(" ");
  const areaPath =
    `M${xFor(0).toFixed(2)},${(PAD_T + innerH).toFixed(2)} ` +
    series.map((d, i) => `L${xFor(i).toFixed(2)},${yFor(d.cost_usd || 0).toFixed(2)}`).join(" ") +
    ` L${xFor(n - 1).toFixed(2)},${(PAD_T + innerH).toFixed(2)} Z`;

  const yTicks = 3;
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => (max * (yTicks - i)) / yTicks);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="a-burn-chart">
      <g className="a-chart-grid">
        {yTickVals.map((v, i) => {
          const y = yFor(v);
          return (
            <g key={i}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y.toFixed(2)}
                y2={y.toFixed(2)}
                className="a-chart-gridline"
              />
              <text x={PAD_L - 4} y={y + 3} textAnchor="end" className="a-chart-axislabel">
                ${v.toFixed(v >= 10 ? 0 : 1)}
              </text>
            </g>
          );
        })}
      </g>
      <path d={areaPath} className="a-burn-area" />
      <path d={linePath} className="a-burn-line" fill="none" />
      {guideline != null && guideline > 0 && (
        <g>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={yFor(guideline).toFixed(2)}
            y2={yFor(guideline).toFixed(2)}
            className="a-burn-guideline"
          />
          <text x={W - PAD_R - 4} y={yFor(guideline) - 4} textAnchor="end" className="a-burn-guideline-label">
            on-pace ${guideline.toFixed(2)}/day
          </text>
        </g>
      )}
    </svg>
  );
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

  if (error) {
    return (
      <section className="a-card">
        <div className="a-card-head">
          <h2>Burn rate</h2>
        </div>
        <div className="a-hint">Failed to load: {error}</div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="a-card">
        <div className="a-card-head">
          <h2>Burn rate</h2>
        </div>
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
        <div className="a-kpi">
          <div className="a-kpi-label">avg / day</div>
          <div className="a-kpi-value">{fmtCost(data.avg_daily_cost_usd || 0)}</div>
        </div>
        <div className="a-kpi">
          <div className="a-kpi-label">days left</div>
          <div className={`a-kpi-value ${tone}`}>
            {daysLeft == null ? "—" : daysLeft < 1 ? "<1" : daysLeft.toFixed(1)}
          </div>
        </div>
        <div className="a-kpi">
          <div className="a-kpi-label">hits zero</div>
          <div className="a-kpi-value">{exhaust}</div>
        </div>
        {onPace != null && (
          <div className="a-kpi">
            <div className="a-kpi-label">on-pace</div>
            <div className="a-kpi-value">{fmtCost(onPace)}/day</div>
          </div>
        )}
      </div>
      <PanelChart series={data.daily_series || []} guideline={onPace} />
      {onPace == null && (
        <div className="a-hint">Set a monthly budget to see the on-pace guideline.</div>
      )}
    </section>
  );
}

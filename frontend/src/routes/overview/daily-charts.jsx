import React from "react";
import { D } from "../../data-store.js";
import { fmtCost, fmtPct } from "../../format.js";
import { DualAreaChart } from "../../components/charts.jsx";

export const rangeDaysFromKey = (key) => {
  const k = String(key || "").toLowerCase();
  if (k === "all" || k === "alltime" || k === "all-time") return Infinity;
  if (k === "today" || k === "yesterday") return 1;
  const m = k.match(/^(\d+)\s*d/);
  if (m) return parseInt(m[1], 10);
  return 30;
};

const ChartAxis = ({ data, ticks = 7, insetLeft = 0, insetRight = 0 }) => {
  if (!data || data.length === 0) return null;
  const n = data.length;
  const count = Math.min(ticks, n);
  const idxs = count <= 1
    ? [0]
    : Array.from({ length: count }, (_, k) => Math.round((k * (n - 1)) / (count - 1)));
  const uniq = [...new Set(idxs)];
  return (
    <div className="a-chart-axis" style={{ paddingLeft: insetLeft, paddingRight: insetRight, position: "relative", height: 14 }}>
      {uniq.map((i, k) => {
        const pct = uniq.length === 1 ? 0 : (k / (uniq.length - 1)) * 100;
        const transform = k === 0 ? "translate(0, 0)" : (k === uniq.length - 1 ? "translate(-100%, 0)" : "translate(-50%, 0)");
        return (
          <span key={i} style={{
            position: "absolute",
            left: `calc(${insetLeft}px + (100% - ${insetLeft + insetRight}px) * ${pct / 100})`,
            top: 0, transform,
          }}>{data[i].date}</span>
        );
      })}
    </div>
  );
};

export const DailyCharts = ({ totals }) => {
  const rangeDays = rangeDaysFromKey(totals.rangeKey);
  // 1-day range collapses to a single daily bucket — fall back to the
  // 24-slot hourly series so the cache×cost overlay actually draws a
  // curve instead of a flat segment between two duplicated points.
  const useHourly = rangeDays === 1;
  const series = useHourly ? (D.hourlyDetail || []) : (D.daily || []);
  const total = series.reduce((a, b) => a + (Number(b.cost) || 0), 0);
  return (
    <section className="a-card-row">
      <div className="a-card" style={{ gridColumn: "1 / -1" }}>
        <div className="a-card-head">
          <h2>Cache &times; cost</h2>
          <div className="a-chart-legend">
            <span className="a-chart-legend-item"><span className="a-chart-legend-sw" style={{ background: "var(--accent)" }} /> cache reads · tokens</span>
            <span className="a-chart-legend-item"><span className="a-chart-legend-sw a-chart-legend-sw-dashed" /> cost · USD</span>
            <span className="a-card-meta" style={{ marginLeft: 8 }}>last {totals.rangeLabel || "30 days"} · {fmtCost(total)} total · {fmtPct(totals.cacheHitRate)} hit</span>
          </div>
        </div>
        <DualAreaChart data={series} height={220} accent="var(--accent)" />
        <ChartAxis data={series} ticks={useHourly ? 5 : 7} insetLeft={44} insetRight={52} />
      </div>
    </section>
  );
};
